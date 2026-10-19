export interface SourceFile {
  name: string;
  content: string;
}

export interface SourceTarget {
  id: string;
  label: string;
  description?: string;
  /** Display/selection metadata. `hidden` targets are workspace-configured
      (env hide lists) to stay out of the default list; searching reveals them.
      `isMember` marks Slack channels the bot can actually read. */
  meta?: { hidden?: boolean; isMember?: boolean };
}

export interface SourcePullResult {
  files: SourceFile[];
  warnings: string[];
  /** The targets that were actually pulled (id + label), after any
      "everything accessible" expansion. Used for the scope review labels. */
  targets?: SourceTarget[];
}

export interface SourceDefinition {
  id: "jira" | "slack" | "gmail";
  label: string;
  envKeys: string[];
  isConfigured(): boolean;
  missingEnv(): string[];
  listTargets(query?: string): Promise<SourceTarget[]>;
  pull(targetIds: string[], query?: string): Promise<SourcePullResult>;
}

export type SourceEnv = Record<string, string | undefined>;

/** Comma-separated env hide list ("social,all-anduin") as a lowercase set.
    Inline "# comments" inside quoted values are tolerated and stripped. */
export function hiddenList(env: SourceEnv, key: string): Set<string> {
  return new Set(
    (env[key] ?? "")
      .split(",")
      .map((entry) => entry.replace(/#.*$/, "").trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Gmail queries tolerate a trailing " # comment" in .env; strip it. */
export function cleanQuery(value: string | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/\s+#.*$/, "").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function missingEnvKeys(env: SourceEnv, keys: string[]): string[] {
  return keys.filter((key) => {
    const value = env[key];
    return !value || value.trim().length === 0;
  });
}

export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
