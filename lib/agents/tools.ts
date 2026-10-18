import { asNumber, asString } from "../json";
import { toUtcIso } from "../ingest/normalize";
import type { ToolSpec } from "../llm";
import { applyStatusRules, commitmentDedupeKey, isPromiseLike } from "../pipeline/commitments";
import { splitEventsByScope } from "../pipeline/scope";
import { resolveIssueId } from "../pipeline/issues";
import { extractDeadline } from "../report/build";
import {
  getClaims,
  getEvents,
  getIssues,
  getInvestigation,
  insertClaims,
  mergeCommitment,
} from "../store";
import type {
  ClaimInput,
  ClaimStatus,
  CommitmentStatus,
  Event,
  InvestigationScope,
  SourceKind,
} from "../types";
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
        issue_id: {
          type: "string",
          description:
            "The issue this finding belongs to, copied from the issue_id list in the prompt. Required when the escalation has more than one issue.",
        },
      },
      ["type", "text", "quote", "item_id", "status", "confidence"],
    ),
    tool(
      "submit_commitment",
      "Record one PROMISE as a structured commitment (use this instead of submit_claim for promises). It also stores the backing claim. The quote MUST be an exact substring of the cited item's text.",
      {
        text: { type: "string", description: "One sentence stating the promise." },
        actor: { type: "string", description: "The promisor: who promised." },
        to: { type: "string", description: "The promisee: who it was promised to, when the record states it." },
        object: {
          type: "string",
          description: "What exactly was promised, in a short phrase with no dates, e.g. 'invoice totals corrected'.",
        },
        conditions: { type: "string", description: "Any condition attached to the promise." },
        deadline: {
          type: "string",
          description: "The deadline exactly as stated in the record, e.g. 'Sep 24'. Omit when none was stated.",
        },
        quote: { type: "string" },
        item_id: { type: "string" },
        ts: { type: "string" },
        status: {
          type: "string",
          enum: ["kept", "broken", "unclear"],
          description: "kept needs a delivering record in fulfilment_item_ids; otherwise unclear.",
        },
        rationale: { type: "string", description: "Why this status, in one sentence." },
        fulfilment_item_ids: {
          type: "array",
          items: { type: "string" },
          description: "Record ids that show the promise was delivered (required for kept).",
        },
        confidence: { type: "number", description: "0-1." },
        issue_id: {
          type: "string",
          description:
            "The issue this promise belongs to, copied from the issue_id list in the prompt. Required when the escalation has more than one issue.",
        },
      },
      ["text", "quote", "item_id", "object", "status", "confidence"],
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
   count and truncated flag describe the full match set, not the slice.
   I2: every result carries a structured status so absence is never faked —
   "not in this export", "excluded by scope" and "searched, no matches" are
   different answers. */
export type ToolStatus = "ok" | "not_in_export" | "excluded_by_scope" | "empty" | "failed";

interface Split {
  all: Event[];
  inScope: Event[];
}

function searchStatus(split: Split, matches: Event[]): ToolStatus {
  if (split.all.length === 0) return "not_in_export";
  if (split.inScope.length === 0) return "excluded_by_scope";
  return matches.length === 0 ? "empty" : "ok";
}

function searchResult(
  split: Split,
  matches: Event[],
  query: string | undefined,
): { status: ToolStatus; count: number; items: Record<string, unknown>[]; truncated: boolean } {
  // A ranked query orders by relevance; a bare listing shows the most
  // recent records first (the tools describe this as listing recent).
  const ordered = query && query.trim() ? rankEvents(matches, query) : [...matches].reverse();
  return {
    status: searchStatus(split, matches),
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

/** I1: the claim contract at the submission boundary. Returns the rejection
    reason when the claim asserts more than its quote states, or null when it
    passes. Shared by the tool loop and the transcript parser. */
export function claimContractViolation(text: string, quote: string): string | null {
  const conclusionWords = [...new Set(
    [...text.matchAll(
      /\b(proves?|proved|cause[ds]?|causes|attributes?|attributed|means|therefore|before|after|earlier|later|unanswered|never)\b/gi,
    )].map((match) => match[0].toLowerCase()),
  )];
  const quoteLower = quote.toLowerCase();
  const unsupported = conclusionWords.filter((word) => !quoteLower.includes(word));
  if (unsupported.length > 0) {
    return `This claim asserts more than its quote states (${unsupported.slice(0, 3).join(", ")}). Submit the OBSERVATION the quote supports as its own claim, or put the inference in a note — unless the quoted text itself states it.`;
  }
  const negativeClaim = /\b(no reply|no response|went unanswered|unanswered|never)\b/i.test(text);
  const completeness =
    /(records? (were |are |was )?searched|in the records|no record (of|shows|is|exists)|no stored|nothing (in|stored)|this export)/i;
  if (negativeClaim && !completeness.test(text) && !completeness.test(quote)) {
    return "A negative claim ('no reply', 'never happened') must say where it was searched — e.g. 'no reply in the records searched' — or cite a record that states the absence. Otherwise put it in notes.";
  }
  return null;
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

  const contractViolation = claimContractViolation(text, quote);
  if (contractViolation) return { error: contractViolation };

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
      issueId: asString(args.issue_id) ?? null,
    },
  };
}

export function buildAgentTools(investigationId: string, agentName: string): AgentTools {
  // The registry may hold records for several clients and projects; when a
  // scope has been identified for this escalation, the tools only surface
  // records inside it (thread-aware, matching the report).
  // I2: availability is checked against the full registry, not just the scope,
  // so a key that exists but was scoped away gets a different answer than a
  // key that is not in the export at all.
  async function sourceSplit(source: SourceKind): Promise<Split> {
    const [events, investigation] = await Promise.all([
      getEvents(investigationId),
      getInvestigation(investigationId),
    ]);
    const scope: InvestigationScope | null = investigation?.scope ?? null;
    const { inScope } = splitEventsByScope(events, scope, investigation?.scopeOverrides ?? []);
    return {
      all: events.filter((event) => event.source === source),
      inScope: inScope.filter((event) => event.source === source),
    };
  }

  async function exec(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "search_jira": {
        const query = asString(args.query);
        const from = asString(args.from);
        const to = asString(args.to);
        const split = await sourceSplit("jira");
        const matches = split.inScope.filter(
          (event) => matchesQuery(event, query) && matchesWindow(event, from, to),
        );
        return JSON.stringify(searchResult(split, matches, query));
      }

      case "get_issue": {
        const key = asString(args.key);
        if (!key) return JSON.stringify({ error: "key is required." });
        const needle = key.toLowerCase();
        const split = await sourceSplit("jira");
        if (split.all.length === 0) {
          return JSON.stringify({
            status: "not_in_export",
            count: 0,
            items: [],
            error: `The Jira source was not part of this export; no stored issue ${key}. No conclusion can be drawn from its absence.`,
          });
        }
        const items = split.inScope.filter((event) => event.channel.toLowerCase() === needle);
        if (items.length === 0) {
          // Full-registry check BEFORE the scope filter (I2): an excluded key
          // is an add-back, an absent key is simply not in this export.
          const inRegistry = split.all.filter((event) => event.channel.toLowerCase() === needle);
          if (inRegistry.length > 0) {
            return JSON.stringify({
              status: "excluded_by_scope",
              count: 0,
              items: [],
              error: `Issue ${key} exists in the registry but is excluded by this investigation's scope — the manager can add it back in the scope review.`,
            });
          }
          const investigation = await getInvestigation(investigationId);
          const scope = investigation?.scope ?? null;
          const scopedProject = Boolean(
            scope &&
              scope.confidence !== "none" &&
              !scope.ticketPrefixes.some((prefix) =>
                key.toUpperCase().startsWith(`${prefix.toUpperCase()}-`),
              ),
          );
          return JSON.stringify({
            status: "not_in_export",
            count: 0,
            items: [],
            error: scopedProject
              ? `No stored issue ${key} — it is not in this export, and its project is outside this investigation's scope. Treat it as referenced but not available.`
              : `No stored issue ${key} — it is not in this export. Treat it as referenced but not available.`,
          });
        }
        return JSON.stringify({ status: "ok", count: items.length, ...readCapped(items) });
      }

      case "search_slack": {
        const query = asString(args.query);
        const channel = asString(args.channel);
        const from = asString(args.from);
        const to = asString(args.to);
        const split = await sourceSplit("slack");
        const matches = split.inScope.filter((event) => {
          if (channel && event.channel.toLowerCase() !== channel.toLowerCase()) return false;
          return matchesQuery(event, query) && matchesWindow(event, from, to);
        });
        return JSON.stringify(searchResult(split, matches, query));
      }

      case "get_slack_thread": {
        const channel = asString(args.channel);
        const ts = asString(args.ts);
        if (!channel) return JSON.stringify({ error: "channel is required." });
        const split = await sourceSplit("slack");
        if (split.all.length === 0) {
          return JSON.stringify({
            status: "not_in_export",
            count: 0,
            items: [],
            error: `The Slack source was not part of this export; no stored messages for ${channel}. No conclusion can be drawn from its absence.`,
          });
        }
        const slack = split.inScope;
        const channelItems = slack.filter(
          (event) => event.channel.toLowerCase() === channel.toLowerCase(),
        );
        if (channelItems.length === 0) {
          const inRegistry = split.all.filter(
            (event) => event.channel.toLowerCase() === channel.toLowerCase(),
          );
          return inRegistry.length > 0
            ? JSON.stringify({
                status: "excluded_by_scope",
                count: 0,
                items: [],
                error: `Channel ${channel} exists in the registry but is excluded by this investigation's scope — the manager can add it back in the scope review.`,
              })
            : JSON.stringify({
                status: "not_in_export",
                count: 0,
                items: [],
                error: `Channel ${channel} is not in this export.`,
              });
        }
        // Models reach this tool with whatever a record showed: a Slack epoch,
        // an ISO timestamp, or an item id. Resolve all of them to a thread;
        // never fail when the channel has stored messages.
        const resolveThreadId = (): string | null => {
          if (!ts) return null;
          if (ts.startsWith("slack:")) return ts;
          if (/^\d+(\.\d+)?$/.test(ts)) return `slack:${channel}:${ts}`;
          const byId = channelItems.find((event) => event.id === ts);
          if (byId?.threadId) return byId.threadId;
          const byIso = channelItems.find((event) => event.ts === ts);
          if (byIso?.threadId) return byIso.threadId;
          return null;
        };
        const threadId = resolveThreadId();
        let items = threadId ? slack.filter((event) => event.threadId === threadId) : [];
        if (items.length === 0) {
          const day = /^\d+(\.\d+)?$/.test(ts ?? "")
            ? new Date(Number(ts) * 1000).toISOString().slice(0, 10)
            : ts?.slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/)
              ? ts.slice(0, 10)
              : null;
          if (day) items = channelItems.filter((event) => event.ts.startsWith(day));
        }
        if (items.length === 0) {
          return JSON.stringify({
            status: "ok",
            count: channelItems.length,
            note: ts
              ? `No stored thread matched ts "${ts}"; returning the stored messages for ${channel}.`
              : `No thread ts was given; returning the stored messages for ${channel}.`,
            ...readCapped(channelItems),
          });
        }
        return JSON.stringify({ status: "ok", count: items.length, ...readCapped(items) });
      }

      case "search_email": {
        const query = asString(args.query);
        const sender = asString(args.sender);
        const from = asString(args.from);
        const to = asString(args.to);
        const split = await sourceSplit("email");
        const matches = split.inScope.filter((event) => {
          if (sender) {
            const haystack = `${event.actor} ${event.actorResolved ?? ""}`.toLowerCase();
            if (!haystack.includes(sender.toLowerCase())) return false;
          }
          return matchesQuery(event, query) && matchesWindow(event, from, to);
        });
        return JSON.stringify(searchResult(split, matches, query));
      }

      case "get_email_thread": {
        const id = asString(args.id);
        if (!id) return JSON.stringify({ error: "id is required." });
        const split = await sourceSplit("email");
        if (split.all.length === 0) {
          return JSON.stringify({
            status: "not_in_export",
            count: 0,
            items: [],
            error: `The email source was not part of this export; no stored thread for ${id}. No conclusion can be drawn from its absence.`,
          });
        }
        const email = split.inScope;
        const byItem = email.find((event) => event.id === id);
        const needle = normalizeThreadRef(byItem?.threadId ?? id);
        let items = email.filter((event) => event.threadId === needle);
        if (items.length === 0) items = email.filter((event) => event.threadId?.includes(needle));
        if (items.length === 0)
          return JSON.stringify({ status: "empty", count: 0, items: [], error: `No stored thread for ${id}.` });
        return JSON.stringify({ status: "ok", count: items.length, ...readCapped(items) });
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
        // C2: promises go through the structured path so the ledger can
        // merge restatements and compute the outcome in code.
        if (claim.type === "commitment") {
          return JSON.stringify({
            error:
              "Promises must be recorded with submit_commitment (promisor, promisee, object, deadline, status) so the ledger can decide the outcome. Re-submit this promise there; it also stores the backing claim.",
          });
        }

        const issues = await getIssues(investigationId);
        const issueId = resolveIssueId(args.issue_id, claim.text, issues);

        const normalizedText = claim.text.toLowerCase().replace(/\s+/g, " ").trim();
        const existing = await getClaims(investigationId);
        const duplicate = existing.find(
          (stored) =>
            stored.agent === agentName &&
            stored.type === claim.type &&
            stored.eventId === claim.eventId &&
            stored.text.toLowerCase().replace(/\s+/g, " ").trim() === normalizedText,
        );
        if (duplicate) return JSON.stringify({ claimId: duplicate.id, duplicate: true, issueId: duplicate.issueId ?? null });

        const inserted = await insertClaims(investigationId, [{ ...claim, agent: agentName, issueId }]);
        const stored = inserted[0];
        if (stored) return JSON.stringify({ claimId: stored.id, issueId: stored.issueId ?? null });

        // Lost an insert race against a concurrent run — report the winner.
        const refreshed = await getClaims(investigationId);
        const winner = refreshed.find(
          (candidate) =>
            candidate.eventId === claim.eventId &&
            candidate.text.toLowerCase().replace(/\s+/g, " ").trim() === normalizedText,
        );
        if (winner) return JSON.stringify({ claimId: winner.id, duplicate: true, issueId: winner.issueId ?? null });
        return JSON.stringify({ error: "claim could not be stored." });
      }

      case "submit_commitment": {
        const { claim, error } = claimFromArgs({ ...args, type: "commitment" });
        if (!claim) return JSON.stringify({ error });
        const object = asString(args.object)?.trim();
        if (!object) {
          return JSON.stringify({ error: "object is required: state what was promised, without dates." });
        }

        const issues = await getIssues(investigationId);
        const issueId = resolveIssueId(args.issue_id, claim.text, issues);

        // Same claim guard as submit_claim: a restatement is one claim.
        const normalizedText = claim.text.toLowerCase().replace(/\s+/g, " ").trim();
        const existingClaims = await getClaims(investigationId);
        const duplicate = existingClaims.find(
          (candidate) =>
            candidate.agent === agentName &&
            candidate.type === "commitment" &&
            candidate.eventId === claim.eventId &&
            candidate.text.toLowerCase().replace(/\s+/g, " ").trim() === normalizedText,
        );
        const stored =
          duplicate ?? (await insertClaims(investigationId, [{ ...claim, agent: agentName, issueId }]))[0];
        if (!stored) return JSON.stringify({ error: "commitment claim could not be stored." });

        // A completed-fix statement or a QA result is a finding, not a promise.
        // Keep the backing claim (it is still evidence) but do not put it in
        // the commitments ledger.
        if (!isPromiseLike(object, claim.text)) {
          return JSON.stringify({
            claimId: stored.id,
            error:
              "not a promise: the object has no forward-looking commitment (will/scheduled/targeted/by <release>). Submit it with submit_claim instead; the claim is stored.",
          });
        }

        // The deadline is resolved by code from the stated phrase and the
        // record's timestamp; the made-date never becomes the deadline (G-04).
        const events = await getEvents(investigationId);
        const event = events.find((candidate) => candidate.id === stored.eventId);
        const referenceIso = claim.ts ?? event?.ts ?? null;
        const deadlinePhrase = asString(args.deadline)?.trim() || null;
        const deadline = deadlinePhrase
          ? extractDeadline(deadlinePhrase, referenceIso)
          : extractDeadline(claim.text, referenceIso);

        const promisee = asString(args.to)?.trim() || null;
        const fulfilmentEventIds = Array.isArray(args.fulfilment_item_ids)
          ? args.fulfilment_item_ids.filter((value): value is string => typeof value === "string")
          : [];
        const rawStatus: CommitmentStatus =
          stored.status === "kept" || stored.status === "broken" ? stored.status : "unclear";
        const ruled = applyStatusRules({
          status: rawStatus,
          fulfilmentEventIds,
          rationale: asString(args.rationale)?.trim() || null,
        });

        const commitment = await mergeCommitment(investigationId, {
          claimId: stored.id,
          issueId: stored.issueId ?? issueId ?? null,
          promisor: claim.actor ?? null,
          promisee,
          object,
          conditions: asString(args.conditions)?.trim() || null,
          deadlinePhrase: deadline?.label ?? deadlinePhrase,
          deadlineIso: deadline?.iso ?? null,
          rationale: ruled.rationale,
          status: ruled.status,
          fulfilmentEventIds,
          sourceEventId: stored.eventId,
          dedupeKey: commitmentDedupeKey({
            promisor: claim.actor ?? null,
            promisee,
            object,
            deadlineIso: deadline?.iso ?? null,
          }),
        });

        return JSON.stringify({
          commitmentId: commitment.id,
          claimId: stored.id,
          status: commitment.status,
          contested: commitment.contested,
          issueId: stored.issueId ?? null,
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return { specs: toolSpecs(), exec };
}
