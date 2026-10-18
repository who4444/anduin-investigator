import { extractJson, isPlainObject } from "../json";
import { getLlmClient } from "../llm";
import {
  getClaims,
  getCommitments,
  getEvents,
  getInvestigation,
  getIssues,
  upsertIssueReportExtras,
  upsertReportExtras,
} from "../store";
import { NEGATIVE_VERIFY_ERRORS } from "../pipeline/negative";
import { clientDomainsFor, clientEvidenceFor } from "../pipeline/scope";
import { buildCaseState, type CaseState } from "../report/case-state";
import type {
  Claim,
  InvestigationScope,
  Issue,
  ReplyLabel,
  ReplyPayload,
  ReplySentence,
} from "../types";

export interface ReplyDraft extends ReplyPayload {
  verdict: string;
}

/** E2(f): the model produced no sentence that a verified, client-safe fact
    backs. The route surfaces this as a 422 with the explicit reason, never a
    generic apology or an empty draft. */
export class ReplyNotDraftableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplyNotDraftableError";
  }
}

const MAX_SENTENCES = 8;
const MAX_VERDICT_CHARS = 240;

const SYSTEM_PROMPT = [
  "You are the incident investigator drafting the client reply for a manager to review.",
  "Use ONLY the verified findings listed below. Never add facts, names, dates or numbers that are not in them.",
  "State what happened and what is being done. Include a next step or date only when a cited finding states it. No internal QA, blame or process narration; no speculation; no apology for named people.",
  'Reply with JSON only: {"verdict":"one sentence for the internal header","sentences":[{"text":"one client-facing sentence","claimIds":["..."]}]}.',
  "Every sentence must cite at least one finding id from the list. Every number or date in a sentence must come from that sentence's cited findings. Keep it under eight sentences.",
].join("\n");

const NUMBER_TOKEN = /\b\d[\d.,:%/-]*\b/g;

/* G-06 + E2(a): words that assert "now". A sentence may only use them when
   the computed case state carries them — never merely because a cited quote
   used the word historically. */
const STATUS_TALK =
  /\b(resolved|re-?opened|closed|fixed|shipped|delivered|released|in[- ]progress|done|live|deployed|open|being investigated|under investigation|investigating|verifying|verification|fixing)\b/gi;
const OWNER_TALK = /\b(owner|owns|owned by|assigned to|handed off to|handed to|reassigned)\b/i;

/* E2(b): forward-looking language. A sentence that promises or schedules must
   be backed by a cited record that states the same commitment. */
