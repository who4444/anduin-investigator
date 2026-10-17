import { getLlmClient } from "../llm";
import {
  appendStageLog,
  getClaims,
  getEvents,
  getIdentities,
  getInvestigation,
  getStages,
  setClaimVerification,
} from "../store";
import type { Claim, ClaimChecks, ClaimNegativeCheck, Event } from "../types";
import { verifyQuote } from "../verify";
import { checkAttribution } from "./attribution";
import { runEntailmentLayer, type EntailmentLayerOptions } from "./entailment";
import { classifyNegative, negativeCompleteness } from "./negative";
import { splitEventsByScope } from "./scope";

export interface VerificationSummary {
  total: number;
  verified: number;
  supported: number;
  rejected: number;
  entailment: { reviewed: number; unavailable: number; skipped: number };
}

export type VerificationOptions = Omit<EntailmentLayerOptions, "client">;

function emptyChecks(quote: ClaimChecks["quote"], attribution: ClaimChecks["attribution"]): ClaimChecks {
  return { quote, attribution, entailment: null };
}

export async function runClaimVerification(
  investigationId: string,
  pass = 1,
  options: VerificationOptions = {},
): Promise<VerificationSummary> {
  const [claims, events, identities, investigation, stages] = await Promise.all([
    getClaims(investigationId),
    getEvents(investigationId),
    getIdentities(investigationId),
    getInvestigation(investigationId),
    getStages(investigationId),
  ]);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const aliasMap = new Map(
    identities.filter((identity) => identity.applied).map((identity) => [
      identity.alias.toLowerCase(),
      identity.canonical,
    ]),
  );

  // G-03: a negative claim is judged against what was actually searched.
  const { inScope } = splitEventsByScope(
    events,
    investigation?.scope ?? null,
    investigation?.scopeOverrides ?? [],
  );
  const completenessInput = {
    events,
    stages,
    timeline: inScope,
    scope: investigation?.scope ?? null,
  };

  let verified = 0;
  let supported = 0;
  let rejected = 0;
  let skipped = 0;

  interface Pending {
    claim: Claim;
    attribution: NonNullable<ClaimChecks["attribution"]>;
    negative: ClaimNegativeCheck | null;
  }
  const pending: Pending[] = [];

  for (const claim of claims) {
    const event: Event | undefined = eventsById.get(claim.eventId);

    if (!event) {
      await setClaimVerification(claim.id, "rejected", "event_not_found", emptyChecks(null, null));
      rejected += 1;
      continue;
    }

    const quote = verifyQuote(event.text, claim.quote);
    if (!quote.ok) {
      const error = quote.error ?? "quote_not_found";
      await setClaimVerification(claim.id, "rejected", error, emptyChecks({ ok: false, error }, null));
      rejected += 1;
      continue;
    }

    const attribution = checkAttribution(claim, event, aliasMap);
    const attributionCheck: NonNullable<ClaimChecks["attribution"]> = {
      ok: attribution.ok,
      ...(attribution.reason ? { reason: attribution.reason } : {}),
      ...attribution.detail,
    };

    if (!attribution.ok) {
      await setClaimVerification(
        claim.id,
        "supported",
        attribution.reason ?? "attribution_mismatch",
        emptyChecks({ ok: true }, attributionCheck),
      );
      supported += 1;
      skipped += 1;
      continue;
    }

    // G-03: a negative claim without a complete search behind it is capped
    // at "supported" and carries the proof — and the reason — with it.
    const classification = classifyNegative(claim.text);
    if (classification.isNegative) {
      const proof = negativeCompleteness(completenessInput);
      const negative: ClaimNegativeCheck = { subject: classification.subject, ...proof };
      if (!proof.complete) {
        await setClaimVerification(claim.id, "supported", "evidence_incomplete", {
          quote: { ok: true },
          attribution: attributionCheck,
          entailment: null,
          negative,
        });
        supported += 1;
        continue;
      }
      pending.push({ claim, attribution: attributionCheck, negative });
      continue;
    }

    pending.push({ claim, attribution: attributionCheck, negative: null });
  }

  const layerOutcome = await runEntailmentLayer(
    pending.map(({ claim }) => ({ claimId: claim.id, text: claim.text, quote: claim.quote })),
    { client: getLlmClient(), ...options },
  );

  for (const { claim, attribution, negative } of pending) {
    const entailment = layerOutcome.results.get(claim.id) ?? {
      verdict: "unavailable" as const,
      error: "error" as const,
    };
    const checks: ClaimChecks = {
      quote: { ok: true },
      attribution,
      entailment,
      negative,
    };

    // A negative inference is never "verified": even when the model supports
    // it and the search was complete, it stays "check before repeating".
    if (entailment.verdict === "supports" && !negative) {
      await setClaimVerification(claim.id, "verified", null, checks);
      verified += 1;
    } else {
      const error = negative
        ? "negative_inference"
        : entailment.verdict === "unavailable"
          ? "entailment_unavailable"
          : `entailment_${entailment.verdict}`;
      await setClaimVerification(claim.id, "supported", error, checks);
      supported += 1;
    }
  }

  const entailment = {
    reviewed: layerOutcome.reviewed,
    unavailable: layerOutcome.unavailable,
    skipped,
  };

  await appendStageLog(investigationId, "verify", pass, {
    total: claims.length,
    verified,
    supported,
    rejected,
    entailment,
  });

  return { total: claims.length, verified, supported, rejected, entailment };
}
