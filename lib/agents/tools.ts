import { asNumber, asString } from "../json";
import type { ToolSpec } from "../llm";
import { getClaims, getEvents, insertClaims } from "../store";
import type { ClaimInput, ClaimStatus, Event, SourceKind } from "../types";
import { verifyQuote } from "../verify";
import { compactEvent, type CompactEvent } from "./summary";

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
      { key: { type: "string", description: "Issue key, e.g. MER-101." } },
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

function matchesWindow(event: Event, from?: string, to?: string): boolean {
  if (from && event.ts < from) return false;
  if (to && event.ts > to) return false;
  return true;
}

function matchesQuery(event: Event, needle: string | undefined): boolean {
  if (!needle) return true;
  const lower = needle.toLowerCase();
  return (
    event.text.toLowerCase().includes(lower) ||
    event.channel.toLowerCase().includes(lower) ||
    (event.actorResolved ?? event.actor).toLowerCase().includes(lower)
  );
}

function normalizeThreadRef(id: string): string {
  return id.replace(/^</, "").replace(/>$/, "");
}

function claimFromArgs(args: Record<string, unknown>): { claim?: ClaimInput; error?: string } {
  const type = asString(args.type);
  const text = asString(args.text);
  const quote = asString(args.quote);
  const eventId = asString(args.item_id) ?? asString(args.event_id);
  const status = asString(args.status);
  const confidence = asNumber(args.confidence);

  if (!type || !text || !quote || !eventId) {
    return { error: "type, text, quote, and item_id are required." };
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
  async function sourceItems(source: SourceKind): Promise<Event[]> {
    const events = await getEvents(investigationId);
    return events.filter((event) => event.source === source);
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
        return JSON.stringify({
          count: matches.length,
          items: matches.slice(0, MAX_SEARCH_RESULTS).map((event) => compactEvent(event)),
          truncated: matches.length > MAX_SEARCH_RESULTS,
        });
      }

      case "get_issue": {
        const key = asString(args.key);
        if (!key) return JSON.stringify({ error: "key is required." });
        const needle = key.toLowerCase();
        const items = (await sourceItems("jira")).filter(
          (event) => event.channel.toLowerCase() === needle,
        );
        if (items.length === 0) return JSON.stringify({ error: `No stored issue ${key}.` });
        return JSON.stringify({
          count: items.length,
          items: items.map((event) => compactEvent(event, FULL_TEXT)),
        });
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
        return JSON.stringify({
          count: matches.length,
          items: matches.slice(0, MAX_SEARCH_RESULTS).map((event) => compactEvent(event)),
          truncated: matches.length > MAX_SEARCH_RESULTS,
        });
      }

      case "get_slack_thread": {
        const channel = asString(args.channel);
        const ts = asString(args.ts);
        if (!channel || !ts) return JSON.stringify({ error: "channel and ts are required." });
        const threadId = `slack:${channel}:${ts}`;
        const slack = await sourceItems("slack");
        let items = slack.filter((event) => event.threadId === threadId);
        if (items.length === 0) {
          const day = new Date(Number(ts) * 1000).toISOString().slice(0, 10);
          items = slack.filter(
            (event) => event.channel.toLowerCase() === channel.toLowerCase() && event.ts.startsWith(day),
          );
        }
        if (items.length === 0) return JSON.stringify({ error: `No stored thread ${threadId}.` });
        return JSON.stringify({ count: items.length, items: items.map((event) => compactEvent(event, FULL_TEXT)) });
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
        return JSON.stringify({
          count: matches.length,
          items: matches.slice(0, MAX_SEARCH_RESULTS).map((event) => compactEvent(event)),
          truncated: matches.length > MAX_SEARCH_RESULTS,
        });
      }

      case "get_email_thread": {
        const id = asString(args.id);
        if (!id) return JSON.stringify({ error: "id is required." });
        const needle = normalizeThreadRef(id);
        const email = await sourceItems("email");
        let items = email.filter((event) => event.threadId === needle);
        if (items.length === 0) items = email.filter((event) => event.threadId?.includes(needle));
        if (items.length === 0) return JSON.stringify({ error: `No stored thread for ${id}.` });
        return JSON.stringify({ count: items.length, items: items.map((event) => compactEvent(event, FULL_TEXT)) });
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

        const existing = await getClaims(investigationId);
        const duplicate = existing.find(
          (stored) =>
            stored.agent === agentName &&
            stored.type === claim.type &&
            stored.eventId === claim.eventId &&
            stored.text.toLowerCase().replace(/\s+/g, " ").trim() ===
              claim.text.toLowerCase().replace(/\s+/g, " ").trim(),
        );
        if (duplicate) return JSON.stringify({ claimId: duplicate.id, duplicate: true });

        const [stored] = await insertClaims(investigationId, [{ ...claim, agent: agentName }]);
        return JSON.stringify({ claimId: stored.id });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }

  return { specs: toolSpecs(), exec };
}
