import {
  hiddenList,
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
const MAX_TARGET_PAGES = 3;

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

  async function listTargets(): Promise<SourceTarget[]> {
    // Only live projects the token can browse; archived/sample projects that
    // the workspace hides by default stay discoverable via search in the UI.
    const hidden = hiddenList(env, "JIRA_HIDDEN_PROJECTS");
    const targets: SourceTarget[] = [];
    let startAt = 0;
    let pages = 0;
    for (;;) {
      const data = await api<{
        values?: { key?: string; name?: string; archived?: boolean }[];
        isLast?: boolean;
      }>(`/rest/api/3/project/search?maxResults=${PAGE_SIZE}&startAt=${startAt}&status=live`);
      for (const project of data.values ?? []) {
        if (typeof project.key !== "string") continue;
        if (project.archived === true) continue;
        targets.push({
          id: project.key,
          label: project.name ? `${project.key} · ${project.name}` : project.key,
          meta: { hidden: hidden.has(project.key.toLowerCase()) },
        });
      }
      pages += 1;
      const last = data.isLast === true || (data.values ?? []).length < PAGE_SIZE;
      if (last || pages >= MAX_TARGET_PAGES) break;
      startAt += PAGE_SIZE;
    }
    return targets;
  }

  async function pull(targetIds: string[], query?: string): Promise<SourcePullResult> {
    const files: SourceFile[] = [];
    const warnings: string[] = [];
    const explicitJql = query?.trim();

    // An empty selection means "everything you have access to": expand to all
    // non-hidden live projects before searching.
    const allTargets = targetIds.length > 0 ? null : await listTargets();
    const projectKeys =
      targetIds.length > 0
        ? targetIds
        : (allTargets ?? []).filter((target) => !target.meta?.hidden).map((target) => target.id);
    const targets: SourceTarget[] =
      allTargets?.filter((target) => projectKeys.includes(target.id)) ??
      projectKeys.map((key) => ({ id: key, label: key }));

    for (const projectKey of projectKeys) {
      const jql = explicitJql || `project = "${projectKey}" ORDER BY created ASC`;
      let pageToken: string | undefined;
      let pages = 0;
      let collected = 0;

      for (;;) {
        const params = new URLSearchParams({
          jql,
          maxResults: String(PAGE_SIZE),
          expand: "changelog",
          fields: "summary,created,reporter,assignee,comment",
        });
        if (pageToken) params.set("nextPageToken", pageToken);

        const data = await api<{
          issues?: JiraIssue[];
          isLast?: boolean;
          nextPageToken?: string;
        }>(`/rest/api/3/search/jql?${params.toString()}`);

        const issues = data.issues ?? [];
        if (issues.length > 0) {
          files.push({
            name: `jira/${projectKey.replace(/[^\w-]+/g, "_")}-page-${pages + 1}.json`,
            content: JSON.stringify({ issues }),
          });
          collected += issues.length;
        }

        pages += 1;
        const token = data.nextPageToken;
        const last = data.isLast === true || !token;
        if (last || pages >= MAX_PAGES_PER_PROJECT) {
          if (!last && token) {
            warnings.push(
              `Jira ${projectKey}: stopped after ${collected} issues (${MAX_PAGES_PER_PROJECT}-page budget). Narrow the JQL to see more.`,
            );
          }
          break;
        }
        pageToken = token;
      }

      if (collected === 0) {
        warnings.push(`Jira ${projectKey}: no issues matched.`);
      }
    }

    return { files, warnings, targets };
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

    listTargets,

    pull,
  };
}
