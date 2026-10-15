import { verifyQuote } from "../verify";
import { appendStageLog, getClaims, getEvent, setClaimVerification } from "../store";

export interface VerificationSummary {
  total: number;
  kept: number;
  excluded: number;
}

export async function runClaimVerification(
  investigationId: string,
  pass = 1,
): Promise<VerificationSummary> {
  const claims = await getClaims(investigationId);

  let kept = 0;
  let excluded = 0;

  for (const claim of claims) {
    const event = await getEvent(investigationId, claim.eventId);
    if (!event) {
      await setClaimVerification(claim.id, "excluded", "event_not_found");
      excluded += 1;
      continue;
    }

    const result = verifyQuote(event.text, claim.quote);
    if (result.ok) {
      await setClaimVerification(claim.id, "kept");
      kept += 1;
    } else {
      await setClaimVerification(claim.id, "excluded", result.error ?? "quote_not_found");
      excluded += 1;
    }
  }

  await appendStageLog(investigationId, "verify", pass, {
    total: claims.length,
    kept,
    excluded,
  });

  return { total: claims.length, kept, excluded };
}
