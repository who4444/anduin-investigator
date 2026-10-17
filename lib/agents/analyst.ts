import { getLlmClient } from "../llm";
import { deriveDateWindow, parsePlanData, renderPlan } from "../pipeline/plan";
import { scopePromptLine, splitEventsByScope } from "../pipeline/scope";
import { buildVocabularyDigest, renderVocabularyDigest } from "../pipeline/vocabulary";
import { appendStageLog, getEvents, getInvestigation, setPlan, setPlanData } from "../store";
import { sampleEvents, summarizeEvents } from "./summary";

const DEFAULT_PLAN = [
  "1. Build the cross-source timeline and note gaps in the record.",
  "2. Identify the technical root cause and when the problem first appeared.",
  "3. List every commitment made and whether it was kept.",
  "4. Establish ownership and handoffs, including unanswered messages.",
  "5. Record what the records cannot establish.",
].join("\n");

const SYSTEM_PROMPT = [
  "You are the issue analyst on a client-escalation investigation.",
  "You write the investigation plan the investigators will work from.",
  "Base it only on the escalation, the event-store summary and the vocabulary digest you are given.",
  "Propose hypotheses the investigators should test (each with how to test it and what would falsify it), which sources to search first and how, the seed search terms (include synonyms and the real internal terms from the digest), the people to look at, and a focus window when the escalation suggests one.",
  "Do not state findings or answers; you are planning what to look for.",
].join("\n");

const RESPONSE_SCHEMA = [
  "Reply with JSON only:",
  '{"framing":"one short paragraph","hypotheses":[{"statement":"...","test":"...","falsify":"..."}],"sources":[{"source":"jira|email|slack","approach":"..."}],"searchTerms":["..."],"people":["..."],"dateWindow":{"from":"YYYY-MM-DD or null","to":"YYYY-MM-DD or null"},"unknowns":["..."]}',
].join("\n");

export async function runAnalyst(
  investigationId: string,
  escalation: string,
  pass = 1,
): Promise<string> {
  const events = await getEvents(investigationId);
  const investigation = await getInvestigation(investigationId);
  const scopeLine = scopePromptLine(investigation?.scope ?? null);
  const { inScope } = splitEventsByScope(events, investigation?.scope ?? null);

  const digest = renderVocabularyDigest(buildVocabularyDigest(inScope));
  const window = deriveDateWindow(
    escalation,
    investigation?.createdAt ?? new Date().toISOString(),
  );

  const user = [
    escalation.trim()
      ? `Escalation from the client:\n${escalation.trim()}`
      : "No escalation text was provided. Infer the likely escalation from the records themselves.",
    ...(scopeLine ? ["", scopeLine] : []),
    ...(digest ? ["", "Vocabulary observed in the records (use these exact terms):", digest] : []),
    ...(window.from ? ["", `The escalation's own phrasing points at activity since ${window.from}.`] : []),
    "",
    "Event store summary:",
    summarizeEvents(inScope),
    "",
    "Evenly spaced sample of events:",
    JSON.stringify(sampleEvents(inScope, 10)),
    "",
    "Write the investigation plan now.",
    RESPONSE_SCHEMA,
  ].join("\n");

  const response = await getLlmClient().chat(
    [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: user },
    ],
    { forceJson: true },
  );

  // Structured plans are preferred; anything unusable degrades to free text.
  const planData = parsePlanData(response.content);
  const plan = planData ? renderPlan(planData) : response.content.trim() || DEFAULT_PLAN;

  await setPlanData(investigationId, planData);
  await setPlan(investigationId, plan);
  await appendStageLog(investigationId, "plan", pass, {
    eventCount: events.length,
    planChars: plan.length,
    structured: planData !== null,
  });

  return plan;
}
