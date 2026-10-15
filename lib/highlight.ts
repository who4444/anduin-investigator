export interface QuoteRange {
  start: number;
  end: number;
}

function normalize(value: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let pendingSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      pendingSpace = text.length > 0;
      continue;
    }
    if (pendingSpace) {
      text += " ";
      map.push(index - 1);
      pendingSpace = false;
    }
    text += char;
    map.push(index);
  }

  return { text, map };
}

export function findQuoteRange(text: string, quote: string): QuoteRange | null {
  const haystack = normalize(text);
  const needle = normalize(quote).text;
  if (needle.length === 0) return null;

  const at = haystack.text.indexOf(needle);
  if (at === -1) return null;

  return {
    start: haystack.map[at],
    end: haystack.map[at + needle.length - 1] + 1,
  };
}

export interface TextSegment {
  text: string;
  highlighted: boolean;
}

export function highlightSegments(text: string, quotes: string[]): TextSegment[] {
  const ranges: QuoteRange[] = [];
  for (const quote of quotes) {
    const range = findQuoteRange(text, quote);
    if (range) ranges.push(range);
  }
  ranges.sort((a, b) => a.start - b.start);

  const merged: QuoteRange[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }

  const segments: TextSegment[] = [];
  let cursor = 0;
  for (const range of merged) {
    if (range.start > cursor) {
      segments.push({ text: text.slice(cursor, range.start), highlighted: false });
    }
    segments.push({ text: text.slice(range.start, range.end), highlighted: true });
    cursor = range.end;
  }
  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlighted: false });
  }

  return segments;
}
