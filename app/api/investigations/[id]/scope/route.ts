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
