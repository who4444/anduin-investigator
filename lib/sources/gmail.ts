import {
  cleanQuery,
  missingEnvKeys,
  type SourceDefinition,
  type SourceEnv,
  type SourceFile,
  type SourcePullResult,
  type SourceTarget,
} from "./types";

const ENV_KEYS = ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"];
const LIST_PAGE_SIZE = 100;
const MAX_MESSAGES_DEFAULT = 200;
const MESSAGES_PER_MBOX = 100;
const FETCH_CONCURRENCY = 8;

export interface GmailSourceOptions {
  fetchImpl?: typeof fetch;
  env?: SourceEnv;
}

interface TokenCache {
  key: string;
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

function escapeMboxFromLines(raw: string): string {
  return raw.replace(/^From /gm, ">From ");
}

export function createGmailSource(options: GmailSourceOptions = {}): SourceDefinition {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function accessToken(): Promise<string> {
    const cacheKey = `${env.GMAIL_CLIENT_ID}:${env.GMAIL_REFRESH_TOKEN}`;
    if (tokenCache && tokenCache.key === cacheKey && tokenCache.expiresAt > Date.now()) {
      return tokenCache.token;
    }

    const response = await fetchImpl("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: env.GMAIL_CLIENT_ID ?? "",
        client_secret: env.GMAIL_CLIENT_SECRET ?? "",
        refresh_token: env.GMAIL_REFRESH_TOKEN ?? "",
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(
        "Gmail refused the refresh token. Re-mint GMAIL_REFRESH_TOKEN (scope gmail.readonly).",
      );
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error("Gmail token response contained no access_token.");
    }

    tokenCache = {
      key: cacheKey,
      token: payload.access_token,
      expiresAt: Date.now() + Math.max(60, (payload.expires_in ?? 3600) - 300) * 1000,
    };
    return payload.access_token;
  }

  async function gmail<T>(path: string, token: string): Promise<T> {
    const response = await fetchImpl(`https://gmail.googleapis.com/gmail/v1/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (response.status === 401) {
      throw new Error("Gmail rejected the access token. Re-mint GMAIL_REFRESH_TOKEN.");
    }
    if (response.status === 403) {
      throw new Error("Gmail access denied — the refresh token needs the gmail.readonly scope.");
    }
    if (!response.ok) {
      throw new Error(`Gmail request failed (HTTP ${response.status}).`);
    }
    return (await response.json()) as T;
  }

  return {
    id: "gmail",
    label: "Gmail",
    envKeys: ENV_KEYS,

    isConfigured() {
      return missingEnvKeys(env, ENV_KEYS).length === 0;
    },

    missingEnv() {
      return missingEnvKeys(env, ENV_KEYS);
    },

    async listTargets(query?: string): Promise<SourceTarget[]> {
      const effective = cleanQuery(query) ?? cleanQuery(env.GMAIL_QUERY);
      return [
        {
          id: "search",
          label: effective ? `Gmail search: ${effective}` : "Gmail search (set GMAIL_QUERY or type one)",
        },
      ];
    },

    async pull(_targetIds: string[], query?: string): Promise<SourcePullResult> {
      const effective = cleanQuery(query) ?? cleanQuery(env.GMAIL_QUERY);
      if (!effective) {
        throw new Error(
          "Provide a Gmail search query (for example: label:support newer_than:90d).",
        );
      }

      const maxMessages = Number.parseInt(env.GMAIL_MAX_MESSAGES ?? "", 10);
      const cap = Number.isFinite(maxMessages) && maxMessages > 0 ? Math.min(maxMessages, 500) : MAX_MESSAGES_DEFAULT;

      const token = await accessToken();
      const warnings: string[] = [];
      const ids: string[] = [];

      let pageToken: string | undefined;
      let pages = 0;
      do {
        const params = new URLSearchParams({ q: effective, maxResults: String(LIST_PAGE_SIZE) });
        if (pageToken) params.set("pageToken", pageToken);

        const listing = await gmail<{ messages?: { id?: string }[]; nextPageToken?: string }>(
          `users/me/messages?${params.toString()}`,
          token,
        );
        for (const message of listing.messages ?? []) {
          if (typeof message.id === "string" && ids.length < cap) ids.push(message.id);
        }
        pageToken = listing.nextPageToken;
        pages += 1;
      } while (pageToken && ids.length < cap && pages < 10);

      if (ids.length >= cap) {
        warnings.push(`Gmail: only the newest ${cap} matching messages were pulled.`);
      }

      if (ids.length === 0) {
        return {
          files: [],
          warnings: [`Gmail: no messages matched "${effective}".`],
          targets: [{ id: "search", label: `mail: ${effective}` }],
        };
      }

      const rawMessages: string[] = [];
      let cursor = 0;
      let skipped = 0;

      async function worker(): Promise<void> {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const id = ids[index];
          if (!id) return;
          try {
            const message = await gmail<{ raw?: string }>(`users/me/messages/${id}?format=raw`, token);
            if (typeof message.raw === "string" && message.raw.length > 0) {
              rawMessages[index] = Buffer.from(message.raw, "base64url").toString("utf8");
            } else {
              skipped += 1;
            }
          } catch {
            skipped += 1;
          }
        }
      }

      await Promise.all(
        Array.from({ length: Math.min(FETCH_CONCURRENCY, ids.length) }, () => worker()),
      );

      if (skipped > 0) warnings.push(`Gmail: ${skipped} message(s) could not be downloaded and were skipped.`);

      const usable = rawMessages.filter((message): message is string => typeof message === "string");
      if (usable.length === 0) {
        return { files: [], warnings: [...warnings, "Gmail: no readable messages were returned."] };
      }

      const files: SourceFile[] = [];
      for (let index = 0; index < usable.length; index += MESSAGES_PER_MBOX) {
        const chunk = usable.slice(index, index + MESSAGES_PER_MBOX);
        const mbox = chunk
          .map((raw) => `From gmail-pull@localhost Thu Jan  1 00:00:00 1970\n${escapeMboxFromLines(raw)}\n\n`)
          .join("");
        files.push({
          name: `gmail/messages-${Math.floor(index / MESSAGES_PER_MBOX) + 1}.mbox`,
          content: mbox,
        });
      }

      return { files, warnings, targets: [{ id: "search", label: `mail: ${effective}` }] };
    },
  };
}
