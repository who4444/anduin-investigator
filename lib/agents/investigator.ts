import { extractJson, isPlainObject } from "../json";
import { toUtcIso } from "../ingest/normalize";
import { getLlmClient, runToolLoop } from "../llm";
import { issuePromptBlock, resolveIssueId } from "../pipeline/issues";
import { scopePromptLine, splitEventsByScope } from "../pipeline/scope";
import { buildVocabularyDigest, renderVocabularyDigest } from "../pipeline/vocabulary";
import {
  appendStageLog,
  getClaims,
  getEvents,
  getInvestigation,
  getIssues,
  insertClaims,
  insertGaps,
} from "../store";
import type { Claim, ClaimInput, ClaimStatus, GapInput, Issue } from "../types";
import { sampleEvents, summarizeEvents } from "./summary";
import { buildAgentTools } from "./tools";

export type InvestigatorKind = "root_cause" | "commitments" | "ownership";

const INVESTIGATOR_KINDS: InvestigatorKind[] = ["root_cause", "commitments", "ownership"];
const MAX_ROUNDS = 10;
const ARG_PREVIEW_LIMIT = 120;

function truncateArgs(args: Record<string, unknown>): Record<string, string> {
  const truncated: Record<string, string> = {};
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    truncated[key] = text.length > ARG_PREVIEW_LIMIT ? `${text.slice(0, ARG_PREVIEW_LIMIT)}…` : text;
  }
  return truncated;
}

