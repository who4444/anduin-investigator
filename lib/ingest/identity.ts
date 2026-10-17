import { extractJson } from "../json";
import type { LlmClient } from "../llm";
import type { EventInput, IdentityResolutionInput } from "../types";

const EMAIL_PATTERN = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/;
const LLM_MERGE_MIN_CONFIDENCE = 0.9;
const SAMPLE_TEXT_LIMIT = 120;
const SAMPLES_PER_ALIAS = 3;
const SIGNAL_TOKEN_MIN_LENGTH = 2;

export interface AliasStore {
  upsertIdentity(row: IdentityResolutionInput): Promise<void>;
}

export interface LlmMergeSuggestion {
  alias: string;
  canonical: string;
  confidence: number;
}

function emailOf(actor: string): string | null {
  const match = actor.match(EMAIL_PATTERN);
  return match ? match[0].toLowerCase() : null;
}

function displayNameOf(actor: string): string {
  const named = actor.match(/^\s*(.*?)\s*<[^>]+>\s*$/);
  const candidate = (named ? named[1] : actor).replace(/\s+/g, " ").trim();
  return EMAIL_PATTERN.test(candidate) ? "" : candidate;
}

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countActors(events: EventInput[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.actor, (counts.get(event.actor) ?? 0) + 1);
  }
  return counts;
}

function uppercaseCount(value: string): number {
  return (value.match(/[A-Z]/g) ?? []).length;
}

function pickCanonical(counts: Map<string, number>): string | null {
  const ranked = [...counts.entries()].sort(
    (a, b) =>
      b[1] - a[1] ||
      uppercaseCount(b[0]) - uppercaseCount(a[0]) ||
      (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );
  return ranked.length > 0 ? ranked[0][0] : null;
}

export function deterministicAliases(events: EventInput[]): Map<string, string> {
  const actorCounts = countActors(events);
  const byEmail = new Map<string, Map<string, number>>();
  const byName = new Map<string, Map<string, number>>();

  for (const [actor, count] of actorCounts) {
    const email = emailOf(actor);
    if (email) {
      const names = byEmail.get(email) ?? new Map<string, number>();
      const name = displayNameOf(actor);
      if (name) names.set(name, (names.get(name) ?? 0) + count);
      byEmail.set(email, names);
    }

    const display = displayNameOf(actor);
    const normalized = normalizeName(display);
    if (normalized) {
      // Group by DISPLAY NAME (aggregating every raw form) so the canonical is
      // always a clean name, never a "Name <addr>" actor string.
      const variants = byName.get(normalized) ?? new Map<string, number>();
      variants.set(display, (variants.get(display) ?? 0) + count);
      byName.set(normalized, variants);
    }
  }

  // A display name shared by several distinct emails is ambiguous — two
  // different people can carry the same name. Those emails must not collapse
  // onto the shared bare name; each keeps its own disambiguated actor.
  const emailsByName = new Map<string, Set<string>>();
  for (const [email, names] of byEmail) {
    for (const name of names.keys()) {
      const set = emailsByName.get(name) ?? new Set<string>();
      set.add(email);
      emailsByName.set(name, set);
    }
  }
  const ambiguousNames = new Set(
    [...emailsByName.entries()].filter(([, emails]) => emails.size > 1).map(([name]) => name),
  );

  const canonicalByEmail = new Map<string, string>();
  for (const [email, names] of byEmail) {
    const unambiguous = [...names.entries()].filter(([name]) => !ambiguousNames.has(name));
    if (unambiguous.length === 0) continue;
    const canonical = pickCanonical(new Map(unambiguous));
    // Email senders keep their address in the canonical actor — cross-source
    // linking (and any domain-based scoping) depends on it surviving merges.
    if (canonical) canonicalByEmail.set(email, `${canonical} <${email}>`);
  }

  const canonicalByName = new Map<string, string>();
  for (const [normalized, variants] of byName) {
    const canonical = pickCanonical(variants);
    if (canonical) canonicalByName.set(normalized, canonical);
  }

  const aliases = new Map<string, string>();
  for (const actor of actorCounts.keys()) {
    const email = emailOf(actor);
    let canonical: string | undefined;
    if (email) {
      canonical = canonicalByEmail.get(email);
    } else {
      const normalized = normalizeName(displayNameOf(actor));
      if (normalized) canonical = canonicalByName.get(normalized);
    }
    if (canonical && canonical !== actor) aliases.set(actor, canonical);
  }
  return aliases;
}

export async function suggestLlmMerges(
  events: EventInput[],
  client: LlmClient,
): Promise<LlmMergeSuggestion[]> {
  const actorCounts = countActors(events);
  if (actorCounts.size < 2) return [];

  const samples = new Map<string, string[]>();
  for (const event of events) {
    const list = samples.get(event.actor) ?? [];
    if (list.length < SAMPLES_PER_ALIAS) list.push(event.text.slice(0, SAMPLE_TEXT_LIMIT));
    samples.set(event.actor, list);
  }

  const aliasPayload = [...actorCounts.entries()].map(([actor, count]) => ({
    actor,
    count,
    samples: samples.get(actor) ?? [],
  }));

  const system =
    "You resolve identities across tools for an incident investigation. Merge only aliases that clearly refer to the same person.";
  const user = [
    "Aliases with message samples (JSON):",
    JSON.stringify(aliasPayload),
    "",
    'Return JSON: {"merges":[{"alias":"...","canonical":"...","confidence":0.0}]}.',
    "canonical must be one of the listed actor strings. Omit any pair you are not confident about.",
  ].join("\n");

  let content: string;
  try {
    const response = await client.chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { forceJson: true },
    );
    content = response.content;
  } catch {
    return [];
  }

  return parseSuggestions(content);
}

