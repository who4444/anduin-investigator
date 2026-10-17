import { asNumber, asString } from "../json";
import { toUtcIso } from "../ingest/normalize";
import type { ToolSpec } from "../llm";
import { splitEventsByScope } from "../pipeline/scope";
import { getClaims, getEvents, getInvestigation, insertClaims } from "../store";
import type { ClaimInput, ClaimStatus, Event, InvestigationScope, SourceKind } from "../types";
import { verifyQuote } from "../verify";
import { rankEvents } from "./ranking";
import { compactEvent } from "./summary";

const MAX_SEARCH_RESULTS = 30;
const FULL_TEXT = 100_000;

const CLAIM_STATUSES: ClaimStatus[] = ["kept", "broken", "unclear", "n/a"];

export interface AgentTools {
  specs: ToolSpec[];
  exec(name: string, args: Record<string, unknown>): Promise<string>;
}

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolSpec {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required } },
  };
}

function toolSpecs(): ToolSpec[] {
  return [
    tool(
      "search_jira",
      "Search the stored Jira items (summaries, comments, status and assignee transitions). Optionally bound by an ISO date range.",
      {
        query: { type: "string", description: "Text to look for (issue key, wording, person)." },
        from: { type: "string", description: "Inclusive lower bound, ISO timestamp." },
        to: { type: "string", description: "Inclusive upper bound, ISO timestamp." },
      },
      ["query"],
    ),
    tool(
      "get_issue",
      "Read one Jira issue in order: its creation, every comment, and every status/assignee transition.",
      { key: { type: "string", description: "Issue key, e.g. PROJ-123." } },
      ["key"],
    ),
    tool(
      "search_slack",
      "Search the stored Slack messages, optionally restricted to one channel and/or a date range.",
      {
        query: { type: "string", description: "Text to look for. Leave empty to list recent messages." },
        channel: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
    ),
    tool(
      "get_slack_thread",
      "Read a Slack thread: the opening message and its replies, by channel and the thread's opening ts.",
      {
        channel: { type: "string", description: "Channel name, e.g. meridian-billing." },
        ts: { type: "string", description: "The thread's opening timestamp." },
      },
      ["channel", "ts"],
    ),
    tool(
      "search_email",
      "Search the stored email messages, optionally from one sender and/or within a date range.",
      {
        query: { type: "string", description: "Text to look for. Leave empty to list recent messages." },
        sender: { type: "string", description: "Match the sender name or address." },
        from: { type: "string" },
        to: { type: "string" },
      },
    ),
    tool(
      "get_email_thread",
      "Read an email thread by any message id in it.",
      { id: { type: "string", description: "A Message-ID from the thread." } },
      ["id"],
    ),
    tool(
      "verify_quote",
      "Check whether a quote appears verbatim (whitespace-normalized) in the given item. Always verify before submitting a claim.",
      {
        item_id: { type: "string", description: "The item id from a search or read result." },
        quote: { type: "string", description: "Exact substring copied from the item text." },
      },
      ["item_id", "quote"],
    ),
    tool(
      "submit_claim",
      "Record one verified finding. The quote MUST be an exact substring of the cited item's text.",
      {
        type: {
          type: "string",
          description: "root_cause | commitment | decision | process_failure | ownership",
        },
        text: { type: "string", description: "One sentence stating the finding." },
        actor: { type: "string" },
        quote: { type: "string" },
        item_id: { type: "string" },
        ts: { type: "string" },
        status: { type: "string", enum: CLAIM_STATUSES },
        confidence: { type: "number", description: "0-1." },
      },
      ["type", "text", "quote", "item_id", "status", "confidence"],
    ),
  ];
}

/* A date-only bound means the whole calendar day, not midnight-exact —
   "2026-09-24" as `to` must include events later that day. Bounds written
   without milliseconds (or with offsets) compare numerically, since a
   lexicographic compare would drop events at exactly the boundary. */
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function compareTs(left: string, bound: string): number {
  const leftMs = Date.parse(left);
  const boundMs = Date.parse(bound);
  if (Number.isFinite(leftMs) && Number.isFinite(boundMs)) {
    return leftMs === boundMs ? 0 : leftMs < boundMs ? -1 : 1;
  }
  return left === bound ? 0 : left < bound ? -1 : 1;
}

function matchesWindow(event: Event, from?: string, to?: string): boolean {
  if (from) {
    if (DAY_ONLY.test(from)) {
      if (event.ts.slice(0, 10) < from) return false;
    } else if (compareTs(event.ts, from) < 0) return false;
  }
  if (to) {
    if (DAY_ONLY.test(to)) {
      if (event.ts.slice(0, 10) > to) return false;
    } else if (compareTs(event.ts, to) > 0) return false;
  }
  return true;
}

function matchesQuery(event: Event, needle: string | undefined): boolean {
  if (!needle) return true;
  const lower = needle.toLowerCase();
  return (
    event.text.toLowerCase().includes(lower) ||
    event.channel.toLowerCase().includes(lower) ||
    (event.actorResolved ?? event.actor).toLowerCase().includes(lower) ||
    (event.refs ?? []).some((ref) => ref.toLowerCase().includes(lower))
  );
}

/* Search results are relevance-ordered (see ranking.ts), then capped; the
   count and truncated flag describe the full match set, not the slice. */
function searchResult(
  matches: Event[],
  query: string | undefined,
): { count: number; items: Record<string, unknown>[]; truncated: boolean } {
  // A ranked query orders by relevance; a bare listing shows the most
  // recent records first (the tools describe this as listing recent).
  const ordered = query && query.trim() ? rankEvents(matches, query) : [...matches].reverse();
  return {
    count: matches.length,
    items: ordered.slice(0, MAX_SEARCH_RESULTS).map((event) => compactEvent(event) as unknown as Record<string, unknown>),
    truncated: ordered.length > MAX_SEARCH_RESULTS,
  };
}

function normalizeThreadRef(id: string): string {
  return id.replace(/^</, "").replace(/>$/, "");
}

/* Read tools return full text per item; without a total budget a single long
   issue or thread can overflow the model context and kill the run. */
const MAX_READ_ITEMS = 40;
const MAX_READ_CHARS = 24_000;

function readCapped(events: Event[]): { items: Record<string, unknown>[]; truncated: boolean } {
  const items: Record<string, unknown>[] = [];
  let used = 0;
  let truncated = false;
  for (const event of events) {
    if (items.length >= MAX_READ_ITEMS) {
      truncated = true;
      break;
    }
    const item = compactEvent(event, FULL_TEXT) as unknown as Record<string, unknown>;
    const size = JSON.stringify(item).length;
    if (items.length > 0 && used + size > MAX_READ_CHARS) {
      truncated = true;
      break;
    }
    items.push(item);
    used += size;
  }
  return { items, truncated };
}

function claimFromArgs(args: Record<string, unknown>): { claim?: ClaimInput; error?: string } {
  const type = asString(args.type);
  const text = asString(args.text);
  const quote = asString(args.quote);
  const eventId = asString(args.item_id) ?? asString(args.event_id);
  const status = asString(args.status);
  const confidence = asNumber(args.confidence);
  const tsRaw = asString(args.ts);
  const ts = tsRaw ? toUtcIso(tsRaw) : undefined;

  if (!type || !text || !quote || !eventId) {
    return { error: "type, text, quote, and item_id are required." };
  }
  if (!status || !CLAIM_STATUSES.includes(status as ClaimStatus)) {
    return { error: `status must be one of ${CLAIM_STATUSES.join(", ")}.` };
  }
  if (confidence === undefined) {
    return { error: "confidence must be a number between 0 and 1." };
  }
  if (tsRaw && !ts) {
    return {
      error:
        "ts must be an ISO 8601 timestamp with an explicit UTC offset (or a date-only YYYY-MM-DD); use the item's own timestamp.",
    };
  }

  return {
    claim: {
      agent: "unknown",
      type,
      text,
      actor: asString(args.actor),
      quote,
      eventId,
      ts,
      status: status as ClaimStatus,
      confidence: Math.min(1, Math.max(0, confidence)),
    },
  };
}

export function buildAgentTools(investigationId: string, agentName: string): AgentTools {
  // The registry may hold records for several clients and projects; when a
  // scope has been identified for this escalation, the tools only surface
  // records inside it (thread-aware, matching the report).
  async function sourceItems(source: SourceKind): Promise<Event[]> {
    const [events, investigation] = await Promise.all([
      getEvents(investigationId),
      getInvestigation(investigationId),
    ]);
    const scope: InvestigationScope | null = investigation?.scope ?? null;
    const { inScope } = splitEventsByScope(events, scope);
    return inScope.filter((event) => event.source === source);
  }

  async function exec(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "search_jira": {
        const query = asString(args.query);
        const from = asString(args.from);
        const to = asString(args.to);
        const matches = (await sourceItems("jira")).filter(
          (event) => matchesQuery(event, query) && matchesWindow(event, from, to),
        );
        return JSON.stringify(searchResult(matches, query));
      }

      case "get_issue": {
        const key = asString(args.key);
        if (!key) return JSON.stringify({ error: "key is required." });
        const needle = key.toLowerCase();
        const items = (await sourceItems("jira")).filter(
          (event) => event.channel.toLowerCase() === needle,
        );
        if (items.length === 0) {
          const investigation = await getInvestigation(investigationId);
          const scope = investigation?.scope ?? null;
          if (
            scope &&
            scope.confidence !== "none" &&
            !scope.ticketPrefixes.some((prefix) =>
              key.toUpperCase().startsWith(`${prefix.toUpperCase()}-`),
            )
          ) {
            return JSON.stringify({
              error: `No stored issue ${key} — it belongs to a different client or project than this investigation's scope.`,
            });
          }
          return JSON.stringify({ error: `No stored issue ${key}.` });
        }
        return JSON.stringify({ count: items.length, ...readCapped(items) });
      }

      case "search_slack": {
        const query = asString(args.query);
        const channel = asString(args.channel);
        const from = asString(args.from);
        const to = asString(args.to);
        const matches = (await sourceItems("slack")).filter((event) => {
          if (channel && event.channel.toLowerCase() !== channel.toLowerCase()) return false;
          return matchesQuery(event, query) && matchesWindow(event, from, to);
        });
        return JSON.stringify(searchResult(matches, query));
      }

      case "get_slack_thread": {
        const channel = asString(args.channel);
        const ts = asString(args.ts);
        if (!channel || !ts) return JSON.stringify({ error: "channel and ts are required." });
        const threadId = `slack:${channel}:${ts}`;
        const slack = await sourceItems("slack");
        let items = slack.filter((event) => event.threadId === threadId);
        if (items.length === 0 && /^\d+(\.\d+)?$/.test(ts)) {
          const day = new Date(Number(ts) * 1000).toISOString().slice(0, 10);
          items = slack.filter(
            (event) => event.channel.toLowerCase() === channel.toLowerCase() && event.ts.startsWith(day),
          );
        }
        if (items.length === 0) return JSON.stringify({ error: `No stored thread ${threadId}.` });
        return JSON.stringify({ count: items.length, ...readCapped(items) });
      }

      case "search_email": {
        const query = asString(args.query);
        const sender = asString(args.sender);
        const from = asString(args.from);
        const to = asString(args.to);
        const matches = (await sourceItems("email")).filter((event) => {
          if (sender) {
            const haystack = `${event.actor} ${event.actorResolved ?? ""}`.toLowerCase();
            if (!haystack.includes(sender.toLowerCase())) return false;
          }
          return matchesQuery(event, query) && matchesWindow(event, from, to);
        });
        return JSON.stringify(searchResult(matches, query));
      }

      case "get_email_thread": {
        const id = asString(args.id);
        if (!id) return JSON.stringify({ error: "id is required." });
        const email = await sourceItems("email");
        const byItem = email.find((event) => event.id === id);
        const needle = normalizeThreadRef(byItem?.threadId ?? id);
        let items = email.filter((event) => event.threadId === needle);
        if (items.length === 0) items = email.filter((event) => event.threadId?.includes(needle));
        if (items.length === 0) return JSON.stringify({ error: `No stored thread for ${id}.` });
        return JSON.stringify({ count: items.length, ...readCapped(items) });
      }

      case "verify_quote": {
        const itemId = asString(args.item_id) ?? asString(args.event_id);
        const quote = asString(args.quote);
        if (!itemId || quote === undefined) {
          return JSON.stringify({ error: "item_id and quote are required." });
        }
        const events = await getEvents(investigationId);
        const event = events.find((candidate) => candidate.id === itemId);
        if (!event) return JSON.stringify({ ok: false, error: "item_not_found" });
        return JSON.stringify(verifyQuote(event.text, quote));
      }

      case "submit_claim": {
        const { claim, error } = claimFromArgs(args);
        if (!claim) return JSON.stringify({ error });

        const normalizedText = claim.text.toLowerCase().replace(/\s+/g, " ").trim();
        const existing = await getClaims(investigationId);
        const duplicate = existing.find(
          (stored) =>
            stored.agent === agentName &&
            stored.type === claim.type &&
            stored.eventId === claim.eventId &&
            stored.text.toLowerCase().replace(/\s+/g, " ").trim() === normalizedText,
        );
        if (duplicate) return JSON.stringify({ claimId: duplicate.id, duplicate: true });

        const inserted = await insertClaims(investigationId, [{ ...claim, agent: agentName }]);
        const stored = inserted[0];
        if (stored) return JSON.stringify({ claimId: stored.id });

        // Lost an insert race against a concurrent run — report the winner.
        const refreshed = await getClaims(investigationId);
        const winner = refreshed.find(
          (candidate) =>
            candidate.eventId === claim.eventId &&
            candidate.text.toLowerCase().replace(/\s+/g, " ").trim() === normalizedText,
        );
        if (winner) return JSON.stringify({ claimId: winner.id, duplicate: true });
        return JSON.stringify({ error: "claim could not be stored." });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return { specs: toolSpecs(), exec };
}
