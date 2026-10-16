export type AttributionReason = "actor_mismatch" | "ts_mismatch" | "invalid_ts";

export interface AttributionDetail {
  claimActor: string | null;
  eventActor: string;
  claimTs: string | null;
  eventTs: string;
}

export interface AttributionResult {
  ok: boolean;
  reason?: AttributionReason;
  detail: AttributionDetail;
}

const TS_TOLERANCE_MS = 60_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function actorKeys(
  raw: string | null | undefined,
  aliasMap: Map<string, string>,
): Set<string> {
  const keys = new Set<string>();
  if (!raw || raw.trim() === "") return keys;

  const add = (value: string) => {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return;
    keys.add(normalized);
    const tokenForm = normalized
      .replace(/[_.\-]+/g, " ")
      .replace(/[^a-z0-9@\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!tokenForm) return;
    keys.add(tokenForm);
    keys.add(tokenForm.split(" ").sort().join(" "));
  };

  const candidates: string[] = [raw];
  const angled = raw.match(/<([^>]+)>/);
  if (angled) {
    candidates.push(angled[1], raw.slice(0, raw.indexOf("<")));
  }
  const email = raw.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+/i);
  if (email) candidates.push(email[0]);

  for (const candidate of [...candidates]) {
    const resolved = aliasMap.get(candidate.trim().toLowerCase());
    if (resolved) candidates.push(resolved);
  }

  for (const candidate of candidates) add(candidate);
  return keys;
}

function actorMatches(
  claimActor: string | null | undefined,
  eventActor: string,
  eventActorResolved: string | null | undefined,
  aliasMap: Map<string, string>,
): boolean {
  const claimKeys = actorKeys(claimActor, aliasMap);
  if (claimKeys.size === 0) return false;

  const eventKeys = actorKeys(eventActor, aliasMap);
  if (eventActorResolved) {
    for (const key of actorKeys(eventActorResolved, aliasMap)) eventKeys.add(key);
  }

  for (const key of claimKeys) {
    if (eventKeys.has(key)) return true;
  }
  return false;
}

function timestampMatches(
  claimTs: string | null | undefined,
  eventTs: string,
): { ok: boolean; reason?: AttributionReason } {
  if (claimTs === null || claimTs === undefined || claimTs.trim() === "") {
    return { ok: true };
  }

  if (DATE_ONLY.test(claimTs)) {
    return claimTs === eventTs.slice(0, 10) ? { ok: true } : { ok: false, reason: "ts_mismatch" };
  }

  const claim = Date.parse(claimTs);
  if (Number.isNaN(claim)) return { ok: false, reason: "invalid_ts" };
  const event = Date.parse(eventTs);
  if (Number.isNaN(event)) return { ok: false, reason: "ts_mismatch" };

  return Math.abs(claim - event) <= TS_TOLERANCE_MS ? { ok: true } : { ok: false, reason: "ts_mismatch" };
}

export function checkAttribution(
  claim: { actor?: string | null; ts?: string | null },
  event: { actor: string; actorResolved?: string | null; ts: string },
  aliasMap: Map<string, string> = new Map(),
): AttributionResult {
  const detail: AttributionDetail = {
    claimActor: claim.actor ?? null,
    eventActor: event.actorResolved ?? event.actor,
    claimTs: claim.ts ?? null,
    eventTs: event.ts,
  };

  if (!actorMatches(claim.actor, event.actor, event.actorResolved, aliasMap)) {
    return { ok: false, reason: "actor_mismatch", detail };
  }

  const ts = timestampMatches(claim.ts, event.ts);
  if (!ts.ok) {
    return { ok: false, reason: ts.reason ?? "ts_mismatch", detail };
  }

  return { ok: true, detail };
}
