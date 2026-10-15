import { asNumber, asString } from "../json";
import type { ToolSpec } from "../llm";
import { getEvent, getEvents, insertClaims } from "../store";
import type { ClaimInput, ClaimStatus, Event } from "../types";
import { verifyQuote } from "../verify";
import { compactEvent, type CompactEvent } from "./summary";

const MAX_SEARCH_RESULTS = 30;
const MAX_LIST_RESULTS = 50;

const CLAIM_STATUSES: ClaimStatus[] = ["kept", "broken", "unclear", "n/a"];

export interface AgentTools {
  specs: ToolSpec[];
  exec(name: string, args: Record<string, unknown>): Promise<string>;
}

function compact(event: Event, limit?: number): CompactEvent {
  return compactEvent(event, limit);
}

function resolvedActor(event: Event): string {
  return event.actorResolved ?? event.actor;
}

function matchesWindow(event: Event, from?: string, to?: string): boolean {
  if (from && event.ts < from) return false;
  if (to && event.ts > to) return false;
  return true;
}

function matchesActor(event: Event, actor: string): boolean {
  const needle = actor.toLowerCase();
  return (
    resolvedActor(event).toLowerCase().includes(needle) ||
    event.actor.toLowerCase().includes(needle)
  );
}

function toolSpecs(): ToolSpec[] {
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    required: string[] = [],
  ): ToolSpec => ({
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required },
    },
  });

  return [
    tool(
      "search_events",
      "Search the incident event store. Returns up to 30 compact events matching the query text (case-insensitive) plus any actor/source/time filters.",
      {
        query: { type: "string", description: "Substring to look for in the event text, channel, or actor." },
        actor: { type: "string" },
        source: { type: "string", enum: ["jira", "email", "slack"] },
        from: { type: "string", description: "Inclusive lower bound, ISO timestamp." },
        to: { type: "string", description: "Inclusive upper bound, ISO timestamp." },
      },
      ["query"],
    ),
    tool(
      "get_event",
      "Fetch one event by id with its full text.",
      { id: { type: "string" } },
      ["id"],
    ),
    tool(
      "get_thread",
      "Fetch the events in the same thread/conversation as the given event id.",
      { id: { type: "string" } },
      ["id"],
    ),
    tool(
      "list_events",
      "List events in chronological order, optionally filtered by actor and/or time window. Returns up to 50.",
      {
        actor: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
    ),
    tool(
      "verify_quote",
      "Check whether a quote appears verbatim (whitespace-normalized) in the given event. Always verify a quote before submitting a claim.",
      {
        event_id: { type: "string" },
        quote: { type: "string", description: "Exact substring copied from the event text." },
      },
      ["event_id", "quote"],
    ),
    tool(
      "submit_claim",
      "Record one verified finding. The quote MUST be an exact substring of the cited event text.",
      {
        type: {
          type: "string",
          description: "root_cause | commitment | decision | process_failure | ownership",
        },
        text: { type: "string", description: "One sentence stating the finding." },
        actor: { type: "string" },
        quote: { type: "string" },
        event_id: { type: "string" },
        ts: { type: "string" },
        status: { type: "string", enum: CLAIM_STATUSES },
        confidence: { type: "number", description: "0-1." },
      },
      ["type", "text", "quote", "event_id", "status", "confidence"],
    ),
  ];
}

function claimFromArgs(args: Record<string, unknown>): { claim?: ClaimInput; error?: string } {
  const type = asString(args.type);
  const text = asString(args.text);
  const quote = asString(args.quote);
  const eventId = asString(args.event_id);
  const status = asString(args.status);
  const confidence = asNumber(args.confidence);

  if (!type || !text || !quote || !eventId) {
    return { error: "type, text, quote, and event_id are required." };
  }
  if (!status || !CLAIM_STATUSES.includes(status as ClaimStatus)) {
    return { error: `status must be one of ${CLAIM_STATUSES.join(", ")}.` };
  }
  if (confidence === undefined) {
    return { error: "confidence must be a number between 0 and 1." };
  }

  return {
    claim: {
      agent: "unknown",
      type,
      text,
      actor: asString(args.actor),
      quote,
      eventId,
      ts: asString(args.ts),
      status: status as ClaimStatus,
      confidence: Math.min(1, Math.max(0, confidence)),
    },
  };
}

export function buildAgentTools(investigationId: string, agentName: string): AgentTools {
  async function exec(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case "search_events": {
        const query = asString(args.query);
        const actor = asString(args.actor);
        const source = asString(args.source);
        const from = asString(args.from);
        const to = asString(args.to);
        const events = await getEvents(investigationId);
        const needle = query?.toLowerCase();

        const matches = events.filter((event) => {
          if (source && event.source !== source) return false;
          if (actor && !matchesActor(event, actor)) return false;
          if (!matchesWindow(event, from, to)) return false;
          if (
            needle &&
            !event.text.toLowerCase().includes(needle) &&
            !event.channel.toLowerCase().includes(needle) &&
            !resolvedActor(event).toLowerCase().includes(needle)
          ) {
            return false;
          }
          return true;
        });

        return JSON.stringify({
          count: matches.length,
          events: matches.slice(0, MAX_SEARCH_RESULTS).map((event) => compact(event)),
          truncated: matches.length > MAX_SEARCH_RESULTS,
        });
      }

      case "get_event": {
        const id = asString(args.id);
        if (!id) return JSON.stringify({ error: "id is required." });
        const event = await getEvent(investigationId, id);
        return event
          ? JSON.stringify(compact(event, Number.MAX_SAFE_INTEGER))
          : JSON.stringify({ error: `No event with id ${id}.` });
      }

      case "get_thread": {
        const id = asString(args.id);
        if (!id) return JSON.stringify({ error: "id is required." });
        const anchor = await getEvent(investigationId, id);
        if (!anchor) return JSON.stringify({ error: `No event with id ${id}.` });

        const events = await getEvents(investigationId);
        const sameThread = anchor.threadId
          ? events.filter((event) => event.threadId === anchor.threadId)
          : events.filter(
              (event) =>
                event.channel === anchor.channel && event.ts.slice(0, 10) === anchor.ts.slice(0, 10),
            );

        return JSON.stringify({
          threadId: anchor.threadId ?? null,
          events: sameThread.map((event) => compact(event)),
        });
      }

      case "list_events": {
        const actor = asString(args.actor);
        const from = asString(args.from);
        const to = asString(args.to);
        const events = await getEvents(investigationId);
        const matches = events.filter(
          (event) =>
            (!actor || matchesActor(event, actor)) && matchesWindow(event, from, to),
        );

        return JSON.stringify({
          count: matches.length,
          events: matches.slice(0, MAX_LIST_RESULTS).map((event) => compact(event)),
          truncated: matches.length > MAX_LIST_RESULTS,
        });
      }

      case "verify_quote": {
        const eventId = asString(args.event_id);
        const quote = asString(args.quote);
        if (!eventId || quote === undefined) {
          return JSON.stringify({ error: "event_id and quote are required." });
        }
        const event = await getEvent(investigationId, eventId);
        if (!event) return JSON.stringify({ ok: false, error: "event_not_found" });
        return JSON.stringify(verifyQuote(event.text, quote));
      }

      case "submit_claim": {
        const { claim, error } = claimFromArgs({ ...args, agent: agentName });
        if (!claim) return JSON.stringify({ error });
        const [stored] = await insertClaims(investigationId, [{ ...claim, agent: agentName }]);
        return JSON.stringify({ claimId: stored.id });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return { specs: toolSpecs(), exec };
}
