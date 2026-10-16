import { getLlmClient } from "../llm";
import { appendStageLog, getClaims, getEvents, getIdentities, setClaimVerification } from "../store";
import type { Claim, ClaimChecks, Event } from "../types";
import { verifyQuote } from "../verify";
import { checkAttribution } from "./attribution";
import { runEntailmentLayer, type EntailmentLayerOptions } from "./entailment";

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
  const [claims, events, identities] = await Promise.all([
    getClaims(investigationId),
    getEvents(investigationId),
    getIdentities(investigationId),
  ]);
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const aliasMap = new Map(
    identities.filter((identity) => identity.applied).map((identity) => [
      identity.alias.toLowerCase(),
      identity.canonical,
    ]),
  );

  let verified = 0;
  let supported = 0;
  let rejected = 0;
  let skipped = 0;

  interface Pending {
    claim: Claim;
    attribution: NonNullable<ClaimChecks["attribution"]>;
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

    pending.push({ claim, attribution: attributionCheck });
  }

  const layerOutcome = await runEntailmentLayer(
    pending.map(({ claim }) => ({ claimId: claim.id, text: claim.text, quote: claim.quote })),
    { client: getLlmClient(), ...options },
  );

  for (const { claim, attribution } of pending) {
    const entailment = layerOutcome.results.get(claim.id) ?? {
      verdict: "unavailable" as const,
      error: "error" as const,
    };
    const checks: ClaimChecks = {
      quote: { ok: true },
      attribution,
      entailment,
    };

    if (entailment.verdict === "supports") {
      await setClaimVerification(claim.id, "verified", null, checks);
      verified += 1;
    } else {
      const error =
        entailment.verdict === "unavailable"
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