function previewCount(preview: string | undefined): number | undefined {
  if (!preview) return undefined;
  const match = preview.match(/"count"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}
const CLAIM_STATUSES: ClaimStatus[] = ["kept", "broken", "unclear", "n/a"];

const KIND_LABELS: Record<InvestigatorKind, string> = {
  root_cause: "root cause",
  commitments: "commitments",
  ownership: "decisions and ownership",
};

const KIND_MISSIONS: Record<InvestigatorKind, string> = {
  root_cause:
    "Establish what actually went wrong technically: the change or event that caused the problem, when it first appeared, and which fixes were attempted or failed.",
  commitments:
    "Establish every promise made (who promised what, to whom, and by when) and whether it was kept. Record each promise with submit_commitment (not submit_claim): give the promisor (actor) and the promisee (to) when the record states them, what was promised as a short date-less object, the deadline exactly as stated (omit if none), your status with a one-sentence rationale, and fulfilment_item_ids when a record shows the object was delivered. Submit one commitment per source record that states the promise — code merges restatements into a single row. A QA report, a leave notice or a merge note is not a promise. Set status to kept, broken, or unclear.",
  ownership:
    "Establish who decided and owned what: handoffs, escalations, unannounced changes, and messages that went unanswered (process failure).",
};

export interface InvestigatorResult {
  claims: Claim[];
  log: { round: number; name: string }[];
}

function claimKey(eventId: string, text: string): string {
  return `${eventId}|${text.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

function collectClaims(content: string, agent: string, issues: Issue[]): ClaimInput[] {
  const parsed = extractJson(content);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.claims)) return [];

  const claims: ClaimInput[] = [];
  for (const raw of parsed.claims) {
    if (!isPlainObject(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type.trim() : "";
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    const quote = typeof raw.quote === "string" ? raw.quote : "";
    const eventId = typeof raw.event_id === "string" ? raw.event_id : undefined;
    const status = typeof raw.status === "string" ? raw.status : "";
    const confidence = typeof raw.confidence === "number" ? raw.confidence : Number.NaN;

    if (!type || !text || !quote || !eventId) continue;
    if (!CLAIM_STATUSES.includes(status as ClaimStatus)) continue;
    if (!Number.isFinite(confidence)) continue;

    claims.push({
      agent,
      type,
      text,
      actor: typeof raw.actor === "string" ? raw.actor : undefined,
      quote,
      eventId,
      ts: typeof raw.ts === "string" && raw.ts.trim() ? toUtcIso(raw.ts) || undefined : undefined,
      status: status as ClaimStatus,
      confidence: Math.min(1, Math.max(0, confidence)),
      issueId: resolveIssueId(raw.issue_id ?? raw.issueId, text, issues),
    });
  }
  return claims;
}

function collectNotes(content: string, kind: InvestigatorKind, issues: Issue[]): GapInput[] {
  const parsed = extractJson(content);
  if (!isPlainObject(parsed) || !Array.isArray(parsed.notes)) return [];

  const notes: GapInput[] = [];
  for (const raw of parsed.notes) {
    const text = typeof raw === "string" ? raw : isPlainObject(raw) ? raw.note : undefined;
    if (typeof text !== "string" || text.trim().length === 0) continue;
    const eventIds =
      isPlainObject(raw) && Array.isArray(raw.event_ids)
        ? raw.event_ids.filter((id): id is string => typeof id === "string")
        : [];
    notes.push({
      question: isPlainObject(raw) && typeof raw.question === "string" ? raw.question : `Could not determine (${KIND_LABELS[kind]})`,
      note: text.trim(),
      eventIds,
      issueId: resolveIssueId(
        isPlainObject(raw) ? raw.issue_id ?? raw.issueId : undefined,
        text.trim(),
        issues,
      ),
    });
  }
  return notes;
}

export async function runInvestigator(
  investigationId: string,
  kind: InvestigatorKind,
  plan: string,
  pass = 1,
): Promise<InvestigatorResult> {
  if (!INVESTIGATOR_KINDS.includes(kind)) {
    throw new Error(`Unknown investigator kind: ${kind}`);
  }

  const tools = buildAgentTools(investigationId, kind);
  const events = await getEvents(investigationId);
  const investigation = await getInvestigation(investigationId);
  const issues = await getIssues(investigationId);
  const scopeLine = scopePromptLine(investigation?.scope ?? null);
  // Prompts see only in-scope records, matching what the tools can return.
  const { inScope } = splitEventsByScope(events, investigation?.scope ?? null);
  const digest = renderVocabularyDigest(buildVocabularyDigest(inScope));
  const issueBlock = issuePromptBlock(issues);

  const system = [
    `You are the ${KIND_LABELS[kind]} investigator on an incident investigation.`,
    KIND_MISSIONS[kind],
    "Work only from the Evidence Registry: every finding must be backed by an item you have read.",
    "Read widely with the source tools — search_jira, get_issue, search_slack, get_slack_thread, search_email, get_email_thread — then call verify_quote to confirm a quote before submitting a claim.",
    "Call submit_claim for each finding. Quote the original text verbatim (copy it exactly; whitespace differences are fine, wording changes are not).",
    ...(issueBlock ? [issueBlock] : []),
    "Never invent events, people, dates, or messages. If something cannot be established from the records, put it in notes instead of claiming it.",
  ].join("\n");

  const user = [
    "Investigation plan:",
    plan,
    ...(scopeLine ? ["", scopeLine] : []),
    ...(digest ? ["", "Vocabulary observed in the records (use these exact terms when searching):", digest] : []),
    ...(issueBlock ? ["", issueBlock] : []),
    "",
    "Evidence Registry summary:",
    summarizeEvents(inScope),
    "",
    "Evenly spaced sample of items (use the tools for the rest):",
    JSON.stringify(sampleEvents(inScope, 10)),
    "",
    "Submit each finding with submit_claim (quote must be an exact substring of the cited event) and set issue_id.",
    'When done, reply with JSON only: {"claims":[],"notes":["things you could not determine"]} — claims already submitted need not be repeated.',
  ].join("\n");

  const claimsBefore = (await getClaims(investigationId)).filter((claim) => claim.agent === kind).length;
  const { content, log } = await runToolLoop({
    client: getLlmClient(),
    system,
    user,
    tools: tools.specs,
    exec: tools.exec,
    maxRounds: MAX_ROUNDS,
  });
  const toolLog = log.map((entry) => ({
    round: entry.round,
    name: entry.name,
    args: truncateArgs(entry.args),
    resultCount: previewCount(entry.resultPreview),
  }));

  const existing = await getClaims(investigationId);
  const submittedDuringLoop = existing.filter((claim) => claim.agent === kind).length > claimsBefore;

  // If the tool budget ran out before anything was submitted, force one final
  // structured reply so the investigation still yields findings.
  let finalContent = content;
  if (!submittedDuringLoop) {
    try {
      const forced = await getLlmClient().chat(
        [
          { role: "system", content: system },
          { role: "user", content: user },
          {
            role: "user",
            content:
              'You have reached the tool-call limit. Do not call tools. Reply with JSON only: {"claims":[],"notes":[]} using evidence you have already read, citing item ids you have seen and setting issue_id on every claim and note.',
          },
        ],
        { forceJson: true },
      );
      // Merge the forced reply into the loop content as JSON — string
      // concatenation of two objects no longer parses.
      const forcedParsed = extractJson(forced.content);
      if (isPlainObject(forcedParsed)) {
        const baseParsed = extractJson(finalContent);
        if (!isPlainObject(baseParsed)) {
          finalContent = forced.content;
        } else {
          const merge = (key: string): unknown[] => [
            ...(Array.isArray(baseParsed[key]) ? (baseParsed[key] as unknown[]) : []),
            ...(Array.isArray(forcedParsed[key]) ? (forcedParsed[key] as unknown[]) : []),
          ];
          finalContent = JSON.stringify({ claims: merge("claims"), notes: merge("notes") });
        }
      }
    } catch {
      // The loop's own content is still parsed below.
    }
  }

  const existingKeys = new Set(
    existing.filter((claim) => claim.agent === kind).map((claim) => claimKey(claim.eventId, claim.text)),
  );

  const finalClaims = collectClaims(finalContent, kind, issues).filter(
    (claim) => !existingKeys.has(claimKey(claim.eventId, claim.text)),
  );
  if (finalClaims.length > 0) {
    await insertClaims(investigationId, finalClaims);
  }

  const notes = collectNotes(finalContent, kind, issues);
  if (notes.length > 0) {
    await insertGaps(investigationId, notes);
  }

  await appendStageLog(investigationId, kind, pass, {
    rounds: toolLog.length,
    toolCalls: toolLog,
    notes: notes.length,
    issues: issues.length,
    unassigned: (await getClaims(investigationId)).filter(
      (claim) => claim.agent === kind && !claim.issueId,
    ).length,
  });

  const claims = (await getClaims(investigationId)).filter((claim) => claim.agent === kind);
  return { claims, log: toolLog };
}

export { INVESTIGATOR_KINDS };
