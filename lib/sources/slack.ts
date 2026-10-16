import {
  missingEnvKeys,
  type SourceDefinition,
  type SourceEnv,
  type SourceFile,
  type SourcePullResult,
  type SourceTarget,
} from "./types";

const ENV_KEYS = ["SLACK_TOKEN"];
const MAX_CHANNELS_PER_PULL = 10;
const MAX_MESSAGES_PER_CHANNEL = 600;
const MAX_REPLY_FETCHES = 25;
const PAGE_LIMIT = 200;

const REQUIRED_SCOPES =
  "channels:history, groups:history, im:history, mpim:history, channels:read, groups:read, users:read";

export interface SlackSourceOptions {
  fetchImpl?: typeof fetch;
  env?: SourceEnv;
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  needed?: string;
  [key: string]: unknown;
}

function slackError(method: string, payload: SlackResponse): Error {
  const code = payload.error ?? "unknown_error";
  if (code === "invalid_auth" || code === "not_authed" || code === "token_revoked") {
    return new Error(`Slack rejected the token (${code}). Check SLACK_TOKEN.`);
  }
  if (code === "missing_scope") {
    const needed = payload.needed ? ` (needed: ${payload.needed})` : "";
    return new Error(`Slack token is missing scopes${needed}. Required: ${REQUIRED_SCOPES}.`);
  }
  return new Error(`Slack ${method} failed: ${code}.`);
}

