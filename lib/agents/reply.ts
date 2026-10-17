import { extractJson, isPlainObject } from "../json";
import { getLlmClient } from "../llm";
import { getClaims, getEvents, getIssues, upsertIssueReportExtras, upsertReportExtras } from "../store";
import type { Claim, Issue } from "../types";

export interface ReplySentence {
  text: string;
  claimIds: string[];
}

export interface ReplyDraft {
  verdict: string;
  sentences: ReplySentence[];
}

const MAX_SENTENCES = 8;
const MAX_VERDICT_CHARS = 240;

const SYSTEM_PROMPT = [
  "You are the incident investigator drafting the client reply for a manager to review.",
  "Use ONLY the verified findings listed below. Never add facts, names, dates or numbers that are not in them.",
  "The reply must state what happened, what is being done, and a dated next step. No internal blame, no speculation, no apologies for named people.",
  'Reply with JSON only: {"verdict":"one sentence for the internal header","sentences":[{"text":"one client-facing sentence","claimIds":["..."]}]}.',
  "Every sentence must cite at least one finding id from the list. Every number or date in a sentence must come from that sentence's cited findings. Keep it under eight sentences.",
].join("\n");

const NUMBER_TOKEN = /\b\d[\d.,:%/-]*\b/g;

function numbersIn(text: string): string[] {
  return [...new Set(text.match(NUMBER_TOKEN) ?? [])];
}

export function validateReplyPayload(
  content: string,
  knownClaimIds: Set<string>,
  claimsById?: Map<string, { text: string; quote: string }>,
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
  reply: { sentences: ReplySentence[] } | null | undefined,
  claims: Claim[],
): { sentences: ReplySentence[] } | null {
  if (!reply) return null;
  const state = new Map(claims.map((claim) => [claim.id, claim]));
  const sentences = reply.sentences.filter((sentence) =>
    sentence.claimIds.every((id) => {
      const claim = state.get(id);
      return claim?.verifyStatus === "verified" && !claim.skepticFlag;
    }),
  );
  return sentences.length > 0 ? { sentences } : null;
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
    (claim) => claim.verifyStatus === "verified" && !claim.skepticFlag,
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
  const validated = validateReplyPayload(response.content, known, claimsById);
  if (!validated) {
    throw new Error("The draft reply did not cite any verified findings and was discarded.");
  }

  const broken = verified.filter(
    (claim) => claim.type === "commitment" && claim.status === "broken",
  ).length;
  const fallbackVerdict = `${verified.length} verified findings${
    broken > 0 ? `, ${broken} broken commitment${broken === 1 ? "" : "s"}` : ""
  }.`;

  const verdict = validated.verdict || fallbackVerdict;
  const reply = { sentences: validated.sentences };
  if (issue) {
    await upsertIssueReportExtras(investigationId, issue.id, { verdict, reply });
  } else {
    await upsertReportExtras(investigationId, { verdict, reply });
  }
  return { verdict, sentences: validated.sentences };
}
