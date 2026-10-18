import type { Claim, Commitment, Event, Gap, SkepticNote } from "../types";

/* Shared record patterns. The case-state builder and the silence computation
   must agree on what counts as a status/assignee transition and a delivery. */
export const STATUS_TRANSITION = /^\s*Status:\s*(.+?)\s*→\s*(.+?)\s*$/;
export const ASSIGNEE_TRANSITION = /^\s*Assignee:\s*(.+?)\s*→\s*(.+?)\s*$/;
export const VERSION_TOKEN = /\b\d+\.\d+(?:\.\d+)?\b/;
export const FIX_WORD = /\b(?:fix(?:ed|es|ing)?|hotfix|patch(?:ed)?|corrected)\b/i;
export const DELIVERY_WORD =
  /\b(?:shipped|deployed|released|is live|went live|rolled out|included|corrected|fixed)\b/i;

/* Incident-relevant records (C5): the records that can set or break a
   timeline/silence window. Cited records, status/assignee transitions,
   client-authored messages and fix/release records are relevant; channel
   chatter and distractor noise never are. */
const QA_RECORD = /\bQA\b/i;
const QA_OUTCOME = /\b(?:failed|failing|passed|green|red|reopen(?:ed|ing)?)\b/i;

export function incidentRelevantEventIds(input: {
  events: Event[];
  claims: Claim[];
  commitments?: Commitment[];
  gaps?: Gap[];
  notes?: SkepticNote[];
}): Set<string> {
  const relevant = new Set<string>();
  for (const claim of input.claims) relevant.add(claim.eventId);
  for (const commitment of input.commitments ?? []) {
    for (const id of [...commitment.sourceEventIds, ...commitment.fulfilmentEventIds]) {
      relevant.add(id);
    }
  }
  for (const gap of input.gaps ?? []) {
    for (const id of gap.eventIds) relevant.add(id);
  }
  for (const note of input.notes ?? []) {
    for (const id of note.eventIds) relevant.add(id);
  }
  for (const event of input.events) {
    if (relevant.has(event.id)) continue;
    if (STATUS_TRANSITION.test(event.text) || ASSIGNEE_TRANSITION.test(event.text)) {
      relevant.add(event.id);
      continue;
    }
    if (QA_RECORD.test(event.text) && QA_OUTCOME.test(event.text)) {
      relevant.add(event.id);
      continue;
    }
    if (/escalat|chas(e|ing)|follow[- ]?up|still (wrong|blank|broken|failing)|no (reply|response|update)/i.test(event.text)) {
      relevant.add(event.id);
      continue;
    }
    if (VERSION_TOKEN.test(event.text) && FIX_WORD.test(event.text) && DELIVERY_WORD.test(event.text)) {
      relevant.add(event.id);
    }
  }
  return relevant;
}
