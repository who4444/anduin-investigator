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
  /** The largest result count a search on this source returned. */
  resultCount: number;
  /** Calls that were logged but returned errors instead of counts. */
  failedQueries: string[];
  /** I2/F1: the honest five-state summary for this source (filled by buildCoverage). */
  state?: CoverageState;
}

/* Coverage states, never collapsed (G-02, F1): "we searched and found it",
   "we searched and found nothing", "we never looked (excluded)",
   "we never looked (available)", and "the source was not part of the
   export". Copy that turns an unavailable source into an absence claim
   is a lie. */
export type CoverageState =
  | "not-in-export"
  | "available-not-searched"
  | "searched-with-results"
  | "searched-empty"
  | "not-searched-excluded";

export function coverageState(entry: SourceCoverage): CoverageState {
  if (entry.available === 0 && entry.excluded === 0) return "not-in-export";
  if (entry.searched) {
    return entry.queries.some((q) => q !== "" && entryHasResults(entry)) ? "searched-with-results" : "searched-empty";
  }
  return entry.excluded > 0 ? "not-searched-excluded" : "available-not-searched";
}

function entryHasResults(entry: SourceCoverage): boolean {
  return entry.resultCount > 0;
}

export function coverageLabel(entry: SourceCoverage): string {
  switch (coverageState(entry)) {
    case "searched-with-results":
      return `${entry.queries.length} quer${entry.queries.length === 1 ? "y" : "ies"}`;
    case "searched-empty":
      return `searched · no matches (${entry.queries.length} quer${entry.queries.length === 1 ? "y" : "ies"})`;
    case "not-in-export":
      return "not part of this export";
    case "not-searched-excluded":
      return `not searched · ${entry.excluded} excluded`;
    default:
      return "never searched";
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
  status?: unknown;
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
  const resultCounts = new Map<SourceKind, number>();

  const record = (entry: ToolCallLogEntry) => {
    if (typeof entry?.name !== "string") return;
    const source = TOOL_TO_SOURCE[entry.name];
    if (!source) return;
    const args =
      typeof entry.args === "object" && entry.args !== null
        ? (entry.args as Record<string, unknown>)
        : {};
    const label = formatQuery(entry.name, args);
    const status = typeof entry.status === "string" ? entry.status : undefined;
    // The tool loop logs a parsed result count for every call that returned
    // counts ({count: N}); calls whose result was an error carry none.
    const outcomeFailed = typeof entry.resultCount !== "number";
    if (!outcomeFailed && typeof entry.resultCount === "number") {
      resultCounts.set(source, Math.max(resultCounts.get(source) ?? 0, entry.resultCount));
    }
    // I2: an absent source or a scope-excluded read examined no in-scope
    // records — it is not a search and never yields an absence claim.
    const blocked = status === "not_in_export" || status === "excluded_by_scope";
    const target = outcomeFailed || blocked ? failed : searched;
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
      resultCount: resultCounts.get(source) ?? 0,
      failedQueries: failed.get(source) ?? [],
      state: "not-in-export",
    };
  });

  for (const entry of sources) {
    entry.state = coverageState(entry);
  }

  const neverSearched = sources
    .filter((entry) => entry.available > 0 && !entry.searched)
    .map((entry) => entry.source);

  return { sources, neverSearched };
}
