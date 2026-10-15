export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function verifyQuote(eventText: string, quote: string): { ok: boolean; error?: string } {
  const normalizedQuote = normalizeWhitespace(quote);
  if (normalizedQuote.length === 0) {
    return { ok: false, error: "quote_not_found" };
  }

  const normalizedEvent = normalizeWhitespace(eventText);
  if (normalizedEvent.includes(normalizedQuote)) {
    return { ok: true };
  }

  return { ok: false, error: "quote_not_found" };
}
