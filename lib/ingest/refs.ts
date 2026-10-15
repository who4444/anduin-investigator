const TICKET_REF = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/gi;

export function extractTicketRefs(text: string): string[] {
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of text.matchAll(TICKET_REF)) {
    const ref = match[0].toUpperCase();
    if (seen.has(ref)) continue;
    seen.add(ref);
    refs.push(ref);
  }
  return refs;
}
