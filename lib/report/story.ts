/* D1-D3: the answer-first story. Deterministic templates over the decision
   inputs — no model prose, no finding-type metadata, no severity-order
   chronology. Every sentence carries the finding ids behind it. */

export interface StorySentence {
  text: string;
  findingIds: string[];
}

export interface Story {
  sentences: StorySentence[];
  statsLine: string;
  nextStep: string | null;
  tooThin: boolean;
}

export interface StoryCauseInput {
  statement: string;
  ts: string;
  channel: string;
  state: "verified" | "supported" | "unverified";
  findingIds?: string[];
}

export interface StoryPromiseInput {
  promisor: string | null;
  promisee: string | null;
  object: string;
  deadlinePhrase: string | null;
  status: "kept" | "broken" | "unclear" | "withdrawn";
  findingIds?: string[];
}

export interface StoryStateFieldInput {
  known: boolean;
  value: string | null;
  findingIds?: string[];
}

export interface StoryInput {
  cause: StoryCauseInput | null;
  promises: StoryPromiseInput[];
  currentStatus: StoryStateFieldInput;
  statusChangedBy: StoryStateFieldInput;
  lastClientContact: { known: boolean; chases: number | null; findingIds?: string[] };
  latestFix: { known: boolean; text: string | null; findingIds?: string[] };
  openQuestion: { question: string; nextStep: string; findingIds?: string[] } | null;
  recordCount: number;
  counts: { findings: number; verified: number; needsCheck: number; openQuestions: number };
  sources: string[];
  /** False when no client/project is confirmed: a cause is a lead, not the case's cause. */
  scopeConfirmed?: boolean;
  /** The case's own ticket (from its latest status change), when one exists. */
  incidentChannel?: string | null;
}

function ids(...groups: (string[] | undefined)[]): string[] {
  return [...new Set(groups.flatMap((group) => group ?? []))];
}

function one(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
}

function words(text: string, limit: number): string {
  const parts = one(text).split(" ").filter(Boolean);
  if (parts.length <= limit) return parts.join(" ");
  return `${parts.slice(0, limit).join(" ")}…`;
}

