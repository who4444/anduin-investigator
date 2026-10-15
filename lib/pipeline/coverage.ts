import type { Event, SourceKind, Stage } from "../types";

const SOURCES: SourceKind[] = ["jira", "email", "slack"];

const TOOL_TO_SOURCE: Record<string, SourceKind> = {
  search_jira: "jira",
  get_issue: "jira",
  search_slack: "slack",
  get_slack_thread: "slack",
  search_email: "email",
  get_email_thread: "email",
};

export interface SourceCoverage {
  source: SourceKind;
  available: number;
  searched: boolean;
  queries: string[];
}

export interface CoverageReport {
  sources: SourceCoverage[];
  neverSearched: SourceKind[];
}

interface ToolCallLogEntry {
  name?: unknown;
  args?: unknown;
}

interface StageLogEntry {
  name?: unknown;
  args?: unknown;
  toolCalls?: unknown;
}

function formatQuery(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "search_jira":
    case "search_slack":
    case "search_email": {
      const query = typeof args.query === "string" && args.query.trim() ? args.query.trim() : null;
      if (query) return `${name}("${query}")`;
      const scope =
        typeof args.channel === "string"
          ? args.channel
          : typeof args.sender === "string"
            ? args.sender
            : "all";
      return `${name}(${scope})`;
    }
    case "get_issue":
      return `get_issue(${typeof args.key === "string" ? args.key : "?"})`;
    case "get_slack_thread":
      return `get_slack_thread(${typeof args.channel === "string" ? args.channel : "?"})`;
    case "get_email_thread":
      return `get_email_thread(${typeof args.id === "string" ? args.id : "?"})`;
    default:
      return name;
  }
}

export function buildCoverage(events: Event[], stages: Stage[]): CoverageReport {
  const available = new Map<SourceKind, number>();
  for (const event of events) {
    available.set(event.source, (available.get(event.source) ?? 0) + 1);
  }

  const searched = new Map<SourceKind, string[]>();

  const record = (entry: ToolCallLogEntry) => {
    if (typeof entry?.name !== "string") return;
    const source = TOOL_TO_SOURCE[entry.name];
    if (!source) return;
    const args =
      typeof entry.args === "object" && entry.args !== null
        ? (entry.args as Record<string, unknown>)
        : {};
    const queries = searched.get(source) ?? [];
    const label = formatQuery(entry.name, args);
    if (!queries.includes(label)) queries.push(label);
    searched.set(source, queries);
  };

  for (const stage of stages) {
    if (stage.stage !== "root_cause" && stage.stage !== "commitments" && stage.stage !== "ownership") {
      continue;
    }
    for (const raw of stage.log) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as StageLogEntry;
      record(entry);
      if (Array.isArray(entry.toolCalls)) {
        for (const nested of entry.toolCalls) {
          if (typeof nested === "object" && nested !== null) record(nested as ToolCallLogEntry);
        }
      }
    }
  }

  const sources: SourceCoverage[] = SOURCES.map((source) => ({
    source,
    available: available.get(source) ?? 0,
    searched: searched.has(source),
    queries: searched.get(source) ?? [],
  }));

  const neverSearched = sources
    .filter((entry) => entry.available > 0 && !entry.searched)
    .map((entry) => entry.source);

  return { sources, neverSearched };
}
