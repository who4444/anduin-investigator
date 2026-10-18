import type { NextRequest } from "next/server";

import { errorResponse, json, readId, readInvestigationOrDefault, readJsonBody } from "@/lib/api/pipeline";
import { setDeclaredClient, setScope, setScopeOverrides } from "@/lib/store";
import type { InvestigationScope } from "@/lib/types";

export const maxDuration = 60;

/* The report's unresolved-client notice is actionable: the manager supplies the
   client (and optionally project) from the roster, and the report recomputes
   roles from that identifier. No model call and no new investigation. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = (await readJsonBody(request)) as { client?: unknown; project?: unknown };
  const client = typeof body.client === "string" ? body.client.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  const project = typeof body.project === "string" ? body.project.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  if (!client || !/\p{L}/u.test(client)) {
    return errorResponse("client must name the client from the roster.", 400);
  }

  const existing = found.investigation.scope;
  const scope: InvestigationScope = {
    client,
    project: project || existing?.project || null,
    ticketPrefixes: existing?.ticketPrefixes ?? [],
    channels: existing?.channels ?? [],
    senderDomains: existing?.senderDomains ?? [],
    confidence: "partial",
    anchors: [
      ...(existing?.anchors ?? []).filter((anchor) => anchor.source !== "declared"),
      { kind: "declared-client", value: client, source: "declared" },
    ],
  };
  try {
    await setDeclaredClient(id, client);
    await setScope(id, scope);
    // A manager confirmation is a review of the identity; keep any add-backs.
    await setScopeOverrides(id, found.investigation.scopeOverrides);
    return json({ ok: true, scope });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResponse(`Could not save the client: ${message}`, 500);
  }
}