function day(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function promiseOutcome(status: StoryPromiseInput["status"]): "kept" | "broken" | "unclear" {
  return status === "withdrawn" ? "unclear" : status;
}

function firstSentence(text: string): string {
  const flat = one(text);
  const match = flat.match(/^(.+?[.!?])(?:\s|$)/);
  return (match ? match[1] : flat).replace(/[.]+$/, "");
}

function causeSentence(
  cause: StoryCauseInput | null,
  scopeConfirmed: boolean,
  incidentChannel: string | null | undefined,
): StorySentence {
  if (!cause) {
    return { text: "The records do not establish a technical cause.", findingIds: [] };
  }
  const statement = firstSentence(cause.statement);
  // Without a confirmed engagement a technical record is a lead, not the
  // case's cause — never assert an incident the escalation did not establish.
  if (!scopeConfirmed) {
    return {
      text: `The records contain a possible cause (“${statement}”, ${cause.channel}, ${day(cause.ts)}), but no client or project is confirmed, so this may not concern the escalation.`,
      findingIds: ids(cause.findingIds),
    };
  }
  // Name the incident only when the cause record is on the case's own ticket.
  // A sibling ticket (the hidden-cause case) must not become "the incident".
  const incident =
    incidentChannel && cause.channel.toUpperCase() === incidentChannel.toUpperCase()
      ? `The ${cause.channel} incident`
      : "The incident";
  if (cause.state === "verified") {
    return {
      text: `${incident} traces to a cause recorded on ${day(cause.ts)}: “${statement}”.`,
      findingIds: ids(cause.findingIds),
    };
  }
  return {
    text: `The evidence points to a cause recorded on ${day(cause.ts)}: “${statement}” — that finding still needs a check.`,
    findingIds: ids(cause.findingIds),
  };
}

function promiseSentence(promise: StoryPromiseInput | undefined): StorySentence {
  if (!promise) {
    return { text: "No client-facing promise was recorded.", findingIds: [] };
  }
  const promisor = one(promise.promisor ?? "Someone") || "Someone";
  const promisee = promise.promisee ? ` to ${one(promise.promisee)}` : "";
  const deadline = promise.deadlinePhrase ? ` by ${one(promise.deadlinePhrase)}` : "";
  const object = one(promise.object);
  return {
    text: `${promisor} promised${promisee}: “${object}”${deadline}; it was ${promiseOutcome(promise.status)}.`,
    findingIds: ids(promise.findingIds),
  };
}

function nowSentence(input: StoryInput): StorySentence {
  const status = input.currentStatus.known && input.currentStatus.value
    ? input.currentStatus.value
    : "the current status is not recorded";
  const segments: string[] = [];
  if (input.statusChangedBy.known && input.statusChangedBy.value) {
    segments.push(`last status change by ${input.statusChangedBy.value}`);
  }
  if (input.latestFix.known && input.latestFix.text) {
    segments.push(`latest delivery: ${words(input.latestFix.text, 14)}`);
  }
  if (input.lastClientContact.known && input.lastClientContact.chases !== null) {
    const chases = input.lastClientContact.chases;
    segments.push(
      chases > 0
        ? `the client has chased ${chases} ${chases === 1 ? "time" : "times"} without a reply`
        : "no unanswered client chase",
    );
  }
  const tail = segments.length > 0 ? `; ${segments.join("; ")}` : "";
  return {
    text: `As of now: ${status}${tail}.`,
    findingIds: ids(
      input.currentStatus.findingIds,
      input.statusChangedBy.findingIds,
      input.latestFix.findingIds,
      input.lastClientContact.findingIds,
    ),
  };
}

function looksLikeQuestion(text: string): boolean {
  return (
    /\?\s*$/.test(text) ||
    /^(?:which|who|what|when|where|why|how|whether|did|does|is|are|was|were|has|have|can|could|should|will|would)\b/i.test(
      text.trim(),
    )
  );
}

function openSentence(open: StoryInput["openQuestion"]): StorySentence | null {
  if (!open) return null;
  const question = one(open.question);
  // The headline slot is for an actual open question. A skeptic observation
  // ("X says Y, which is unexamined") belongs in the gaps section, not here.
  if (!looksLikeQuestion(question)) return null;
  const first = firstSentence(question);
  const capped =
    first.split(/\s+/).length > 24 ? `${first.split(/\s+/).slice(0, 24).join(" ")}…` : first;
  // Never leave a dangling quote when a note is cut mid-citation.
  const balanced = capped.replace(/\s(['"])([^'"]*)$/, " $2");
  return {
    text: `Still unknown: ${balanced}${/[?!…]$/.test(balanced) ? "" : "."}`,
    findingIds: ids(open.findingIds),
  };
}

export function buildStory(input: StoryInput): Story {
  // A thin record set is its own warning; a missing cause already gets its own
  // honest sentence — it must not masquerade as "only N records".
  const tooThin = input.recordCount < 4;
  const sentences: StorySentence[] = [];

  if (tooThin) {
    sentences.push({
      text: `Only ${input.recordCount} stored record${input.recordCount === 1 ? "" : "s"} back this account, so treat every statement as limited evidence.`,
      findingIds: [],
    });
  }
  sentences.push(causeSentence(input.cause, input.scopeConfirmed !== false, input.incidentChannel));
  sentences.push(promiseSentence(input.promises[0]));
  sentences.push(nowSentence(input));
  const open = openSentence(input.openQuestion);
  if (open) sentences.push(open);

  const statsLine = [
    `${input.counts.findings} finding${input.counts.findings === 1 ? "" : "s"}`,
    `${input.counts.verified} verified`,
    `${input.counts.needsCheck} needs check`,
    `${input.counts.openQuestions} open question${input.counts.openQuestions === 1 ? "" : "s"}`,
    input.sources.join(", "),
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    sentences,
    statsLine,
    nextStep: input.openQuestion?.nextStep ?? null,
    tooThin,
  };
}
