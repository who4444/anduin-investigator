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
  /** In-scope records available to the agents. */
  available: number;
  /** Records excluded from this investigation's scope. */
  excluded: number;
  /** The ids behind `excluded`, so the UI can list and inspect them. */
  excludedEventIds: string[];
  searched: boolean;
  queries: string[];
  /** Calls that were logged but returned errors instead of counts. */
  failedQueries: string[];
}

/* Coverage is three states, never two (G-02): "we searched and found it",
   "we searched and it is absent", and "we never looked (excluded)". Copy
   that collapses the last two into "no records" is a lie by omission. */
export type CoverageState = "searched" | "not-searched-excluded" | "not-searched";

export function coverageState(entry: SourceCoverage): CoverageState {
  if (entry.searched) return "searched";
  return entry.excluded > 0 ? "not-searched-excluded" : "not-searched";
}

export function coverageLabel(entry: SourceCoverage): string {
  switch (coverageState(entry)) {
    case "searched":
      return `${entry.queries.length} quer${entry.queries.length === 1 ? "y" : "ies"}`;
    case "not-searched-excluded":
      return `not searched · ${entry.excluded} excluded`;
    default:
      return entry.available > 0 ? "never searched" : "no data";
  }
}

export interface CoverageReport {
  sources: SourceCoverage[];
  neverSearched: SourceKind[];
}

interface ToolCallLogEntry {
  name?: unknown;
  args?: unknown;
  resultCount?: unknown;
}

interface StageLogEntry {
  name?: unknown;
  args?: unknown;
  resultCount?: unknown;
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

export function buildCoverage(
  events: Event[],
  stages: Stage[],
  inScopeEvents: Event[] = events,
): CoverageReport {
  // Availability is what the agents can actually see; exclusions are disclosed
  // so "jira · 2 items" never hides a bigger unscoped registry behind it.
  const totals = new Map<SourceKind, number>();
  for (const event of events) {
    totals.set(event.source, (totals.get(event.source) ?? 0) + 1);
  }
  const inScope = new Map<SourceKind, number>();
  const inScopeIds = new Set<string>();
  for (const event of inScopeEvents) {
    inScope.set(event.source, (inScope.get(event.source) ?? 0) + 1);
    inScopeIds.add(event.id);
  }

  const searched = new Map<SourceKind, string[]>();
  const failed = new Map<SourceKind, string[]>();

  const record = (entry: ToolCallLogEntry) => {
    if (typeof entry?.name !== "string") return;
    const source = TOOL_TO_SOURCE[entry.name];
    if (!source) return;
    const args =
      typeof entry.args === "object" && entry.args !== null
        ? (entry.args as Record<string, unknown>)
        : {};
    const label = formatQuery(entry.name, args);
    // The tool loop logs a parsed result count for every call that returned
    // counts ({count: N}); calls whose result was an error carry none.
    const outcomeFailed = typeof entry.resultCount !== "number";
    const target = outcomeFailed ? failed : searched;
    const list = target.get(source) ?? [];
    if (!list.includes(label)) list.push(label);
    target.set(source, list);
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

  const sources: SourceCoverage[] = SOURCES.map((source) => {
    const total = totals.get(source) ?? 0;
    const available = inScope.get(source) ?? 0;
    const excludedEventIds = events
      .filter((event) => event.source === source && !inScopeIds.has(event.id))
      .map((event) => event.id);
    return {
      source,
      available,
      excluded: total - available,
      excludedEventIds,
      searched: searched.has(source),
      queries: searched.get(source) ?? [],
      failedQueries: failed.get(source) ?? [],
    };
  });

  const neverSearched = sources
    .filter((entry) => entry.available > 0 && !entry.searched)
    .map((entry) => entry.source);

  return { sources, neverSearched };
}
