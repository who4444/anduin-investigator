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

function causeSentence(cause: StoryCauseInput | null): StorySentence {
  if (!cause) {
    return { text: "The records do not establish a technical cause.", findingIds: [] };
  }
  if (cause.state === "verified") {
    return {
      text: `The ${cause.channel} incident traces to ${one(cause.statement)} (on ${day(cause.ts)}).`,
      findingIds: ids(cause.findingIds),
    };
  }
  return {
    text: `The evidence points to ${one(cause.statement)}, but that finding still needs a check.`,
    findingIds: ids(cause.findingIds),
  };
}

function promiseSentence(promise: StoryPromiseInput | undefined): StorySentence {
  if (!promise) {
    return { text: "No client-facing promise was recorded.", findingIds: [] };
  }
  const promisor = one(promise.promisor ?? "Someone") || "Someone";
  const promisee = promise.promisee ? `${one(promise.promisee)} ` : "";
  const deadline = promise.deadlinePhrase ? ` by ${one(promise.deadlinePhrase)}` : "";
  const object = one(promise.object);
  return {
    text: `${promisor} promised ${promisee}${object}${deadline}; it was ${promiseOutcome(promise.status)}.`,
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

function openSentence(open: StoryInput["openQuestion"]): StorySentence | null {
  if (!open) return null;
  const question = one(open.question);
  const next = one(open.nextStep);
  return {
    text: `Still unknown: ${question}${/[?!]$/.test(question) ? "" : "."} Next: ${next}.`,
    findingIds: ids(open.findingIds),
  };
}

export function buildStory(input: StoryInput): Story {
  const tooThin = input.recordCount < 4 || input.cause === null;
  const sentences: StorySentence[] = [];

  if (tooThin) {
    sentences.push({
      text: `Only ${input.recordCount} stored record${input.recordCount === 1 ? "" : "s"} back this account, so treat every statement as limited evidence.`,
      findingIds: [],
    });
  }
  sentences.push(causeSentence(input.cause));
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
