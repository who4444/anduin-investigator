import type { NextRequest } from "next/server";

import {
  errorResponse,
  json,
  readId,
  readInvestigationOrDefault,
  readJsonBody,
} from "@/lib/api/pipeline";
import { getEvents, setScope, setScopeOverrides } from "@/lib/store";
import { splitEventsByScope } from "@/lib/pipeline/scope";
import type { InvestigationScope } from "@/lib/types";

export const maxDuration = 60;
const MAX_OVERRIDES = 500;

/** Human labels for the proposed scope, from the live pull's selection:
    prefix → project name ("MER" → "Meridian Billing"), channel → "#channel",
    and the Gmail mailbox filter. Upload/demo runs fall back to raw values. */
function scopeLabels(
  selection: { source: string; targets: { id: string; label: string }[]; query: string | null }[] | null,
): { labels: Record<string, string>; mailQuery: string | null } {
  const labels: Record<string, string> = {};
  let mailQuery: string | null = null;
  for (const entry of selection ?? []) {
    if (entry.source === "gmail") {
      mailQuery = entry.query ?? null;
      continue;
    }
    for (const target of entry.targets) {
      if (entry.source === "jira") {
        const [key, ...rest] = target.label.split(" · ");
        const name = rest.join(" · ");
        if (key) labels[key.toUpperCase()] = name || key;
      } else if (entry.source === "slack") {
        const name = target.label.replace(/^#/, "");
        if (name) labels[name.toLowerCase()] = target.label.startsWith("#") ? target.label : `#${name}`;
      }
    }
  }
  return { labels, mailQuery };
}

interface RemoveRequest {
  ticketPrefixes: string[];
  channels: string[];
  senderDomains: string[];
}

function readRemove(value: unknown, scope: InvestigationScope | null): RemoveRequest {
  const remove: RemoveRequest = { ticketPrefixes: [], channels: [], senderDomains: [] };
  if (!scope || typeof value !== "object" || value === null) return remove;
  const record = value as Record<string, unknown>;
  const list = (key: keyof RemoveRequest): string[] =>
    Array.isArray(record[key])
      ? (record[key] as unknown[])
          .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
          .map((entry) => entry.trim())
          .filter((entry) => scope[key].includes(entry))
      : [];
  remove.ticketPrefixes = list("ticketPrefixes");
  remove.channels = list("channels");
  remove.senderDomains = list("senderDomains");
  return remove;
}

/* G-12 pre-run preview: what will be searched, what stays out, and how big
   the run is — shown before tokens are spent on any scope. */
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  try {
    const events = await getEvents(id);
    const scope = found.investigation.scope;
    const { inScope, outOfScope } = splitEventsByScope(
      events,
      scope,
      found.investigation.scopeOverrides,
    );
    const sources = (["jira", "email", "slack"] as const).map((source) => ({
      source,
      included: inScope.filter((event) => event.source === source).length,
      excluded: outOfScope.filter((event) => event.source === source).length,
    }));
    const { labels, mailQuery } = scopeLabels(found.investigation.sourceSelection);
    return json({
      scope: scope
        ? {
            client: scope.client,
            project: scope.project,
            ticketPrefixes: scope.ticketPrefixes,
            channels: scope.channels,
            senderDomains: scope.senderDomains,
          }
        : null,
      labels,
      mailQuery,
      client: scope?.client ?? found.investigation.declaredClient ?? null,
      project: scope?.project ?? null,
      confidence: scope?.confidence ?? null,
      confirmed: Boolean(found.investigation.scopeReviewedAt),
      inScopeRecords: inScope.length,
      excludedRecords: outOfScope.length,
      estimatedMinutes: Math.max(1, Math.round(events.length / 40)),
      sources,
      excludedEvents: outOfScope.slice(0, 200).map((event) => ({
        id: event.id,
        source: event.source,
        ts: event.ts,
        channel: event.channel,
        actor: event.actorResolved ?? event.actor,
        text: event.text.slice(0, 160),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not load the scope preview: ${message}`, 500);
  }
}

/* G-01 review: the manager adds records back from the excluded list and can
   remove proposed scope items (projects/channels/mailbox domains). Ids and
   removals are validated against the registry and the current scope, unknown
   values are dropped, and the response recomputes the disclosure so the UI
   never shows stale counts. */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as { includeEventIds?: unknown; remove?: unknown };
  if (!Array.isArray(body.includeEventIds)) {
    return errorResponse("includeEventIds must be an array of record ids.", 400);
  }
  const requested = body.includeEventIds
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  if (requested.length > MAX_OVERRIDES) {
    return errorResponse(`At most ${MAX_OVERRIDES} records can be added back at once.`, 400);
  }

  try {
    const events = await getEvents(id);
    const existing = found.investigation.scope;
    const remove = readRemove(body.remove, existing);

    // Narrow the proposed scope: removed prefixes/channels/domains no longer
    // match. Client-authored evidence still stays in scope by construction
    // (G-01) — the UI says so.
    let scope = existing;
    if (existing && (remove.ticketPrefixes.length > 0 || remove.channels.length > 0 || remove.senderDomains.length > 0)) {
      scope = {
        ...existing,
        ticketPrefixes: existing.ticketPrefixes.filter((value) => !remove.ticketPrefixes.includes(value)),
        channels: existing.channels.filter((value) => !remove.channels.includes(value)),
        senderDomains: existing.senderDomains.filter((value) => !remove.senderDomains.includes(value)),
      };
      await setScope(id, scope);
    }

    const known = new Set(events.map((event) => event.id));
    const includeEventIds = [...new Set(requested.filter((eventId) => known.has(eventId)))];
    // Stamps the review as confirmed and records the add-backs.
    await setScopeOverrides(id, includeEventIds);

    const { inScope, outOfScope } = splitEventsByScope(events, scope, includeEventIds);
    return json({
      includeEventIds,
      scope,
      inScopeRecords: inScope.length,
      excludedRecords: outOfScope.length,
      excludedEventIds: outOfScope.map((event) => event.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not save the scope review: ${message}`, 500);
  }
}
