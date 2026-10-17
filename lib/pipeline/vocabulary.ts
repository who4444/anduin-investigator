import type { Event } from "../types";

/* Deterministic vocabulary digest: the terms the records actually use —
   ticket keys, version-like builds, channels, sender domains and the most
   frequent distinctive words. Cheap enough to compute over every in-scope
   event, so the analyst plans with real internal vocabulary even when it
   heard none of it in the escalation. */

export interface VocabularyDigest {
  tickets: string[];
  versions: string[];
  channels: string[];
  domains: string[];
  terms: string[];
}

const TICKET_ANYWHERE = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/g;
const TICKET_EXACT = /^[A-Z][A-Z0-9]{1,9}-\d+$/;
const VERSION = /\b\d+\.\d+(?:\.\d+)?\b/g;
const EMAIL_DOMAIN = /@([A-Za-z0-9.-]+)/;

const MAX_TICKETS = 40;
const MAX_VERSIONS = 20;
const MAX_CHANNELS = 20;
const MAX_DOMAINS = 20;
const MAX_TERMS = 25;
const MIN_TERM_LENGTH = 3;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had",
  "been", "will", "would", "are", "was", "were", "not", "but", "you", "your",
  "our", "its", "his", "her", "their", "them", "they", "she", "him", "who",
  "what", "when", "where", "why", "how", "all", "any", "can", "could", "should",
  "about", "into", "over", "under", "after", "before", "still", "just", "only",
  "than", "then", "there", "here", "also", "very", "much", "more", "most",
  "some", "such", "no", "yes", "out", "off", "per", "via", "yet", "get", "got",
  "one", "two", "day", "days", "time", "now", "new", "old", "made", "make",
]);

export function buildVocabularyDigest(events: Event[]): VocabularyDigest {
  const tickets = new Set<string>();
  const versions = new Set<string>();
  const channels = new Set<string>();
  const domains = new Set<string>();
  const termCounts = new Map<string, number>();

  for (const event of events) {
    for (const ref of event.refs ?? []) {
      if (TICKET_EXACT.test(ref)) tickets.add(ref);
    }
    for (const match of event.text.matchAll(TICKET_ANYWHERE)) {
      tickets.add(match[0]);
    }
    if (event.source === "jira" && TICKET_EXACT.test(event.channel)) {
      tickets.add(event.channel);
    }

    for (const match of event.text.matchAll(VERSION)) {
      versions.add(match[0]);
    }

    if (event.source === "slack" && event.channel && event.channel !== "slack") {
      channels.add(event.channel.toLowerCase());
    }

    const domain = event.actor.match(EMAIL_DOMAIN)?.[1]?.toLowerCase();
    if (domain) domains.add(domain);

    for (const token of event.text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length < MIN_TERM_LENGTH) continue;
      if (/^\d+$/.test(token)) continue;
      if (STOPWORDS.has(token)) continue;
      termCounts.set(token, (termCounts.get(token) ?? 0) + 1);
    }
  }

  const terms = [...termCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([term]) => term)
    .slice(0, MAX_TERMS);

  return {
    tickets: [...tickets].sort().slice(0, MAX_TICKETS),
    versions: [...versions].sort().slice(0, MAX_VERSIONS),
    channels: [...channels].sort().slice(0, MAX_CHANNELS),
    domains: [...domains].sort().slice(0, MAX_DOMAINS),
    terms,
  };
}

export function renderVocabularyDigest(digest: VocabularyDigest): string {
  const lines: string[] = [];
  if (digest.tickets.length > 0) lines.push(`Tickets: ${digest.tickets.join(", ")}`);
  if (digest.versions.length > 0) lines.push(`Versions/builds: ${digest.versions.join(", ")}`);
  if (digest.channels.length > 0) lines.push(`Channels: ${digest.channels.join(", ")}`);
  if (digest.domains.length > 0) lines.push(`Sender domains: ${digest.domains.join(", ")}`);
  if (digest.terms.length > 0) lines.push(`Frequent terms: ${digest.terms.join(", ")}`);
  return lines.join("\n");
}