const COMMITMENT_TOKENS =
  /\b(will|shall|we(?:'|’)ll|promise[ds]?|commit(?:ted|s|ment)?|scheduled|reschedul\w*|plan(?:ned|s)?\s+to|next\s+(?:week|month|quarter)|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi;

/* E2(d): internal QA and process narration is never client copy. */
const TONE_TALK =
  /\b(QA\b|resolution proceeded|the team'?s rule|process (?:failure|gap)|internal (?:decision|note|process)|never searched|coverage (?:was|is)|we searched|skeptic|post-?mortem|retro(?:spective)?)\b/i;

function numbersIn(text: string): string[] {
  return [...new Set(text.match(NUMBER_TOKEN) ?? [])];
}

function normalizeStatusWord(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** E2(a): the status/fix truth the sentence must match NOW. Built from the
    computed case state, never from a historical quote. */
function statusContext(caseState: CaseState): string {
  const parts: string[] = [];
  if (caseState.currentStatus.known) parts.push(caseState.currentStatus.value);
  if (caseState.latestFix.known) {
    parts.push(caseState.latestFix.value.text);
    if (caseState.latestFix.value.label) parts.push(caseState.latestFix.value.label);
  }
  if (caseState.fixCheck.known) parts.push(caseState.fixCheck.value);
  return normalizeStatusWord(parts.join(" "));
}

export interface ReplyEligibilityInput {
  scope: InvestigationScope | null;
  claims: Claim[];
  issues: Issue[];
  issueId?: string | null;
  excludedClientRecords?: number;
  /** F5: several tenant clusters and no resolved client seed. */
  crossTenant?: boolean;
}

/** E1: a client reply may be drafted only from a resolved client, a named
    scope and at least one verified client-safe fact; a multi-issue run needs
    an explicit issue id. Returns the specific reason when blocked. */
export function replyEligible(input: ReplyEligibilityInput): {
  eligible: boolean;
  reason: string | null;
} {
  const blocked = (reason: string) => ({ eligible: false, reason });
  const excluded = input.excludedClientRecords ?? 0;
  if (excluded > 0) {
    return blocked(
      `Client evidence is excluded from this investigation (${excluded} record${excluded === 1 ? "" : "s"}). A reply could contradict records that were never searched, so drafting is blocked until the scope is resolved.`,
    );
  }

  if (input.crossTenant) {
    return blocked(
      "This export contains more than one candidate engagement and the escalation does not identify which one. Confirm the engagement before drafting a reply.",
    );
  }

  const issueId = input.issueId?.trim() || null;
  const multi = input.issues.length > 1;
  if (issueId && !input.issues.some((issue) => issue.id === issueId)) {
    return blocked("No issue with that id belongs to this investigation.");
  }
  if (multi && !issueId) {
    return blocked(
      "This escalation has multiple independent issues. Open an issue tab and draft its reply there; the combined view mixes issues.",
    );
  }

  const scope = input.scope;
  if (!scope || !scope.client || scope.confidence === "none") {
    return blocked(
      "The client is not identified from the escalation or the records. Confirm the client before drafting a reply.",
    );
  }
  const projectNamed =
    Boolean(scope.project) || scope.ticketPrefixes.length > 0 || scope.channels.length > 0;
  if (!projectNamed) {
    return blocked(
      "The project or scope is not named. Confirm which project this escalation concerns before drafting a reply.",
    );
  }

  const scopedClaims = issueId
    ? input.claims.filter((claim) => claim.issueId === issueId)
    : input.claims;
  const clientSafeFacts = scopedClaims.filter(
    (claim) =>
      claim.verifyStatus === "verified" &&
      !claim.skepticFlag &&
      !claim.review &&
      !NEGATIVE_VERIFY_ERRORS.has(claim.verifyError ?? ""),
  );
  if (clientSafeFacts.length === 0) {
    return blocked(
      "No verified, client-safe finding is available for this reply yet. Run verification and review the findings before drafting.",
    );
  }

  return { eligible: true, reason: null };
}

/** E2(e): the sign-off names the project's support team, never the product
    brand, and never the client. */
export function signOffFor(scope: InvestigationScope | null): string {
  const project = scope?.project?.replace(/\s+/g, " ").trim() ?? "";
  const vendor = project.split(/\s+/)[0] ?? "";
  return vendor ? `Best regards,\n${vendor} Support` : "Best regards,\nSupport team";
}

export function validateReplyPayload(
  content: string,
  knownClaimIds: Set<string>,
  claimsById?: Map<string, { text: string; quote: string; type?: string; status?: string }>,
  caseState?: CaseState | null,
): { verdict: string; sentences: ReplySentence[] } | null {
  const parsed = extractJson(content);
  if (!isPlainObject(parsed)) return null;

  const verdict =
    typeof parsed.verdict === "string" ? parsed.verdict.trim().slice(0, MAX_VERDICT_CHARS) : "";

  const rawSentences = Array.isArray(parsed.sentences) ? parsed.sentences : [];
  const sentences: ReplySentence[] = [];
  for (const raw of rawSentences) {
    if (!isPlainObject(raw)) continue;
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!text) continue;
    const claimIds = Array.isArray(raw.claimIds)
      ? raw.claimIds.filter(
          (id): id is string => typeof id === "string" && knownClaimIds.has(id),
        )
      : [];
    if (claimIds.length === 0) continue;

    // A sentence may not introduce numbers or dates its findings don't state:
    // this is the copy-paste-to-client surface, so it cannot outrun its quotes.
    if (claimsById) {
      const allowed = new Set<string>();
      for (const id of claimIds) {
        const source = claimsById.get(id);
        if (source) {
          for (const number of numbersIn(`${source.text} ${source.quote}`)) {
            allowed.add(number);
          }
        }
      }
      if (numbersIn(text).some((number) => !allowed.has(number))) continue;
    }

    // E2(d): internal QA/process narration never reaches client copy.
    if (TONE_TALK.test(text)) continue;

    // E2(b): a promise/schedule sentence must cite a record that states the
    // same commitment — the sentence's own cues must appear in the cited text.
    if (claimsById) {
      const cues = [...new Set((text.match(COMMITMENT_TOKENS) ?? []).map((cue) => cue.toLowerCase()))];
      if (cues.length > 0) {
        const backed = claimIds
          .map((id) => claimsById.get(id))
          .filter((source): source is { text: string; quote: string } => Boolean(source))
          .map((source) => `${source.text} ${source.quote}`.toLowerCase())
          .join(" ");
        if (cues.some((cue) => !backed.includes(cue))) continue;
      }
    }

    // G-06 + E2(a,c): the sentence cannot assert a status or an owner the
    // computed case state does not carry NOW.
    if (caseState) {
      const context = statusContext(caseState);
      const statusWords = text.match(STATUS_TALK) ?? [];
      if (statusWords.some((word) => !context.includes(normalizeStatusWord(word)))) continue;
      if (OWNER_TALK.test(text)) {
        const owner = caseState.owner.value?.toLowerCase() ?? null;
        if (!owner || !text.toLowerCase().includes(owner)) continue;
      }
    }

    sentences.push({ text, claimIds });
    if (sentences.length >= MAX_SENTENCES) break;
  }

  if (sentences.length === 0) return null;
  return { verdict, sentences };
}

/* A stored reply was validated at draft time; findings can degrade later.
   Re-check every sentence against the CURRENT verification state: a sentence
   survives only when every claim it cites is still verified and unflagged. */
export function pruneStaleReply(
  reply: ReplyPayload | null | undefined,
  claims: Claim[],
): ReplyPayload | null {
  if (!reply) return null;
  const state = new Map(claims.map((claim) => [claim.id, claim]));
  const sentences = reply.sentences.filter((sentence) =>
    sentence.claimIds.every((id) => {
      const claim = state.get(id);
      return claim?.verifyStatus === "verified" && !claim.skepticFlag && !claim.review;
    }),
  );
  return sentences.length > 0 ? { ...reply, sentences } : null;
}

function firstClientName(
  events: Awaited<ReturnType<typeof getEvents>>,
  investigation: Awaited<ReturnType<typeof getInvestigation>>,
): string | null {
  const evidence = clientEvidenceFor(events, investigation?.scope ?? null);
  if (evidence.actors.length === 0 && evidence.domains.length === 0) return null;
  const names = new Set(evidence.actors);
  const domains = new Set(evidence.domains);
  const isClient = (event: (typeof events)[number]) => {
    const actor = event.actorResolved ?? event.actor;
    const domain = actor.match(/@([A-Za-z0-9.-]+)/)?.[1]?.toLowerCase();
    if (domain && domains.has(domain)) return true;
    const normalized = actor
      .replace(/<[^>]*>/g, " ")
      .toLowerCase()
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ");
    return names.has(normalized);
  };
  const clientEvents = events.filter(isClient);
  const last = clientEvents[clientEvents.length - 1];
  if (!last) return null;
  const display = (last.actorResolved ?? last.actor).replace(/<[^>]*>/g, "").trim();
  return display.split(/\s+/)[0] || null;
}

function sentenceLabel(text: string, claimText: string): ReplyLabel {
  const addsCommitment =
    /\b(will|shall|promise|commit|scheduled|by (?:the )?[\w.-]+|next (?:week|month)|tomorrow|we are treating|plan to)\b/i.test(
      text,
    );
  if (addsCommitment && !/\b(will|shall|promise|commit|scheduled|tomorrow|next (?:week|month))\b/i.test(claimText)) {
    return "needs-check";
  }
  // G-03: a negative cannot enter the client pack as plain safe copy unless
  // the sentence is not an absence assertion; label it for a human check.
  if (/\b(?:not resolved|did not|does not|no (?:reply|response|confirmation)|unanswered|never|absent|missing)\b/i.test(text)) {
    return "needs-check";
  }
  return "safe";
}

export async function generateReply(
  investigationId: string,
  issueId?: string | null,
): Promise<ReplyDraft> {
  const allClaims = await getClaims(investigationId);
  let issue: Issue | null = null;
  if (issueId) {
    issue = (await getIssues(investigationId)).find((candidate) => candidate.id === issueId) ?? null;
    if (!issue) throw new Error("No issue with that id belongs to this investigation.");
  }
  const claims = issueId
    ? allClaims.filter((claim) => claim.issueId === issueId)
    : allClaims;
  const verified = claims.filter(
    (claim) => claim.verifyStatus === "verified" && !claim.skepticFlag && !claim.review,
  );
  if (verified.length === 0) {
    throw new Error(
      issue
        ? "No verified findings for this issue yet — run verification before drafting a reply."
        : "No verified findings yet — run verification before drafting a reply.",
    );
  }

  const events = await getEvents(investigationId);
  const eventsById = new Map(events.map((event) => [event.id, event]));

  // G-06: the computed "now" bounds what the draft may assert.
  const [investigation, commitments] = await Promise.all([
    getInvestigation(investigationId),
    getCommitments(investigationId),
  ]);
  const clientEvidence = clientEvidenceFor(events, investigation?.scope ?? null);
  const caseState = buildCaseState({
    events,
    claims: allClaims,
    commitments,
    clientDomains: clientDomainsFor(events, investigation?.scope ?? null),
    clientActors: clientEvidence.actors,
  });

  const payload = verified.map((claim) => ({
    id: claim.id,
    type: claim.type,
    status: claim.status,
    text: claim.text,
    source: eventsById.get(claim.eventId)?.source ?? null,
    ts: eventsById.get(claim.eventId)?.ts ?? claim.ts ?? null,
  }));

  const issueContext = issue
    ? [
        `This draft is only for one of several independent issues in the escalation.`,
        `Issue: ${issue.title}`,
        issue.ask ? `The client asks: ${issue.ask}` : "",
        "Do not mention or fold in findings from the other issues.",
      ]
        .filter(Boolean)
        .join("\n")
    : "";

  const response = await getLlmClient().chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          ...(issueContext ? [issueContext, ""] : []),
          "Verified findings:",
          JSON.stringify(payload),
          "",
          "Write the verdict line and the client reply sentences now.",
        ].join("\n"),
      },
    ],
    { forceJson: true },
  );

  const known = new Set(verified.map((claim) => claim.id));
  const claimsById = new Map(
    verified.map((claim) => [claim.id, { text: claim.text, quote: claim.quote }]),
  );
  const validated = validateReplyPayload(response.content, known, claimsById, caseState);
  if (!validated) {
    throw new ReplyNotDraftableError(
      "No sentence in the draft could be tied to a verified, client-safe finding, so no reply was produced. Review the findings and try again.",
    );
  }

  const broken = verified.filter(
    (claim) => claim.type === "commitment" && claim.status === "broken",
  ).length;
  const fallbackVerdict = `${verified.length} verified findings${
    broken > 0 ? `, ${broken} broken commitment${broken === 1 ? "" : "s"}` : ""
  }.`;

  const verdict = validated.verdict || fallbackVerdict;
  const verifiedById = new Map(verified.map((claim) => [claim.id, claim]));
  const sentences: ReplySentence[] = validated.sentences.map((sentence) => {
    const citedText = sentence.claimIds
      .map((id) => verifiedById.get(id)?.text ?? "")
      .join(" ");
    return { ...sentence, label: sentenceLabel(sentence.text, citedText) };
  });
  const contact = firstClientName(events, investigation);
  const greeting = contact ? `Hi ${contact},` : "Hello,";
  const signOff = signOffFor(investigation?.scope ?? null);
  const reply: ReplyPayload = { greeting, sentences, signOff, approved: false };
  if (issue) {
    await upsertIssueReportExtras(investigationId, issue.id, { verdict, reply });
  } else {
    await upsertReportExtras(investigationId, { verdict, reply });
  }
  return { verdict, ...reply };
}
