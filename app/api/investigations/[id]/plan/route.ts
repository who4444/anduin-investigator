import type { NextRequest } from "next/server";

import { runAnalyst } from "@/lib/agents/analyst";
import {
  readId,
  readInvestigationOrDefault,
  readJsonBody,
  readPass,
  readResume,
  readWorker,
  runStage,
} from "@/lib/api/pipeline";
import { getLlmClient } from "@/lib/llm";
import { resolveScope } from "@/lib/pipeline/scope";
import { getEvents, getIssues, getLearnedScope, setScope, upsertLearnedScope } from "@/lib/store";

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const body = await readJsonBody(request);
  const pass = readPass(body);
  const worker = readWorker(body);
  const resume = readResume(body);

  return runStage(id, "plan", pass, async () => {
    // Re-entering the plan stage (a reload while the issue review is open)
    // must not overwrite the manager's edits with a second model split.
    const existingIssues = await getIssues(id);
    if (found.investigation.plan && found.investigation.scope && existingIssues.length > 0) {
      return {
        plan: found.investigation.plan,
        scope: found.investigation.scope,
        issues: existingIssues,
        reused: true,
      };
    }

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
    const issues = await getIssues(id);
    return { plan, scope, issues };
  }, worker, resume);
}
