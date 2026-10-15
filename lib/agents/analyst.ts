import { getLlmClient } from "../llm";
import { appendStageLog, getEvents, setPlan } from "../store";
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
  "You write the short investigation plan the investigators will work from.",
  "Base it only on the escalation and the event-store summary you are given.",
  "Output markdown: a one-paragraph framing plus 4-8 bullets split across root cause, commitments, and decisions/ownership.",
  "Keep it under 300 words. Do not state findings or answers; you are planning what to look for.",
].join("\n");

export async function runAnalyst(
  investigationId: string,
  escalation: string,
  pass = 1,
): Promise<string> {
  const events = await getEvents(investigationId);

  const user = [
    escalation.trim()
      ? `Escalation from the client:\n${escalation.trim()}`
      : "No escalation text was provided. Infer the likely escalation from the records themselves.",
    "",
    "Event store summary:",
    summarizeEvents(events),
    "",
    "Evenly spaced sample of events:",
    JSON.stringify(sampleEvents(events, 10)),
    "",
    "Write the investigation plan now.",
  ].join("\n");

  const response = await getLlmClient().chat([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ]);

  const plan = response.content.trim() || DEFAULT_PLAN;
  await setPlan(investigationId, plan);
  await appendStageLog(investigationId, "plan", pass, {
    eventCount: events.length,
    planChars: plan.length,
  });

  return plan;
}
