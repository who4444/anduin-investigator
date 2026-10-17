import type { Event } from "../types";

/* Relevance ordering for search results. The previous behavior sliced matches
   chronologically, so the oldest 30 hits were returned and the most on-point
   record could be dropped from the exact search that needed it. Scoring here
   is deliberately simple and deterministic: cited ticket refs beat a literal
   phrase, a phrase beats scattered tokens, and ties are broken by recency. */

const TICKET_TOKEN = /^[A-Z][A-Z0-9]{1,9}-\d+$/i;

const SCORE_REF_CITED = 60;
const SCORE_REF_MENTIONED = 30;
const SCORE_PHRASE = 50;
const SCORE_TOKEN_TEXT = 5;
const SCORE_TOKEN_CHANNEL = 6;
const SCORE_TOKEN_ACTOR = 6;

export function rankEvents(events: Event[], query: string): Event[] {
  const phrase = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!phrase) return events;

  const tokens = [...new Set(phrase.split(/[^a-z0-9-]+/).filter((token) => token.length >= 2))];
  const refTokens = tokens.filter((token) => TICKET_TOKEN.test(token)).map((token) => token.toUpperCase());
  const wordTokens = tokens.filter((token) => !TICKET_TOKEN.test(token));

  const scored = events.map((event) => {
    const text = event.text.toLowerCase();
    let score = 0;

    for (const ref of refTokens) {
      if ((event.refs ?? []).some((entry) => entry.toUpperCase() === ref)) {
        score += SCORE_REF_CITED;
      } else if (text.includes(ref.toLowerCase())) {
        score += SCORE_REF_MENTIONED;
      }
    }

    // A literal phrase is only informative when the query is not just a ticket
    // key — that case is already handled above.
    if (refTokens.length === 0 && text.includes(phrase)) {
      score += SCORE_PHRASE;
    }

    for (const token of wordTokens) {
      if (text.includes(token)) score += SCORE_TOKEN_TEXT;
      if (event.channel.toLowerCase().includes(token)) score += SCORE_TOKEN_CHANNEL;
      if ((event.actorResolved ?? event.actor).toLowerCase().includes(token)) score += SCORE_TOKEN_ACTOR;
    }

    return { event, score };
  });

  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.event.ts < b.event.ts ? 1 : a.event.ts > b.event.ts ? -1 : 0) ||
        (a.event.id < b.event.id ? -1 : 1),
    )
    .map((entry) => entry.event);
}
