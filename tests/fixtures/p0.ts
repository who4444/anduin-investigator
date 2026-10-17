/* P0 acceptance fixtures (GAPS.md §3).
 *
 * Minimal, deterministic datasets that reproduce the observed failure
 * patterns. Ratchet tests use them with `it.fails` while the behaviour is
 * still broken; the assertion flips to `it` when the corresponding gap
 * (G-01..G-08) is fixed. Do not "fix" a fixture to make a ratchet pass —
 * fix the pipeline and then flip the test.
 */

import type { Claim, Event, InvestigationScope } from "../../lib/types";

const event = (over: Partial<Event> & { id: string; ts: string }): Event => ({
  investigationId: "p0",
  source: "jira",
  actor: "Lin Chen",
  channel: "MER-101",
  text: "text",
  ...over,
});

const claim = (over: Partial<Claim> & { id: string; eventId: string }): Claim => ({
  investigationId: "p0",
  agent: "investigator",
  type: "root_cause",
  text: "A finding.",
  quote: "text",
  status: "n/a",
  confidence: 0.8,
  verifyStatus: "verified",
  skepticFlag: false,
  ...over,
});

/* F1 — the client chases in the vendor's shared `general` room, not the
 * project channel. Scope anchors (ticket + project channel) must not drop
 * those messages (G-01). The chase carries an actorResolved identity from
 * the client domain, the same signal the recall guard will use. */
export const sharedChannel = {
  events: [
    event({
      id: "f1-jira",
      ts: "2024-09-10T03:00:00.000Z",
      text: "Timezone change merged for release 4.12.",
    }),
    event({
      id: "f1-slack",
      ts: "2024-09-24T16:00:00.000Z",
      source: "slack",
      channel: "meridian-billing",
      actor: "Marcus Webb",
      text: "Sep 24 release is cut; the invoice fix is included.",
    }),
    event({
      id: "f1-general-chase-1",
      ts: "2024-09-26T09:00:00.000Z",
      source: "slack",
      channel: "general",
      actor: "Dana Okoro",
      actorResolved: "Dana Okoro <dana.okafor@northwind.example>",
      text: "Northwind here — invoice totals are still wrong after the Sep 24 release. Anyone?",
    }),
    event({
      id: "f1-general-chase-2",
      ts: "2024-09-30T09:00:00.000Z",
      source: "slack",
      channel: "general",
      actor: "Dana Okoro",
      actorResolved: "Dana Okoro <dana.okafor@northwind.example>",
      text: "Fourth message from Northwind. We still have no reply.",
    }),
    // A genuinely unrelated record: no client evidence touches it, so the
    // recall guard must keep excluding it.
    event({
      id: "f1-distractor",
      ts: "2024-09-28T09:00:00.000Z",
      source: "slack",
      channel: "kestrel-eng",
      actor: "Ravi Patel",
      actorResolved: "Ravi Patel <ravi@acme.example>",
      text: "Acme Kestrel rate limits were raised.",
    }),
  ],
  claims: [
    claim({
      id: "f1-c1",
      eventId: "f1-jira",
      text: "The 4.12 timezone change introduced the invoice totals defect.",
      ts: "2024-09-10T03:00:00.000Z",
    }),
    claim({
      id: "f1-c2",
      eventId: "f1-general-chase-1",
      type: "process_failure",
      actor: "Dana Okoro",
      text: "Northwind chased the totals defect in the shared room.",
      quote: "invoice totals are still wrong after the Sep 24 release",
      ts: "2024-09-26T09:00:00.000Z",
    }),
  ],
  notes: [],
};

/* F2 — the resolved scope has tickets and a channel but no client domain;
 * the client's own mailbox (no ticket reference) must still be in scope
 * because the declared client is known (G-01). */
export const clientMailboxScope: InvestigationScope = {
  client: "Northwind Logistics",
  project: "Meridian Billing",
  ticketPrefixes: ["MER"],
  channels: ["meridian-billing"],
  senderDomains: [],
  confidence: "partial",
  anchors: [],
};

export const clientMailbox = {
  events: [
    event({
      id: "f2-jira",
      ts: "2024-09-10T03:00:00.000Z",
      text: "Timezone change merged for release 4.12.",
    }),
    event({
      id: "f2-email",
      ts: "2024-09-27T03:05:00.000Z",
      source: "email",
      channel: "email",
      actor: "Priya Nair <priya.nair@northwind.example>",
      text: "Totals are still wrong since your release; please confirm the fix date.",
    }),
  ],
  claims: [
    claim({
      id: "f2-c1",
      eventId: "f2-email",
      type: "process_failure",
      actor: "Priya Nair <priya.nair@northwind.example>",
      text: "The client asked for the fix date and got no answer.",
      quote: "please confirm the fix date",
      ts: "2024-09-27T03:05:00.000Z",
    }),
  ],
  notes: [],
};