export function createSlackSource(options: SlackSourceOptions = {}): SourceDefinition {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function api<T extends SlackResponse>(method: string, params: Record<string, string> = {}): Promise<T> {
    const response = await fetchImpl(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.SLACK_TOKEN ?? ""}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params).toString(),
    });
    if (!response.ok) {
      throw new Error(`Slack ${method} failed (HTTP ${response.status}). Check SLACK_TOKEN.`);
    }
    const payload = (await response.json()) as T;
    if (!payload.ok) throw slackError(method, payload);
    return payload;
  }

  function safeChannelName(name: string, fallback: string): string {
    const cleaned = name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "");
    return cleaned.length > 0 ? cleaned : fallback;
  }

  return {
    id: "slack",
    label: "Slack",
    envKeys: ENV_KEYS,

    isConfigured() {
      return missingEnvKeys(env, ENV_KEYS).length === 0;
    },

    missingEnv() {
      return missingEnvKeys(env, ENV_KEYS);
    },

    async listTargets(): Promise<SourceTarget[]> {
      const targets: SourceTarget[] = [];
      let cursor: string | undefined;
      let pages = 0;

      do {
        const params: Record<string, string> = {
          types: "public_channel,private_channel",
          exclude_archived: "true",
          limit: String(PAGE_LIMIT),
        };
        if (cursor) params.cursor = cursor;

        const payload = await api<SlackResponse & { channels?: { id?: string; name?: string }[] }>(
          "conversations.list",
          params,
        );
        for (const channel of payload.channels ?? []) {
          if (typeof channel.id === "string") {
            targets.push({ id: channel.id, label: channel.name ? `#${channel.name}` : channel.id });
          }
        }
        cursor = typeof payload.response_metadata === "object" && payload.response_metadata !== null
          ? ((payload.response_metadata as { next_cursor?: string }).next_cursor || undefined)
          : undefined;
        pages += 1;
      } while (cursor && pages < 5);

      return targets;
    },

    async pull(targetIds: string[]): Promise<SourcePullResult> {
      const selected = targetIds.slice(0, MAX_CHANNELS_PER_PULL);
      const warnings: string[] = [];
      const files: SourceFile[] = [];

      if (targetIds.length > selected.length) {
        warnings.push(`Slack: only the first ${MAX_CHANNELS_PER_PULL} selected channels were pulled.`);
      }

      const users: Record<string, { name?: string; real_name?: string; profile?: { real_name?: string } }> = {};
      let userCursor: string | undefined;
      let userPages = 0;
      do {
        const params: Record<string, string> = { limit: String(PAGE_LIMIT) };
        if (userCursor) params.cursor = userCursor;
        const payload = await api<
          SlackResponse & {
            members?: { id?: string; name?: string; real_name?: string; profile?: { real_name?: string } }[];
          }
        >("users.list", params);
        for (const member of payload.members ?? []) {
          if (typeof member.id === "string") users[member.id] = member;
        }
        userCursor = extractCursor(payload);
        userPages += 1;
      } while (userCursor && userPages < 10);

      files.push({ name: "slack/users.json", content: JSON.stringify(users) });

      const channelIndex: { id: string; name: string }[] = [];

      for (const channelId of selected) {
        const info = await api<SlackResponse & { channel?: { id?: string; name?: string } }>(
          "conversations.info",
          { channel: channelId },
        );
        const name = safeChannelName(info.channel?.name ?? "", channelId);
        channelIndex.push({ id: channelId, name });

        const messages: unknown[] = [];
        let cursor: string | undefined;
        let pages = 0;
        let truncated = false;

        do {
          const params: Record<string, string> = { channel: channelId, limit: String(PAGE_LIMIT) };
          if (cursor) params.cursor = cursor;
          const payload = await api<SlackResponse & { messages?: unknown[] }>("conversations.history", params);
          for (const message of payload.messages ?? []) {
            if (messages.length >= MAX_MESSAGES_PER_CHANNEL) {
              truncated = true;
              break;
            }
            messages.push(message);
          }
          cursor = extractCursor(payload);
          pages += 1;
        } while (cursor && !truncated && pages < 5);

        if (truncated || (cursor && pages >= 5)) {
          warnings.push(
            `Slack #${name}: pulled the newest ${messages.length} messages only (budget reached).`,
          );
        }

        // conversations.history returns parents only; thread replies arrive via conversations.replies.
        const parents = messages
          .filter(
            (message): message is { ts: string } =>
              typeof message === "object" &&
              message !== null &&
              typeof (message as { ts?: unknown }).ts === "string" &&
              typeof (message as { reply_count?: unknown }).reply_count === "number" &&
              ((message as { reply_count: number }).reply_count ?? 0) > 0,
          )
          .slice(0, MAX_REPLY_FETCHES);

        for (const parent of parents) {
          if (messages.length >= MAX_MESSAGES_PER_CHANNEL) {
            truncated = true;
            break;
          }
          let repliesPayload: SlackResponse & { messages?: unknown[] };
          try {
            repliesPayload = await api<SlackResponse & { messages?: unknown[] }>("conversations.replies", {
              channel: channelId,
              ts: parent.ts,
              limit: String(PAGE_LIMIT),
            });
          } catch {
            warnings.push(`Slack #${name}: could not read the thread starting at ${parent.ts}.`);
            continue;
          }

          for (const reply of repliesPayload.messages ?? []) {
            const replyTs = typeof reply === "object" && reply !== null ? (reply as { ts?: unknown }).ts : undefined;
            if (typeof replyTs !== "string") continue;
            if (messages.some((existing) => (existing as { ts?: unknown }).ts === replyTs)) continue;
            if (messages.length >= MAX_MESSAGES_PER_CHANNEL) {
              truncated = true;
              break;
            }
            messages.push(reply);
          }
        }

        if (parents.length === MAX_REPLY_FETCHES) {
          warnings.push(`Slack #${name}: only the first ${MAX_REPLY_FETCHES} threads were expanded.`);
        }

        if (messages.length > 0) {
          files.push({ name: `slack/${name}/messages.json`, content: JSON.stringify(messages) });
        } else {
          warnings.push(`Slack #${name}: no messages found.`);
        }
      }

      files.push({ name: "slack/channels.json", content: JSON.stringify(channelIndex) });

      return { files, warnings };
    },
  };
}

function extractCursor(payload: SlackResponse): string | undefined {
  const metadata = payload.response_metadata;
  if (typeof metadata === "object" && metadata !== null) {
    const next = (metadata as { next_cursor?: string }).next_cursor;
    if (typeof next === "string" && next.length > 0) return next;
  }
  return undefined;
}
