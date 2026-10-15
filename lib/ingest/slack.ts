import type { EventInput } from "../types";
import { isoFromEpoch } from "./normalize";
import { extractTicketRefs } from "./refs";

type Json = Record<string, unknown>;

export interface SlackFile {
  name: string;
  json: unknown;
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function basename(name: string): string {
  const parts = name.split(/[\\/]/).filter((part) => part && part !== ".");
  return parts[parts.length - 1] ?? name;
}

function userName(user: Json): string | undefined {
  const profile = isObject(user.profile) ? user.profile : {};
  return asString(profile.real_name) ?? asString(user.real_name) ?? asString(user.name);
}

function collectUsers(json: unknown, users: Map<string, string>): void {
  if (Array.isArray(json)) {
    for (const entry of json) {
      if (!isObject(entry)) continue;
      const id = asString(entry.id);
      if (id) users.set(id, userName(entry) ?? id);
    }
    return;
  }
  if (isObject(json)) {
    for (const [id, value] of Object.entries(json)) {
      if (isObject(value)) users.set(id, userName(value) ?? id);
      else if (typeof value === "string" && value) users.set(id, value);
    }
  }
}

function collectChannels(json: unknown, channels: Map<string, string>): void {
  if (Array.isArray(json)) {
    for (const entry of json) {
      if (!isObject(entry)) continue;
      const id = asString(entry.id);
      const name = asString(entry.name) ?? asString(entry.name_normalized);
      if (id && name) channels.set(id, name);
    }
    return;
  }
  if (isObject(json)) {
    for (const [id, value] of Object.entries(json)) {
      if (isObject(value)) {
        const name = asString(value.name);
        if (name) channels.set(id, name);
      } else if (typeof value === "string" && value) {
        channels.set(id, value);
      }
    }
  }
}

function channelNameFor(name: string, channels: Map<string, string>): string {
  const parts = name.split(/[\\/]/).filter((part) => part && part !== ".");
  const base = parts[parts.length - 1] ?? name;
  const stem = base.replace(/\.json$/i, "");
  const parent = parts.length >= 2 ? parts[parts.length - 2] : undefined;
  if (parent && parent !== "users" && parent !== "channels") return channels.get(parent) ?? parent;
  if (stem && stem !== "users" && stem !== "channels") return channels.get(stem) ?? stem;
  return stem || "slack";
}

function buildSlackEvent(
  message: Json,
  channel: string,
  users: Map<string, string>,
): EventInput | null {
  const rawTs = message.ts;
  if (typeof rawTs !== "number" && typeof rawTs !== "string") return null;

  let ts: string;
  try {
    ts = isoFromEpoch(rawTs);
  } catch {
    return null;
  }

  const userId = asString(message.user);
  const actor =
    (userId ? users.get(userId) : undefined) ??
    userId ??
    asString(message.username) ??
    asString(message.bot_id) ??
    "unknown";

  const text = typeof message.text === "string" ? message.text : "";
  const threadTs = asString(message.thread_ts);

  const event: EventInput = {
    source: "slack",
    ts,
    actor,
    channel,
    text,
  };
  if (threadTs) event.threadId = `slack:${channel}:${threadTs}`;
  const refs = extractTicketRefs(text);
  if (refs.length > 0) event.refs = refs;

  const meta: Record<string, unknown> = {};
  const subtype = asString(message.subtype);
  if (subtype) meta.subtype = subtype;
  if (userId) meta.user = userId;
  if (Object.keys(meta).length > 0) event.meta = meta;

  return event;
}

export function parseSlackFiles(files: SlackFile[]): { events: EventInput[] } {
  const events: EventInput[] = [];
  if (!Array.isArray(files)) return { events };

  const users = new Map<string, string>();
  const channels = new Map<string, string>();

  for (const file of files) {
    if (!file || typeof file.name !== "string") continue;
    const base = basename(file.name);
    if (base === "users.json") collectUsers(file.json, users);
    else if (base === "channels.json") collectChannels(file.json, channels);
  }

  for (const file of files) {
    if (!file || typeof file.name !== "string") continue;
    const base = basename(file.name);
    if (base === "users.json" || base === "channels.json") continue;
    if (!Array.isArray(file.json)) continue;
    const channel = channelNameFor(file.name, channels);
    for (const message of file.json) {
      if (!isObject(message)) continue;
      try {
        const event = buildSlackEvent(message, channel, users);
        if (event) events.push(event);
      } catch {
        // A single malformed message must never abort the whole parse.
      }
    }
  }

  return { events };
}
