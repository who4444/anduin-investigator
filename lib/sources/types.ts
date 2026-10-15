export interface SourceFile {
  name: string;
  content: string;
}

export interface SourceTarget {
  id: string;
  label: string;
  description?: string;
}

export interface SourcePullResult {
  files: SourceFile[];
  warnings: string[];
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

export function missingEnvKeys(env: SourceEnv, keys: string[]): string[] {
  return keys.filter((key) => {
    const value = env[key];
    return !value || value.trim().length === 0;
  });
}

export function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}
