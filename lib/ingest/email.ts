import PostalMime, { type Email } from "postal-mime";

import type { EventInput } from "../types";
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

function splitMbox(text: string): string[] {
  const messages: string[] = [];
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("From ")) {
      if (current) messages.push(current.join("\n"));
      current = [];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) messages.push(current.join("\n"));
  if (messages.length > 0) return messages;
  return text.trim() ? [text] : [];
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function decodeEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeCodePoint(Number(dec)));
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function fromDisplay(from: Email["from"]): string | undefined {
  if (!from) return undefined;
  if (typeof from.name === "string" && from.name.trim()) return from.name.trim();
  if ("address" in from && typeof from.address === "string" && from.address.trim()) {
    return from.address.trim();
  }
  return undefined;
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
    let email: Email;
    try {
      email = await PostalMime.parse(chunk);
    } catch {
      continue;
    }
    const event = buildEvent(email);
    if (!event) continue;
    if (event.threadId) {
      const list = threads.get(event.threadId) ?? [];
      const messageId = event.meta?.messageId;
      list.push(typeof messageId === "string" ? messageId : event.threadId);
      threads.set(event.threadId, list);
    }
    events.push(event);
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
