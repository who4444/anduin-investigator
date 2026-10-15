import { extractJson, isPlainObject } from "../json";
import { getLlmClient } from "../llm";
import {
  appendStageLog,
  getClaims,
  getEvents,
  insertGaps,
  insertSkepticNotes,
  setClaimSkepticFlag,
} from "../store";
import type { SkepticNoteInput, SkepticNoteKind, GapInput } from "../types";
import { compactEvent, summarizeEvents } from "./summary";

const SKEPTIC_KINDS: SkepticNoteKind[] = ["contradiction", "unsupported", "silence", "unanswered"];
const MAX_EVENTS_IN_PROMPT = 60;

const SYSTEM_PROMPT = [
  "You are the skeptic on an incident investigation.",
  "Your job is to attack the draft findings, not to add new ones.",
  "Look for: contradictions between sources; claims the cited event does not actually support; suspicious silences (long gaps, questions with no reply); and questions the records leave unanswered.",
  "Report each issue with the claim index it concerns when applicable, and cite event ids.",
  'Reply with JSON only: {"issues":[{"kind":"contradiction|unsupported|silence|unanswered","claim_index":0,"text":"...","event_ids":["..."]}]}. claim_index is optional; omit it for issues not tied to a claim. If you find nothing, return {"issues":[]}.',
].join("\n");

export interface SkepticResult {
  flagged: number;
  issues: number;
}

function collectIssues(content: string): { kind: SkepticNoteKind; claimIndex?: number; text: string; eventIds: string[] }[] {
  const parsed = extractJson(content);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.issues)) return [];

  const issues: { kind: SkepticNoteKind; claimIndex?: number; text: string; eventIds: string[] }[] = [];
  for (const raw of parsed.issues) {
    if (!isPlainObject(raw)) continue;
    const kind = typeof raw.kind === "string" ? raw.kind : "";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text || !SKEPTIC_KINDS.includes(kind as SkepticNoteKind)) continue;

    const claimIndex =
      typeof raw.claim_index === "number" && Number.isInteger(raw.claim_index)
        ? raw.claim_index
        : undefined;
    const eventIds = Array.isArray(raw.event_ids)
      ? raw.event_ids.filter((id): id is string => typeof id === "string")
      : [];

    issues.push({ kind: kind as SkepticNoteKind, claimIndex, text, eventIds });
  }
  return issues;
}

export async function runSkeptic(investigationId: string, pass = 1): Promise<SkepticResult> {
  const claims = await getClaims(investigationId);
  const events = await getEvents(investigationId);

  if (claims.length === 0) {
    await appendStageLog(investigationId, "skeptic", pass, { flagged: 0, issues: 0, note: "no claims to review" });
    return { flagged: 0, issues: 0 };
  }

  const indexedClaims = claims.map((claim, index) => ({
    index,
    id: claim.id,
    agent: claim.agent,
    type: claim.type,
    text: claim.text,
    quote: claim.quote,
    event_id: claim.eventId,
    status: claim.status,
    confidence: claim.confidence,
    verify_status: claim.verifyStatus,
  }));

  const eventPayload =
    events.length <= MAX_EVENTS_IN_PROMPT
      ? events.map((event) => compactEvent(event))
      : undefined;

  const user = [
    "Draft claims (index is how the model should reference them):",
    JSON.stringify(indexedClaims),
    "",
    "Event store summary:",
    summarizeEvents(events),
    "",
    eventPayload
      ? `All events (compact):\n${JSON.stringify(eventPayload)}`
      : "Use the summary above; the store is too large to inline.",
    "",
    "Report contradictions, unsupported claims, silences, and unanswered questions.",
  ].join("\n");

  let content = "";
  let degraded = false;
  try {
    const response = await getLlmClient().chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ],
      { forceJson: true },
    );
    content = response.content;
  } catch {
    degraded = true;
  }

  const issues = degraded ? [] : collectIssues(content);

  const notes: SkepticNoteInput[] = [];
  const gaps: GapInput[] = [];
  const flaggedClaimIds = new Set<string>();

  for (const issue of issues) {
    const claim = issue.claimIndex !== undefined ? claims[issue.claimIndex] : undefined;
    if (claim) flaggedClaimIds.add(claim.id);

    notes.push({
      claimId: claim?.id,
      kind: issue.kind,
      text: issue.text,
      eventIds: issue.eventIds,
    });

    if (issue.kind === "silence" || issue.kind === "unanswered") {
      gaps.push({
        question: issue.text,
        note: issue.text,
        eventIds: issue.eventIds,
      });
    }
  }

  if (notes.length > 0) await insertSkepticNotes(investigationId, notes);
  if (gaps.length > 0) await insertGaps(investigationId, gaps);
  for (const claimId of flaggedClaimIds) {
    await setClaimSkepticFlag(claimId, true);
  }

  await appendStageLog(investigationId, "skeptic", pass, {
    flagged: flaggedClaimIds.size,
    issues: issues.length,
    degraded,
  });

  return { flagged: flaggedClaimIds.size, issues: issues.length };
}
