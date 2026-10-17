import { extractJson, isPlainObject } from "../json";
import { getLlmClient } from "../llm";
import {
  appendStageLog,
  getClaims,
  getEvents,
  getInvestigation,
  getStages,
  insertGaps,
  insertSkepticNotes,
  setClaimSkepticFlag,
} from "../store";
import type { SkepticNoteInput, SkepticNoteKind, GapInput } from "../types";
import { buildCoverage } from "../pipeline/coverage";
import { scopePromptLine, splitEventsByScope } from "../pipeline/scope";
import { compactEvent, summarizeEvents } from "./summary";

const SKEPTIC_KINDS: SkepticNoteKind[] = ["contradiction", "unsupported", "silence", "unanswered"];
const MAX_EVENTS_IN_PROMPT = 60;

const SYSTEM_PROMPT = [
  "You are the skeptic on an incident investigation.",
  "Your job is to attack the draft findings, not to add new ones.",
  "Look for: contradictions between sources; claims the cited item does not actually support; suspicious silences (long gaps, questions with no reply); questions the records leave unanswered; and any available source or obvious angle that was never searched.",
  "Report each issue with the claim index it concerns when applicable, and cite item ids.",
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
  const investigation = await getInvestigation(investigationId);
  const scopeLine = scopePromptLine(investigation?.scope ?? null);
  const { inScope } = splitEventsByScope(events, investigation?.scope ?? null);

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
    inScope.length <= MAX_EVENTS_IN_PROMPT
      ? inScope.map((event) => compactEvent(event))
      : undefined;

  const stages = await getStages(investigationId);
  const coverage = buildCoverage(events, stages);

  const user = [
    "Draft claims (index is how the model should reference them):",
    JSON.stringify(indexedClaims),
    ...(scopeLine ? ["", scopeLine] : []),
    "",
    "Evidence Registry summary:",
    summarizeEvents(inScope),
    "",
    "Sources and queries already searched:",
    JSON.stringify(
      coverage.sources
        .filter((entry) => entry.searched)
        .map((entry) => ({ source: entry.source, queries: entry.queries })),
    ),
    coverage.neverSearched.length > 0
      ? `Available but NEVER searched: ${coverage.neverSearched.join(", ")} — raise an "unanswered" issue naming what should have been searched.`
      : "Every available source was searched at least once.",
    "",
    eventPayload
      ? `All items (compact):\n${JSON.stringify(eventPayload)}`
      : "Use the summary above; the registry is too large to inline.",
    "",
    "Report contradictions, unsupported claims, silences, unanswered questions, and never-searched angles.",
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
