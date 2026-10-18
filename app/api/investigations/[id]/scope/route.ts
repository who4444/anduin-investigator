import type { NextRequest } from "next/server";

import {
  errorResponse,
  json,
  readId,
  readInvestigationOrDefault,
  readJsonBody,
} from "@/lib/api/pipeline";
import { getEvents, setScopeOverrides } from "@/lib/store";
import { splitEventsByScope } from "@/lib/pipeline/scope";

export const maxDuration = 60;
const MAX_OVERRIDES = 500;

/* G-12 pre-run preview: what will be searched, what stays out, and how big
   the run is — shown before tokens are spent on a partial scope. */
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
    return json({
      scope,
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

/* G-01 review: the manager adds records back from the excluded list. Ids are
   validated against the registry, unknown ids are dropped, and the response
   recomputes the disclosure so the UI never shows stale counts. */
export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as { includeEventIds?: unknown };
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
    const known = new Set(events.map((event) => event.id));
    const includeEventIds = [...new Set(requested.filter((eventId) => known.has(eventId)))];
    await setScopeOverrides(id, includeEventIds);

    const { inScope, outOfScope } = splitEventsByScope(
      events,
      found.investigation.scope,
      includeEventIds,
    );
    return json({
      includeEventIds,
      inScopeRecords: inScope.length,
      excludedRecords: outOfScope.length,
      excludedEventIds: outOfScope.map((event) => event.id),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not save the scope review: ${message}`, 500);
  }
}
