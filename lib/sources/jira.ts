import {
  missingEnvKeys,
  stripTrailingSlashes,
  type SourceDefinition,
  type SourceEnv,
  type SourceFile,
  type SourcePullResult,
  type SourceTarget,
} from "./types";

const ENV_KEYS = ["JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN"];
const PAGE_SIZE = 50;
const MAX_PAGES_PER_PROJECT = 4;

export interface JiraSourceOptions {
  fetchImpl?: typeof fetch;
  env?: SourceEnv;
}

interface JiraIssue {
  key?: string;
}

function baseUrl(env: SourceEnv): string {
  const raw = stripTrailingSlashes((env.JIRA_SITE ?? "").trim());
  const host = raw.includes(".") ? raw.replace(/^https?:\/\//, "") : `${raw}.atlassian.net`;
  return `https://${host}`;
}

function authHeader(env: SourceEnv): string {
  const credentials = `${env.JIRA_EMAIL ?? ""}:${env.JIRA_API_TOKEN ?? ""}`;
  return `Basic ${Buffer.from(credentials, "utf8").toString("base64")}`;
}

export function createJiraSource(options: JiraSourceOptions = {}): SourceDefinition {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function api<T>(path: string): Promise<T> {
    const response = await fetchImpl(`${baseUrl(env)}${path}`, {
      headers: { Authorization: authHeader(env), Accept: "application/json" },
    });
    if (!response.ok) {
      const hint =
        response.status === 401 || response.status === 403
          ? " Check JIRA_EMAIL and JIRA_API_TOKEN."
          : " Check JIRA_SITE.";
      throw new Error(`Jira request failed (HTTP ${response.status}).${hint}`);
    }
    return (await response.json()) as T;
  }

  return {
    id: "jira",
    label: "Jira Cloud",
    envKeys: ENV_KEYS,

    isConfigured() {
      return missingEnvKeys(env, ENV_KEYS).length === 0;
    },

    missingEnv() {
      return missingEnvKeys(env, ENV_KEYS);
    },

    async listTargets(): Promise<SourceTarget[]> {
      const data = await api<{ values?: { key?: string; name?: string }[] }>(
        `/rest/api/3/project/search?maxResults=${PAGE_SIZE}&startAt=0`,
      );
      return (data.values ?? [])
        .filter((project): project is { key: string; name?: string } => typeof project.key === "string")
        .map((project) => ({
          id: project.key,
          label: project.name ? `${project.key} · ${project.name}` : project.key,
        }));
    },

    async pull(targetIds: string[], query?: string): Promise<SourcePullResult> {
      const files: SourceFile[] = [];
      const warnings: string[] = [];
      const explicitJql = query?.trim();

      for (const projectKey of targetIds) {
        const jql = explicitJql || `project = "${projectKey}" ORDER BY created ASC`;
        let startAt = 0;
        let pages = 0;
        let collected = 0;

        for (;;) {
          const params = new URLSearchParams({
            jql,
            startAt: String(startAt),
            maxResults: String(PAGE_SIZE),
            expand: "changelog",
            fields: "summary,created,reporter,assignee,comment",
          });
          const data = await api<{ issues?: JiraIssue[]; isLast?: boolean; total?: number }>(
            `/rest/api/2/search?${params.toString()}`,
          );

          const issues = data.issues ?? [];
          if (issues.length > 0) {
            files.push({
              name: `jira/${projectKey.replace(/[^\w-]+/g, "_")}-${startAt}.json`,
              content: JSON.stringify({ issues }),
            });
            collected += issues.length;
          }

          pages += 1;
          const last = data.isLast ?? issues.length < PAGE_SIZE;
          if (last || pages >= MAX_PAGES_PER_PROJECT) {
            if (!last) {
              warnings.push(
                `Jira ${projectKey}: stopped after ${collected} issues (${MAX_PAGES_PER_PROJECT}-page budget). Narrow the JQL to see more.`,
              );
            }
            break;
          }
          startAt += PAGE_SIZE;
        }

        if (collected === 0) {
          warnings.push(`Jira ${projectKey}: no issues matched.`);
        }
      }

      return { files, warnings };
    },
  };
}