/* F3 — one promise, three tools, three wordings, three statuses. The
 * ledger must render one row whose outcome is the failing one (G-05). The
 * wordings share too few tokens to cluster under the current Jaccard
 * threshold, so today the ledger shows three contradictory rows. */
export const duplicatePromise = {
  events: [
    event({
      id: "f3-jira",
      ts: "2024-09-20T10:00:00.000Z",
      actor: "Marcus Webb",
      text: "The fix will ship in the Sep 24 release.",
    }),
    event({
      id: "f3-slack",
      ts: "2024-09-21T11:00:00.000Z",
      source: "slack",
      channel: "meridian-billing",
      actor: "Marcus Webb",
      text: "We committed to having invoice totals corrected by September 24.",
    }),
    event({
      id: "f3-email",
      ts: "2024-09-22T12:00:00.000Z",
      source: "email",
      channel: "email",
      actor: "Marcus Webb <marcus.webb@meridian.example>",
      text: "Corrected totals promised for the 24th.",
    }),
    event({
      id: "f3-qa",
      ts: "2024-09-25T09:00:00.000Z",
      source: "slack",
      channel: "meridian-billing",
      actor: "Dana Okoro",
      text: "QA is still failing on the Sep 24 build.",
    }),
  ],
  claims: [
    claim({
      id: "f3-c-jira",
      eventId: "f3-jira",
      type: "commitment",
      actor: "Marcus Webb",
      text: "The fix will ship in the Sep 24 release.",
      quote: "The fix will ship in the Sep 24 release.",
      status: "broken",
      ts: "2024-09-20T10:00:00.000Z",
    }),
    claim({
      id: "f3-c-slack",
      eventId: "f3-slack",
      type: "commitment",
      actor: "Marcus Webb",
      text: "We committed to having invoice totals corrected by September 24.",
      quote: "We committed to having invoice totals corrected by September 24.",
      status: "kept",
      ts: "2024-09-21T11:00:00.000Z",
    }),
    claim({
      id: "f3-c-email",
      eventId: "f3-email",
      type: "commitment",
      actor: "Marcus Webb <marcus.webb@meridian.example>",
      text: "Corrected totals promised for the 24th.",
      quote: "Corrected totals promised for the 24th.",
      status: "unclear",
      ts: "2024-09-22T12:00:00.000Z",
    }),
    claim({
      id: "f3-c-qa",
      eventId: "f3-qa",
      type: "process_failure",
      actor: "Dana Okoro",
      text: "QA failed the Sep 24 build after the fix was promised.",
      quote: "QA is still failing on the Sep 24 build.",
      ts: "2024-09-25T09:00:00.000Z",
    }),
  ],
  notes: [],
};

/* F4 — a promise whose deadline is a partial date ("the end of March").
 * No day is promised, so there is no deadline to compute lateness from;
 * the ledger must render an invalid/absent deadline rather than a number
 * (G-04, G-05). Fixture only until the date hardening lands. */
export const partialDeadline = {
  events: [
    event({
      id: "f4-e1",
      ts: "2024-03-04T10:00:00.000Z",
      source: "slack",
      channel: "meridian-billing",
      actor: "Marcus Webb",
      text: "We will ship the fix by the end of March.",
    }),
  ],
  claims: [
    claim({
      id: "f4-c1",
      eventId: "f4-e1",
      type: "commitment",
      actor: "Marcus Webb",
      text: "The fix will ship by the end of March.",
      quote: "We will ship the fix by the end of March.",
      status: "broken",
      ts: "2024-03-04T10:00:00.000Z",
    }),
  ],
  notes: [],
};

/* F5 — an internal record asserts the client received no reply while the
 * client's own mailbox is outside scope. The negative may not be presented
 * as safe to repeat without a completeness proof (G-03). Fixture only until
 * the negative-completeness check lands. */
export const noReplyNegative = {
  events: [
    event({
      id: "f5-internal",
      ts: "2024-09-29T08:00:00.000Z",
      source: "slack",
      channel: "meridian-billing",
      actor: "Marcus Webb",
      text: "No reply has been sent to the customer yet.",
    }),
    event({
      id: "f5-client-chase",
      ts: "2024-09-27T03:05:00.000Z",
      source: "email",
      channel: "email",
      actor: "Priya Nair <priya.nair@northwind.example>",
      text: "Still waiting for any answer at all.",
    }),
  ],
  claims: [
    claim({
      id: "f5-c-negative",
      eventId: "f5-internal",
      type: "process_failure",
      actor: "Marcus Webb",
      text: "The client received no reply.",
      quote: "No reply has been sent to the customer yet.",
      ts: "2024-09-29T08:00:00.000Z",
    }),
  ],
  notes: [],
};
