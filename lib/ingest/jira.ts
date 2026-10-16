import type { EventInput } from "../types";
import { decodeEntities } from "./entities";
import { extractTicketRefs } from "./refs";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function displayName(value: unknown): string | undefined {
  if (typeof value === "string") return asString(value);
  if (isObject(value)) {
    return asString(value.displayName) ?? asString(value.name) ?? asString(value.emailAddress);
  }
  return undefined;
}

function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function adfInline(node: Json): string {
  const type = asString(node.type);
  if (type === "text") return asString(node.text) ?? "";
  if (type === "hardBreak") return "\n";
  const attrs = isObject(node.attrs) ? node.attrs : {};
  if (type === "mention") return asString(attrs.text) ?? asString(attrs.displayName) ?? "";
  if (type === "emoji") return asString(attrs.shortName) ?? "";
  if (type === "inlineCard") return asString(attrs.url) ?? "[link]";
  if (type === "media" || type === "mediaSingle") return asString(attrs.url) ?? "[attachment]";
  const content = Array.isArray(node.content) ? node.content : [];
  return content.map((child) => (isObject(child) ? adfInline(child) : "")).join("");
}

function adfBlock(node: Json): string {
  const type = asString(node.type);
  const content = Array.isArray(node.content) ? node.content : [];
  if (type === "paragraph" || type === "heading" || type === "codeBlock") {
    return adfInline(node).trim();
  }
  if (type === "listItem" || type === "taskItem") {
    const inner = content
      .map((child) => (isObject(child) ? adfBlock(child) : ""))
      .filter(Boolean)
      .join("\n");
    return inner
      .split("\n")
      .map((line) => `- ${line}`)
      .join("\n");
  }
  return content
    .map((child) => (isObject(child) ? adfBlock(child) : ""))
    .filter(Boolean)
    .join("\n");
}

/* Jira Cloud v3 returns comment/description bodies as ADF documents;
   v2 exports use HTML strings. Accept both. */
function bodyText(value: unknown): string | undefined {
  if (typeof value === "string") return value.length > 0 ? stripHtml(value) : undefined;
  if (!isObject(value)) return undefined;
  const text = adfBlock(value)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function browseUrl(self: unknown, key: string): string | undefined {
  if (typeof self !== "string") return undefined;
  const origin = self.match(/^(https?:\/\/[^/]+)/);
  if (!origin) return undefined;
  return `${origin[1]}/browse/${key}`;
}

function refsFor(...parts: (string | undefined)[]): string[] | undefined {
  const refs = extractTicketRefs(parts.filter((part): part is string => Boolean(part)).join("\n"));
  return refs.length > 0 ? refs : undefined;
}

function collectIssues(data: unknown): unknown[] {
  if (!isObject(data)) return [];
  if (Array.isArray(data.issues)) return data.issues;
  if (typeof data.key === "string" || typeof data.id === "string") return [data];
  return [];
}

function issueComments(issue: Json, fields: Json): unknown[] {
  const nested = isObject(fields.comment) ? fields.comment.comments : undefined;
  if (Array.isArray(nested)) return nested;
  const top = isObject(issue.comment) ? issue.comment.comments : undefined;
  if (Array.isArray(top)) return top;
  if (Array.isArray(issue.comments)) return issue.comments;
  return [];
}

function issueHistories(issue: Json, fields: Json): unknown[] {
  const top = isObject(issue.changelog) ? issue.changelog.histories : undefined;
  if (Array.isArray(top)) return top;
  const nested = isObject(fields.changelog) ? fields.changelog.histories : undefined;
  if (Array.isArray(nested)) return nested;
  return [];
}

function issueEvents(issue: Json): EventInput[] {
  const key = asString(issue.key) ?? asString(issue.id) ?? "UNKNOWN";
  const fields = isObject(issue.fields) ? issue.fields : {};
  const url = browseUrl(issue.self, key);
  const summary = asString(fields.summary);
  const description = bodyText(fields.description);

  const events: EventInput[] = [];

  const created = asString(fields.created);
  if (created) {
    const text = summary ? `Issue created: ${summary}` : "Issue created";
    events.push({
      source: "jira",
      ts: created,
      actor: displayName(fields.reporter) ?? "unknown",
      channel: key,
      text,
      url,
      refs: refsFor(summary, description),
    });
  }

  for (const raw of issueComments(issue, fields)) {
    if (!isObject(raw)) continue;
    const ts = asString(raw.created);
    if (!ts) continue;
    const body = bodyText(raw.body);
    events.push({
      source: "jira",
      ts,
      actor: displayName(raw.author) ?? "unknown",
      channel: key,
      text: body ?? "",
      url,
      refs: refsFor(body),
    });
  }

  for (const raw of issueHistories(issue, fields)) {
    if (!isObject(raw)) continue;
    const actor = displayName(raw.author) ?? "unknown";
    const historyCreated = asString(raw.created);
    const items = Array.isArray(raw.items) ? raw.items : [];
    for (const item of items) {
      if (!isObject(item)) continue;
      const ts = asString(item.created) ?? historyCreated;
      if (!ts) continue;
      const field = asString(item.field);
      const from = asString(item.fromString);
      const to = asString(item.toString);
      let text: string | undefined;
      if (field === "status") {
        text = from && to ? `Status: ${from} → ${to}` : `Status set to ${to ?? "unknown"}`;
      } else if (field === "assignee") {
        text = `Assignee: ${from ?? "unassigned"} → ${to ?? "unassigned"}`;
      } else if (field === "resolution") {
        text = from ? `Resolution: ${from} → ${to ?? "none"}` : `Resolution set to ${to ?? "none"}`;
      }
      if (!text) continue;
      events.push({ source: "jira", ts, actor, channel: key, text, url });
    }
  }

  return events;
}

export function parseJira(data: unknown): {
  events: EventInput[];
  issues: { key: string; summary: string }[];
} {
  const events: EventInput[] = [];
  const issues: { key: string; summary: string }[] = [];

  for (const raw of collectIssues(data)) {
    if (!isObject(raw)) continue;
    const key = asString(raw.key) ?? asString(raw.id) ?? "UNKNOWN";
    const fields = isObject(raw.fields) ? raw.fields : {};
    issues.push({ key, summary: asString(fields.summary) ?? "" });
    try {
      events.push(...issueEvents(raw));
    } catch {
      // A single malformed issue must never abort the whole parse.
    }
  }

  return { events, issues };
}
