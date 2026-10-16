import { extractJson, isPlainObject } from "../json";
import { getLlmClient } from "../llm";
import { getClaims, getEvents, upsertReportExtras } from "../store";

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
  "Every sentence must cite at least one finding id from the list. Keep it under eight sentences.",
].join("\n");

export function validateReplyPayload(
  content: string,
  knownClaimIds: Set<string>,
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
    sentences.push({ text, claimIds });
    if (sentences.length >= MAX_SENTENCES) break;
  }

  if (sentences.length === 0) return null;
  return { verdict, sentences };
}

export async function generateReply(investigationId: string): Promise<ReplyDraft> {
  const claims = await getClaims(investigationId);
  const verified = claims.filter((claim) => claim.verifyStatus === "kept");
  if (verified.length === 0) {
    throw new Error("No verified findings yet — run verification before drafting a reply.");
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

  const response = await getLlmClient().chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [
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
  const validated = validateReplyPayload(response.content, known);
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
  await upsertReportExtras(investigationId, { verdict, reply: { sentences: validated.sentences } });
  return { verdict, sentences: validated.sentences };
}