function parseSuggestions(content: string): LlmMergeSuggestion[] {
  const parsed = extractJson(content);
  if (!parsed) return [];

  const rawMerges = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { merges?: unknown }).merges)
      ? ((parsed as { merges: unknown[] }).merges as unknown[])
      : [];

  const suggestions: LlmMergeSuggestion[] = [];
  for (const raw of rawMerges) {
    if (!raw || typeof raw !== "object") continue;
    const candidate = raw as { alias?: unknown; canonical?: unknown; confidence?: unknown };
    if (typeof candidate.alias !== "string" || typeof candidate.canonical !== "string") continue;
    const alias = candidate.alias.trim();
    const canonical = candidate.canonical.trim();
    const confidence = typeof candidate.confidence === "number" ? candidate.confidence : Number.NaN;
    if (!alias || !canonical || alias === canonical) continue;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) continue;
    suggestions.push({ alias, canonical, confidence });
  }

  return suggestions;
}

function signalTokens(actor: string): Set<string> {
  const tokens = new Set<string>();
  const add = (value: string) => {
    for (const token of normalizeName(value).split(" ")) {
      if (token.length >= SIGNAL_TOKEN_MIN_LENGTH) tokens.add(token);
    }
  };

  add(displayNameOf(actor));

  const email = emailOf(actor);
  if (email) {
    add(email.split("@")[0].replace(/[._-]+/g, " "));
  }

  return tokens;
}

function hasSignalOverlap(a: string, b: string): boolean {
  const emailA = emailOf(a);
  const emailB = emailOf(b);
  if (emailA && emailB && emailA === emailB) return true;

  const tokensA = signalTokens(a);
  for (const token of signalTokens(b)) {
    if (tokensA.has(token)) return true;
  }
  return false;
}

export async function applyAliases(
  events: EventInput[],
  resolved: Map<string, string>,
  store: AliasStore,
): Promise<EventInput[]> {
  const out: EventInput[] = [];
  const recorded = new Set<string>();

  for (const event of events) {
    const canonical = resolved.get(event.actor);
    if (!canonical) {
      out.push(event);
      continue;
    }

    out.push({ ...event, actor: canonical });

    if (!recorded.has(event.actor)) {
      recorded.add(event.actor);
      await store.upsertIdentity({
        alias: event.actor,
        canonical,
        method: event.actor.includes("@") ? "exact_email" : "exact_name",
        confidence: 1,
        applied: true,
      });
    }
  }

  return out;
}

export async function applyLlmMerges(
  events: EventInput[],
  suggestions: LlmMergeSuggestion[],
  store: AliasStore,
): Promise<EventInput[]> {
  const byAlias = new Map<string, LlmMergeSuggestion>();
  for (const suggestion of suggestions) {
    if (!byAlias.has(suggestion.alias)) byAlias.set(suggestion.alias, suggestion);
  }

  /* The model chooses the display name; the code decides whether an email
     address survives. An address-bearing alias must never merge into a bare
     name — the address is what links people across tools (and what
     domain-based scoping depends on). */
  const effectiveCanonical = (alias: string, canonical: string): string => {
    const aliasEmail = alias.match(EMAIL_PATTERN);
    if (aliasEmail && !EMAIL_PATTERN.test(canonical)) {
      return `${canonical} <${aliasEmail[0].toLowerCase()}>`;
    }
    return canonical;
  };

  /* Suggestions can chain (L. Chen -> Lin Chen -> Lin Chen <addr>); follow
     them to the final canonical so one pass fully merges a chain. */
  const finalCanonical = (alias: string): string => {
    let current = alias;
    const seen = new Set<string>([alias]);
    for (let step = 0; step < 5; step += 1) {
      const next = byAlias.get(current);
      if (!next || seen.has(next.canonical)) break;
      seen.add(next.canonical);
      current = next.canonical;
    }
    return current;
  };

  const out: EventInput[] = [];
  const recorded = new Set<string>();

  for (const event of events) {
    const suggestion = byAlias.get(event.actor);
    if (!suggestion) {
      out.push(event);
      continue;
    }

    const canonical = effectiveCanonical(event.actor, finalCanonical(event.actor));
    const applied =
      suggestion.confidence >= LLM_MERGE_MIN_CONFIDENCE &&
      hasSignalOverlap(suggestion.alias, suggestion.canonical);

    out.push(applied ? { ...event, actor: canonical } : event);

    if (!recorded.has(event.actor)) {
      recorded.add(event.actor);
      await store.upsertIdentity({
        alias: suggestion.alias,
        canonical,
        method: "llm",
        confidence: suggestion.confidence,
        applied,
      });
    }
  }

  for (const suggestion of byAlias.values()) {
    if (recorded.has(suggestion.alias)) continue;
    recorded.add(suggestion.alias);
    await store.upsertIdentity({
      alias: suggestion.alias,
      canonical: suggestion.canonical,
      method: "llm",
      confidence: suggestion.confidence,
      applied: false,
    });
  }

  return out;
}

export async function resolveIdentities(
  events: EventInput[],
  client: LlmClient,
  store: AliasStore,
): Promise<EventInput[]> {
  const deterministic = deterministicAliases(events);
  const afterDeterministic = await applyAliases(events, deterministic, store);
  const suggestions = await suggestLlmMerges(afterDeterministic, client);
  return applyLlmMerges(afterDeterministic, suggestions, store);
}
