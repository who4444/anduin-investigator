import { getLlmClient } from "../llm";
import { deriveDateWindow, latestEventTs, parsePlanData, renderPlan, validateDateWindow } from "../pipeline/plan";
import { scopePromptLine, splitEventsByScope } from "../pipeline/scope";
import { buildVocabularyDigest, renderVocabularyDigest } from "../pipeline/vocabulary";
import {
  appendStageLog,
  getEvents,
  getInvestigation,
  savePlanIssues,
  setPlan,
  setPlanData,
} from "../store";
import type { IssueInput, PlanData } from "../types";
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
  "First decide how many INDEPENDENT issues the escalation contains. Most escalations contain exactly ONE issue, even when the client is angry and mentions a failed fix, a closed ticket, unanswered messages, an SLA or contractual consequence, or several teams.",
  "Create more than one only when the client describes different problems that need different fixes or different owners (for example, blank invoice totals AND SSO login failures). Never create a separate issue for: the root cause, a failed fix or release, a premature resolution, unanswered messages or a communication failure, an SLA/contractual consequence, or a promise. Those are facets of the issue and belong inside it as findings.",
  "Ask: could one fix and one owner resolve all of the client's asks? If yes, it is one issue. An issue title is the client-visible problem, not an internal process failure or a legal risk. Cap at three; if there are more than three genuinely independent problems, list the three most material and set issueOverflow to the number not listed.",
  "Give each issue a short title, the client's ask for that issue, a one-sentence summary, and a confidence. Use the exact product/ticket terms from the digest.",
  "Do not state findings or answers; you are planning what to look for.",
].join("\n");

const RESPONSE_SCHEMA = [
  "Reply with JSON only:",
  '{"issues":[{"title":"...","ask":"...","summary":"...","confidence":0.8}],"issueOverflow":0,"framing":"one short paragraph","hypotheses":[{"statement":"...","test":"...","falsify":"..."}],"sources":[{"source":"jira|email|slack","approach":"..."}],"searchTerms":["..."],"people":["..."],"dateWindow":{"from":"YYYY-MM-DD or null","to":"YYYY-MM-DD or null"},"unknowns":["..."]}',
].join("\n");

function defaultIssue(escalation: string, planData: PlanData | null): IssueInput {
  const flat = escalation.replace(/\s+/g, " ").trim();
  const firstSentence = flat.split(/[.!?\n]/)[0]?.trim() ?? "";
  return {
    title: (firstSentence || "The escalation").slice(0, 90),
    ask:
      flat.slice(0, 600) ||
      "Explain what happened, who owned it, what was promised, and when it will be fixed.",
    summary: planData?.framing ?? "",
    confidence: 0.5,
  };
}

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
  // I5: anchor relative phrases to the latest record, not the wall clock —
  // a 2024 workspace must plan in 2024 even when the run happens in 2026.
  const recordReference = latestEventTs(events) ?? investigation?.createdAt ?? new Date().toISOString();
  const window = deriveDateWindow(escalation, recordReference);

  const user = [
    escalation.trim()
      ? `Escalation from the client:\n${escalation.trim()}`
      : "No escalation text was provided. Infer the likely escalation from the records themselves.",
    ...(scopeLine ? ["", scopeLine] : []),
    ...(digest ? ["", "Vocabulary observed in the records (use these exact terms):", digest] : []),
    ...(window.from
      ? [``, `The escalation's own phrasing points at activity since ${window.from} (relative to the latest record, ${recordReference.slice(0, 10)}).`]
      : []),
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
  const parsed = parsePlanData(response.content);
  // I5: a model window wholly outside the records is speculation; drop it.
  const planData = parsed
    ? { ...parsed, dateWindow: validateDateWindow(parsed.dateWindow, events) }
    : null;
  const plan = planData ? renderPlan(planData) : response.content.trim() || DEFAULT_PLAN;

  // G-23: persist the independent issues. A free-text plan still gets one
  // issue so every claim has a home and the report can stay issue-aware.
  const proposed = planData?.issues.length ? planData.issues : [defaultIssue(escalation, planData)];
  const issues = await savePlanIssues(investigationId, proposed);

  await setPlanData(investigationId, planData);
  await setPlan(investigationId, plan);
  await appendStageLog(investigationId, "plan", pass, {
    eventCount: events.length,
    planChars: plan.length,
    structured: planData !== null,
    issues: issues.length,
    issueOverflow: planData?.issueOverflow ?? 0,
  });

  return plan;
}
