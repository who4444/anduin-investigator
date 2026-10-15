import { createGmailSource } from "./gmail";
import { createJiraSource } from "./jira";
import { createSlackSource } from "./slack";
import type { SourceDefinition } from "./types";

const sources: SourceDefinition[] = [createJiraSource(), createSlackSource(), createGmailSource()];
let override: SourceDefinition[] | null = null;

export function getSources(): SourceDefinition[] {
  return override ?? sources;
}

export function getSource(id: string): SourceDefinition | undefined {
  return getSources().find((source) => source.id === id);
}

export function setSourcesForTests(next: SourceDefinition[] | null): void {
  override = next;
}
