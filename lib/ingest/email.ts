import PostalMime, { type Email } from "postal-mime";

import type { EventInput } from "../types";
import { decodeEntities } from "./entities";
import { extractTicketRefs } from "./refs";

export interface EmailParseResult {
  events: EventInput[];
  threads: Map<string, string[]>;
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

/* mboxrd: a "From " line only starts a message when it follows a blank line
   (or the start of the file), or when it is shaped like a real envelope line
   ("From alice@example.org Tue Sep 24 09:30:00 2024") — body prose like
   "From our last conversation…" is content, not a boundary. ">From " quoting
   inside a message is unescaped on read. */
const MBOX_ENVELOPE = /^From \S+@\S+\s+\w{3}\s+\w{3}\s+\d{1,2}\s+\d{1,2}:\d{2}/;

function unescapeMboxrd(message: string): string {
  return message
    .split(/\r?\n/)
    .map((line) => line.replace(/^>(>*From )/, "$1"))
    .join("\n");
}

function splitMbox(text: string): string[] {
  const messages: string[] = [];
  let current: string[] | null = null;
  let previousBlank = true;
  for (const line of text.split(/\r?\n/)) {
    const isSeparator = previousBlank
      ? line.startsWith("From ")
      : MBOX_ENVELOPE.test(line);
    if (isSeparator) {
      if (current) messages.push(current.join("\n"));
      current = [];
    } else if (current) {
      current.push(line);
    }
    previousBlank = line.trim() === "";
  }
  if (current) messages.push(current.join("\n"));
  if (messages.length > 0) return messages.map(unescapeMboxrd);
  return text.trim() ? [unescapeMboxrd(text)] : [];
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function fromDisplay(from: Email["from"]): string | undefined {
  if (!from) return undefined;
  const name = typeof from.name === "string" && from.name.trim() ? from.name.trim() : undefined;
  const address = "address" in from && typeof from.address === "string" && from.address.trim()
    ? from.address.trim()
    : undefined;

  // Keep the address alongside the display name so cross-source identity
  // resolution can link an email sender to the same person in Jira/Slack.
  if (name && address) return `${name} <${address}>`;
  return name ?? address;
}

function bodyText(email: Email): string {
  if (typeof email.text === "string" && email.text.trim()) return email.text;
  if (typeof email.html === "string" && email.html.trim()) return stripHtml(email.html);
  return "";
}

function extractMessageIds(raw: string): string[] {
  const ids: string[] = [];
  for (const match of raw.matchAll(/<([^>]+)>/g)) {
    const id = match[1].trim();
    if (id) ids.push(id);
  }
  if (ids.length === 0) {
    const trimmed = raw.trim();
    if (trimmed) ids.push(trimmed);
  }
  return ids;
}

function normalizeMessageId(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  return extractMessageIds(raw)[0];
}

function buildEvent(email: Email): EventInput | null {
  const actor = fromDisplay(email.from);
  const messageId = normalizeMessageId(email.messageId);
  const date = typeof email.date === "string" && email.date.trim() ? email.date.trim() : undefined;

  if (!actor && !messageId && !date) return null;

  const text = bodyText(email);
  const subject = typeof email.subject === "string" ? email.subject : "";
  const references = extractMessageIds(email.references ?? "");
  const inReplyTo = extractMessageIds(email.inReplyTo ?? "");
  const threadId = references[0] ?? inReplyTo[0] ?? messageId;

  const event: EventInput = {
    source: "email",
    ts: date ?? "",
    actor: actor ?? "unknown",
    channel: "email",
    text,
  };
  if (threadId) event.threadId = threadId;
  const refs = extractTicketRefs(`${subject}\n${text}`);
  if (refs.length > 0) event.refs = refs;
  if (messageId) event.meta = { messageId };
  return event;
}

async function parseRawMessages(chunks: string[]): Promise<EmailParseResult> {
  const events: EventInput[] = [];
  const threads = new Map<string, string[]>();

  for (const chunk of chunks) {
    if (!chunk.trim()) continue;
    try {
      const email = await PostalMime.parse(chunk);
      const event = buildEvent(email);
      if (!event) continue;
      if (event.threadId) {
        const list = threads.get(event.threadId) ?? [];
        const messageId = event.meta?.messageId;
        list.push(typeof messageId === "string" ? messageId : event.threadId);
        threads.set(event.threadId, list);
      }
      events.push(event);
    } catch {
      // A single malformed message must never abort the whole file's events.
    }
  }

  return { events, threads };
}

export async function parseMbox(bytes: Uint8Array): Promise<EmailParseResult> {
  try {
    return await parseRawMessages(splitMbox(decode(bytes)));
  } catch {
    return { events: [], threads: new Map() };
  }
}

export async function parseEml(bytes: Uint8Array): Promise<EmailParseResult> {
  try {
    return await parseRawMessages([decode(bytes)]);
  } catch {
    return { events: [], threads: new Map() };
  }
}
