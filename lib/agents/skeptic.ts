import { extractJson, isPlainObject } from "../json";
import { getLlmClient } from "../llm";
import {
  appendStageLog,
  getClaims,
  getCommitments,
  getEvents,
  getInvestigation,
  getStages,
  insertGaps,
  insertSkepticNotes,
  setClaimSkepticFlag,
} from "../store";
import type { SkepticNoteInput, SkepticNoteKind, GapInput } from "../types";
import { buildCoverage } from "../pipeline/coverage";
import { latestEventTs } from "../pipeline/plan";
import { scopePromptLine, splitEventsByScope, clientDomainsFor } from "../pipeline/scope";
import { detectContradictions } from "../report/contradictions";
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

interface ResolvedIssue {
  kind: SkepticNoteKind;
  claimId?: string;
  text: string;
  eventIds: string[];
}

function resolveIssues(
  issues: { kind: SkepticNoteKind; claimIndex?: number; text: string; eventIds: string[] }[],
  claims: { id: string }[],
): ResolvedIssue[] {
  return issues.map((issue) => ({
    kind: issue.kind,
    claimId: issue.claimIndex !== undefined ? claims[issue.claimIndex]?.id : undefined,
    text: issue.text,
    eventIds: issue.eventIds,
  }));
}

function indexClaims(claims: { id: string; agent: string; type: string; text: string; quote: string; eventId: string; status: string; confidence: number; verifyStatus: string }[]) {
  return claims.map((claim, index) => ({
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
}

export async function runSkeptic(investigationId: string, pass = 1): Promise<SkepticResult> {
  const claims = await getClaims(investigationId);
  const events = await getEvents(investigationId);
  const commitments = await getCommitments(investigationId);
  const investigation = await getInvestigation(investigationId);
  const scopeLine = scopePromptLine(investigation?.scope ?? null);
  const { inScope } = splitEventsByScope(events, investigation?.scope ?? null);

  if (claims.length === 0) {
    await appendStageLog(investigationId, "skeptic", pass, { flagged: 0, issues: 0, note: "no claims to review" });
    return { flagged: 0, issues: 0 };
  }

  // I4: deterministic detectors are the source of truth for contradictions. The
  // checklist goes into the prompt so a single pass cannot return a false clean
  // bill of health, and a detector firing gates one focused second pass.
  // Review I5: client evidence is the VERIFIED list — the scope's raw sender
  // domains include the vendor's correspondence domain.
  const detectorAsOf = latestEventTs(inScope) ?? investigation?.createdAt ?? "";
  const detectorDomains = clientDomainsFor(inScope, investigation?.scope ?? null);
  const detectors = detectContradictions({
    events: inScope,
    claims,
    promises: commitments,
    asOf: detectorAsOf,
    clientEvidence:
      detectorDomains.length > 0
        ? {
            domains: detectorDomains,
            actors: [],
            channels: [],
            threads: [],
            eventIds: [],
          }
        : undefined,
  });
  const detectorLines = detectors.map(
    (contradiction) => `- [${contradiction.severity}] ${contradiction.managerText}`,
  );
  const checkedList =
    detectorLines.length > 0
      ? `Deterministic checks already fired (facts, not opinions — do not overturn them; find what they miss):\n${detectorLines.join("\n")}`
      : "Deterministic checks run in code before you: none fired. A single pass finding nothing is not proof the records are consistent.";

  const indexedClaims = indexClaims(claims);

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
        .map((entry) => ({
          source: entry.source,
          queries: entry.queries,
          ...(entry.excluded > 0 ? { excluded: entry.excluded } : {}),
        })),
    ),
    ...(coverage.sources.some((entry) => entry.failedQueries.length > 0)
      ? [
          "Attempted but FAILED (the tool returned an error instead of counts):",
          JSON.stringify(
            coverage.sources
              .filter((entry) => entry.failedQueries.length > 0)
              .map((entry) => ({ source: entry.source, failed: entry.failedQueries })),
          ),
          "Treat failed angles as NOT searched and raise an issue for them.",
        ]
      : []),
    coverage.neverSearched.length > 0
      ? `Available but NEVER searched: ${coverage.neverSearched.join(", ")} — raise an "unanswered" issue naming what should have been searched.`
      : "Every available source was searched at least once.",
    "",
    eventPayload
      ? `All items (compact):\n${JSON.stringify(eventPayload)}`
      : "Use the summary above; the registry is too large to inline.",
    "",
    checkedList,
    "",
    "Report contradictions, unsupported claims, silences, unanswered questions, and never-searched angles.",
    'If you find nothing, return {"issues":[]}; the report says "no contradiction found in the records searched", never that the records are complete.',
  ].join("\n");

  const client = getLlmClient();
  let content = "";
  let degraded = false;
  try {
    const response = await client.chat(
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

  const firstIssues = degraded ? [] : collectIssues(content);
  const resolved = resolveIssues(firstIssues, claims);

  // I4: one focused second pass over the top claims only when a detector fired
  // or the first pass found nothing — never more than one extra call.
  const shouldRefocus = firstIssues.length === 0 || detectors.length > 0;
  let secondPass = false;
  let secondDegraded = false;
  if (shouldRefocus) {
    secondPass = true;
    const topClaims = [...claims].sort((a, b) => b.confidence - a.confidence).slice(0, 6);
    const topUser = [
      "Focused second pass. The first pass returned nothing decisive.",
      "Examine ONLY the top claims and the deterministic checklist below; do not introduce new findings.",
      "Top claims (index is how to reference them here):",
      JSON.stringify(indexClaims(topClaims)),
      "",
      checkedList,
      "",
      'Reply with JSON only: {"issues":[{"kind":"contradiction|unsupported|silence|unanswered","claim_index":0,"text":"...","event_ids":["..."]}]}. If you still find nothing, return {"issues":[]}.',
    ].join("\n");
    try {
      const response = await client.chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: topUser },
        ],
        { forceJson: true },
      );
      resolved.push(...resolveIssues(collectIssues(response.content), topClaims));
    } catch {
      secondDegraded = true;
    }
  }

  const seen = new Set<string>();
  const merged = resolved.filter((issue) => {
    const key = `${issue.kind}|${issue.claimId ?? ""}|${issue.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  /* A skeptic note's category follows its subject, not its detector: a silent
     ticket is state/technical, a handoff thread is ownership, a client chase
     is communication. Keeps the gaps section's themes honest. */
  function gapCategoryFor(text: string): GapInput["category"] {
    if (/\b(?:handoff|hand over|handed|on leave|assignee|owner|ownership|reassign)\b/i.test(text)) {
      return "ownership";
    }
    if (/\b(?:root cause|refactor|regression|rounding|migration|deploy|release|build|code|ticket)\b/i.test(text)) {
      return "technical";
    }
    if (/\b(?:client|email|reply|respond|chase|follow(?:ed)? up|silent|silence|no response)\b/i.test(text)) {
      return "communication";
    }
    if (/\b(?:status|resolved|closed|reopened)\b/i.test(text)) {
      return "state";
    }
    return "other";
  }

  const notes: SkepticNoteInput[] = [];
  const gaps: GapInput[] = [];
  const flaggedClaimIds = new Set<string>();

  for (const issue of merged) {
    if (issue.claimId) flaggedClaimIds.add(issue.claimId);
    notes.push({
      claimId: issue.claimId,
      kind: issue.kind,
      text: issue.text,
      eventIds: issue.eventIds,
    });
    if (issue.kind === "silence" || issue.kind === "unanswered") {
      // C6: skeptic gaps carry a structured category. An unanswered client
      // chase is communication; a silent record or an open technical thread
      // is not — derive it from what the note is about.
      gaps.push({
        question: issue.text,
        note: issue.text,
        eventIds: issue.eventIds,
        category: issue.kind === "unanswered" ? "communication" : gapCategoryFor(issue.text),
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
    issues: merged.length,
    detectors: detectors.length,
    degraded,
    ...(secondPass ? { secondPass: { degraded: secondDegraded } } : {}),
  });

  return { flagged: flaggedClaimIds.size, issues: merged.length };
}
