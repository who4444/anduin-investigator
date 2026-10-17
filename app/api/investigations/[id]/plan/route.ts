import type { NextRequest } from "next/server";

import { runAnalyst } from "@/lib/agents/analyst";
import {
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
  runStage,
} from "@/lib/api/pipeline";
import { getLlmClient } from "@/lib/llm";
import { resolveScope } from "@/lib/pipeline/scope";
import { getEvents, getLearnedScope, setScope, upsertLearnedScope } from "@/lib/store";

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const pass = readPass(await readJsonBody(request));

  return runStage(id, "plan", pass, async () => {
    // Identify which client and project this escalation concerns, verified
    // against the registry, before any investigator searches it. Anchors
    // learned from earlier confirmed investigations for the same declared
    // client are offered as prior evidence (re-verified here).
    const events = await getEvents(id);
    const declared = found.investigation.declaredClient;
    const learned = await getLearnedScope(declared);
    const scope = await resolveScope(
      found.investigation.escalationText,
      events,
      getLlmClient(),
      declared,
      learned,
    );
    await setScope(id, scope);
    if (scope?.confidence === "scoped" && scope.client) {
      await upsertLearnedScope(scope.client, scope);
    }

    const plan = await runAnalyst(id, found.investigation.escalationText, pass);
    return { plan, scope };
  });
}
