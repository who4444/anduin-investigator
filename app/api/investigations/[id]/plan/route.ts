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
import { clientDomainsFor } from "@/lib/pipeline/scope";
import { getEvents, getInvestigation, getIssues, getLearnedScope, setScope, upsertLearnedScope } from "@/lib/store";
import type { ScopeAnchor } from "@/lib/types";

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

    // B3: the plan names the target tickets; validate them against the
    // registry and widen the scope only where client evidence connects.
    let refinedScope = scope;
    let refinement: { added: ScopeAnchor[]; skipped: { value: string; why: string }[] } = { added: [], skipped: [] };
    if (scope && scope.confidence !== "none") {
      const withPlan = await getInvestigation(id);
      if (withPlan?.planData) {
        const { refineScopeWithPlan } = await import("@/lib/pipeline/scope");
        const result = refineScopeWithPlan(scope, withPlan.planData, events);
        refinedScope = result.scope;
        refinement = { added: result.added, skipped: result.skipped };
        if (result.added.length > 0) {
          await setScope(id, refinedScope);
        }
      }
    }
    if (refinedScope?.confidence === "scoped" && refinedScope.client) {
      // Synthetic runs must not teach the store: a demo/labelling origin is
      // not evidence about the real client's records. And only the client's
      // VERIFIED domains are learned — correspondence/vendor domains are not.
      if (found.investigation.origin !== "demo") {
        await upsertLearnedScope(refinedScope.client, {
          ...refinedScope,
          senderDomains: clientDomainsFor(events, refinedScope),
        });
      }
    }

    const issues = await getIssues(id);
    return { plan, scope: refinedScope, issues, scopeRefinement: refinement };
  }, worker, resume);
}
