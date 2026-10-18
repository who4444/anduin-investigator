# Plan: make the decision layer submit-ready

**Status:** proposed implementation plan
**Goal:** a judge can answer the escalation from the first screen, every number and statement
matches the stored evidence, and the same answer survives repeated runs and judge-supplied exports —
without demo-specific code or hidden failures.

This plan is deliberately scoped to the **decision layer**: the path from stored events, claims,
notes and commitments to the report, reply and audit. The retrieval/evidence architecture stays.
The current report layer computes the same truth in several places (`ReportModel`, `buildBottomLine`,
`buildBriefing`, `buildReportView`, `buildCaseState`); that duplication is the root cause of the count,
state, silence and verification contradictions observed in the live review
([live-run review](live-run-review-2026-10-18.md)). The plan replaces those competing computations with
one model and then fixes the inputs that feed it.

## 1. What "submit-ready" means

The bar is not "the demo looks good". The bar is all of the following, on the built-in scenarios **and**
on judge-supplied exports:

1. **Answer-first.** The first 2–4 sentences state what broke and why, what was promised and whether it
   was kept, what is true now (status/owner/fix/client wait), and the one open question with a next step.
   No sentence is a description of the finding types ("the first record is a technical finding").
2. **Evidence-true.** Every factual sentence cites a finding and therefore stored events/claims. A
   supported-only fact is explicitly marked as needing a check; it is never presented as verified.
3. **Counts agree.** Findings, verified, needs-check, promises, open questions and sources are computed
   once and the same value is shown in the headline, cards, sections and bottom line. The top grouped
   count and the underlying question count are both labelled if both exist.
4. **Client-true.** A declared client is rendered as known even when the project name is not; when a
   project can be inferred from a ticket prefix/channel it is named, not "unknown". Last client contact
   and chasers are computed from client evidence, not from a fragile role guess.
5. **Scope-sound.** The same evidence set and escalation produce the same in-scope records on a repeat
   run unless a human changes the review. Once a ticket project/channel is in scope, its status,
   assignee and comment records are in scope. Client evidence is never silently excluded.
6. **Contradictions surfaced.** A Resolved status while QA still fails, a release claiming the fix while
   QA is red, a promise past its date with no fix, or an unanswered client message is detected by code
   and rendered in manager language.
7. **Promise-true.** The ledger contains promises only (not decisions, status assertions, completed-fix
   reports or client confirmations), duplicates merge, and the broken/kept status is computed from
   delivery evidence. The story, metric and ledger read the same list.
8. **Reply-safe.** No reply is draftable while the client/project is unresolved. No reply introduces a
   date, commitment, status or owner that is not in its cited verified fact. Internal decisions and
   internal blame never appear in client copy. Multi-issue runs require an issue id and are drafted per
   issue.
9. **Coverage-honest.** "Source not in the export", "searched, no matches", "excluded" and "call failed"
   are distinct. No absence statement is made from an unavailable source.
10. **Generalisable.** The same code handles Northwind, the four-tenant workspace, Contoso/Orbit, a vague
    escalation and a 3-record export. No scenario names, ticket prefixes, dates, names or expected
    sentences in runtime code.

**Definition of done:** a real-LLM run set of 5 scenarios × 2 repeats passes all of the above, every
measured count invariant is zero-tolerance, and the full unit/integration/UI suites, lint, typecheck and
build are green.

## 2. Principles and anti-tricks

- **Deterministic truth, model-assisted language.** LLMs may retrieve, propose scope, split issues, and
  draft reply prose. CODE decides trust state, counts, current state, promises, contradictions, silence,
  questions, actions and reply eligibility. The top answer should be deterministic templates over the
  decision model, not free model prose.
- **One model, one number.** Any count/role/state/silence/action/question derived in two places is a bug.
  The report page and API should render one `DecisionModel`; legacy `briefing`/`bottomLine` computations
  become projections of it or are removed.
- **Evidence or unknown.** Every value has a basis (finding/claim/event id) or an explicit unknown reason.
  "Unknown" is a valid answer; a guess is not.
- **Fail closed on client statements.** If a sentence cannot be tied to a verified, client-safe fact,
  omit it or block the reply. Do not invent a holding statement.
- **Human review is a safety valve, not the fix.** Confirming client/project/scope/roles is a real
  product feature and must persist, but the default run must be correct without the manager rescuing it.
- **No demo branches.** No hardcoded Meridian/Northwind/LUM/KESTREL/Contoso/Orbit values, no
  `if (demo)`, no answer-key text in `app/` or `lib/`. Answer keys live in tests/README only.
- **No hiding.** Do not remove the reply, audit, gaps or uncertainty to make the screen look better. Fix
  the derivation or state the limitation clearly.
- **No synthetic verification.** A claim is verified only by the existing quote + actor/time + isolated
  support checks. A "verified finding" is a view over claims, never a new assertion.

## 3. Target architecture

```
events + claims + commitments + gaps + skeptic notes + scope + coverage
                              │
                              ▼
                   DecisionModel (new canonical layer)
     ┌──────────────┬──────────────┬──────────────┬──────────────┐
     │ facts/trust  │ case state   │ promises     │ contradictions│
     ├──────────────┼──────────────┼──────────────┼──────────────┤
     │ story        │ questions    │ actions      │ audit        │
     └──────────────┴──────────────┴──────────────┴──────────────┘
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
          report page/API             reply policy
                                       (verified, client-safe,
                                        per issue, copy gate)
```

### Canonical types (shape, not final names)

```ts
type FactState = "verified" | "supported" | "unverified" | "rejected";

interface Fact {
  id: string;
  category: "cause" | "promise" | "status" | "ownership" | "communication" | "process" | "fix";
  statement: string;              // representative claim text, never a merged paraphrase
  actorId: string | null;
  ts: string;
  source: SourceKind;
  eventIds: string[];
  claimIds: string[];             // all restatements retained
  state: FactState;               // representative state; see §4
  clientSafe: boolean;
  flags: ("conflict" | "needs_check")[];
  basis: string[];                // finding/claim ids for the UI
}

interface PromiseRecord {
  id: string;
  promisorActorId: string | null;
  promisee: string | null;
  object: string;
  deadlineIso: string | null;
  status: "kept" | "broken" | "unclear" | "withdrawn";
  statusBasis: string[];
  claimIds: string[];
  contested: boolean;
}

interface DecisionModel {
  scope: { client: string | null; project: string | null; confidence: ScopeConfidence;
           reviewed: boolean; anchors: ScopeAnchor[]; sources: Record<SourceKind, number> };
  facts: Fact[];
  counts: {
    findings: number; verified: number; needsCheck: number;
    questionGroups: number; questions: number;
    promises: number; broken: number; kept: number; unclear: number;
  };
  state: CaseState;               // one implementation, extended
  story: { sentences: { text: string; findingIds: string[] }[];
           statsLine: string; nextStep: string | null; tooThin: boolean };
  promises: PromiseRecord[];
  contradictions: Contradiction[]; // structured, with finding bases
  silences: { clientWait: Silence | null; project: Silence | null;
              bySource: Record<SourceKind, Silence | null> };
  questions: OpenQuestionGroup[];
  actions: Action[];
  audit: AuditRow[];
  coverage: CoverageReport;
  reply: { eligible: boolean; reason: string | null };
}
```

The page renders `DecisionModel` only. `report.model`, `report.bottomLine`, `report.briefing`,
`report.view` and `report.caseState` should either disappear or be thin adapters over it; no caller
should be able to derive a different count.

### Schema and compatibility

- `migrations/016_decision_layer.sql`: add `gaps.category` (nullable, with a backfill/derivation for
  existing rows) so question grouping does not depend on a text regex. Add any other fields only if
  they cannot be computed at report time (the decision model itself is computed, not persisted).
- Keep the existing `claims.verify_status` three-state contract untouched; facts are a view over it.
- Keep `/api/investigations/[id]/report` backwards-compatible for one release by returning the legacy
  fields as adapters over `DecisionModel`; remove them once the page and tests no longer read them.
- Run `npm run db:migrate` and a DB-backed route test after the migration; never edit an applied
  migration.

## 3.5 Investigation prerequisites (folded into M1–M3)

The live runs show the **retrieval core is close**: all five scenarios completed, every answer-key
fragment was retrieved in at least one run, the linked-ticket comment and shared-channel chases were
found, there were zero rejected quotes, and runs took ~50–60 s. But the investigation output is not yet
decision-grade. These tasks are prerequisites to the decision layer, not optional polish.

### I1. Atomic, quote-grounded claims

The verifier is not the weak link; the claim writer is. Verified-claim rates in the seven runs were
**17–43%** (demo 24–27%, realistic 40–47%, multi 17%, vague 43%, sparse 0%), with 60–83% left as
"supported". Many claims combine an observation (what the record says) with a causal/ownership
conclusion (what the agent thinks it means). Example: a quote saying "merged to 4.12; invoices now use
UTC" is used for a claim that the change "is the identified cause". The entailment check correctly
calls that partial.

- Change the investigator contract to **one quote = one assertion**. Submit the observation separately;
  put the inference in a separate claim only when the quote itself states it (e.g. Marcus literally says
  "MER-87 timezone change is the cause"), otherwise put it in notes as an open question.
- Give positive/negative examples in the system prompt: observation, restatement, inference, decision,
  promise, status. Forbid "this proves/caused/means" language unless the quoted text contains it.
- Validate at submission: if a claim contains causal/ownership language absent from the quote, reject
  it with a message asking for an observation or a note. Do not auto-rewrite into a claim.
- Keep the existing `verify_quote` and isolated entailment checks unchanged. Do not make the verifier
  more lenient to raise the verified count.
- **Do not gloss over the verifier's nuances.** The live runs already show `entailment_refutes`
  (2–3 claims in demo/realistic/multi), `negative_inference` (5 in realistic/multi) and
  `evidence_incomplete` (6 in demo). Examples: a quote that says "Root cause **looks like** the MER-87
  timezone change" was submitted as "attributes the wrong totals to MER-87"; a status change
  "In Progress → Resolved" was submitted as "resolved ten days before the real fix landed"; a client
  chase was submitted as "went unanswered" without a completeness proof. These are not verified facts;
  they need a narrower quote or a separate supporting record.
- A negative claim ("no reply", "never happened") must be phrased as **"no reply in the records
  searched"** and carry the coverage/scope proof; otherwise it is a note, not a finding. This is the
  G-03 rule applied at the investigator boundary.
- Target: on the built-in scenarios, verified claims ≥ 55–60% and supported ≤ 40%, without losing any
  answer-key fact, and zero `entailment_refutes` claims presented as safe/top-story facts. Sparse can
  remain mostly supported; it is genuinely thin.

**Tests:** fixtures from the current runs with known overreaching claims must be rejected/split; a
verified observation plus a supported inference must not downgrade the observation; answer-key claim
recall unchanged.

### I2. Tool result semantics and coverage

The tools conflate "not in this export", "excluded by scope", "source empty" and "tool error":

- `get_issue(MER-101)` in the sparse run returns "belongs to a different client or project" even though
  MER-101 simply is not in that 3-record export.
- The vague run invents plausible keys (`VEG-404`, `KST-303`, …), gets "No stored issue", and then
  reports them as "never searched … could contain the actual 5.3.3 contents". They do not exist in the
  export; the investigator's note is speculation.
- Coverage marks Slack `available: 0, searched: true` for the sparse run and the investigator says
  "all Slack searches returned zero", implying an absence that was never testable.

- Return a structured status from source tools: `ok`, `not_in_export`, `excluded_by_scope`, `empty`,
  `failed`. For `get_issue`, check the full registry before filtering: if the key exists but is excluded,
  say "exists but excluded — the manager can add it back"; if it is absent, say "not in this export";
  if the source is absent, say "this source was not part of the export."
- Apply the same rule to channels/threads. Coverage states must match.
- Prompts: never infer absence from `excluded_by_scope` or `not_in_export`; a missing key referenced in
  a record is a legitimate "referenced but not available" note; an invented key is not a gap.
- Validate notes: drop/label ticket-key speculation that is not referenced by any stored record.

**Tests:** sparse `get_issue` result, vague invented keys, unavailable Slack, and an excluded record
with a valid add-back path.

### I3. Gap-driven retry

All seven runs had `needsRetry: false`; the retry only fires when an investigator kind has **zero visible
claims**. Every kind produced claims even when decision-relevant angles were missed (SUP-2231, the
LinkedIn-style invented keys, the skeptic's "never searched" note). The AGENTS.md promise — "one retry
pass when key questions remain open" — is not implemented at the question level.

- After verify, compute retry reasons from: unresolved plan hypotheses/issues, failed/available
  unsearched queries, skeptic `unanswered`/`never-searched` notes that are answerable, and a question
  group with no visible fact. Retry only the relevant investigator kind(s), with explicit queries and
  one extra pass total.
- Do not retry just because a claim is "supported"; that is a claim-quality issue (I1), not a missing
  record.
- Record the reason and the queries in the stage log; surface "retried for X" in How this was produced.
- Cap: one retry, targeted; if it adds nothing, stop and keep the gap.

**Tests:** a missing linked ticket triggers exactly one targeted retry; a fully covered run does not;
the retry does not duplicate claims or rerun completed investigators.

### I4. Skeptic reliability

The realistic case is the clearest signal: first run `{"flagged":0,"issues":0}`; repeat run
`{"flagged":14,"issues":16}` on the same data. A zero from one LLM pass is not evidence of no
contradiction. The decision layer's deterministic detectors (C3) must be the source of truth, but the
investigation should also not present a clean bill of health from a single pass.

- Run deterministic contradiction checks in the verify/investigate boundary (premature resolution,
  release-vs-QA, missed promise, unanswered client). Feed them into the skeptic prompt as a checklist;
  merge with the model notes.
- If the skeptic returns zero and deterministic checks also return zero, say "no contradiction found
  in the records searched" — never imply exhaustive verification.
- Add a focused second skeptic pass over the top claims only when a detector fires or the first pass
  finds nothing; cap cost.
- Sanitize notes before they enter the report (C4).

**Tests:** the realistic fixture must flag the LUM-811 resolution vs QA re-run even when the skeptic
returns zero; the multi audit must remain readable.

### I5. Plan date anchoring and identity

- `deriveDateWindow`/the analyst prompt use `investigation.createdAt`
  ([`lib/agents/analyst.ts:67`](../lib/agents/analyst.ts#L67)). The first realistic run planned a
  **2026-09-18 → 2026-09-28** focus window for 2024 records; the repeat happened to use 2024 dates.
  Anchor relative phrases to the latest incident-relevant event (or an explicit as-of), and validate a
  model-returned window against the registry timestamps; reject a window wholly outside the record
  range.
- Canonicalize commitment promisors by actor id. The demo produced `Lin Chen` and
  `Lin Chen <l.chen@…>` as two promises for the same commitment. Decode HTML entities before display and
  identity matching; no address in metrics.
- Add tests for 2024 data and the identity-trap fixture.

### I6. Retrieval evaluation

Add answer-key retrieval checks to the real-run harness, separate from the decision assertions:

- Did the agents read the root-cause record/comment, the promise record, the release/QA records, the
  handoff/leave record, the client chases and the call reference? Record yes/no and the claim/event id.
- Track verified/supported/rejected per investigator and per issue.
- Track failed/never-searched queries and invented keys.
- A run fails the investigation gate if a must-have record was never read, not merely if the report
  prose is weak.

## 4. Workstream A — trust state, facts and counts

### A1. Assertion clusters instead of "one claim per event"

The current model groups all claims for an event and downgrades the event to `supported` if **any**
claim is supported ([`lib/report/model.ts:395`](../lib/report/model.ts#L395-L401)). Three investigators
restating one fact with different confidence therefore erase verified findings. Replace this with:

- An **assertion key** = `(eventId, category, normalized claim text)`. Same event/category but a
  materially different assertion is a different fact.
- A **fact cluster** = assertions that assert the same thing across records (same actor + same
  normalized object + high text similarity). The cluster holds all claim/event ids.
- The representative claim is chosen by: verified > supported > unverified, then confidence, then
  recency. A supported restatement never downgrades a verified representative.
- If two claims in the cluster assert incompatible things (e.g. "resolved" vs "still failing"), emit a
  `conflict` flag and keep both claim ids; do not silently choose one.
- Rejected claims remain in the evidence list but never form a fact.

**Acceptance:** a fixture with one verified claim and two supported restatements on the same event/claim
category yields one verified fact. The count assertion `verified === facts.filter(state==="verified")`
holds. Add this fixture to `tests/report-model.test.ts` and a new `tests/decision-facts.test.ts`.

### A2. Client-safe vs machine-safe

Add an explicit `clientSafe` classification to each fact (CODE, not model):

- **Allowed in the client answer/reply:** cause, fix, promise, client-visible status, client
  communication.
- **Not allowed in client copy:** process/coverage/ownership/internal-decision facts, QA/test chatter,
  internal roles, "we searched" notes, agent observations.
- A supported fact can be `clientSafe` but is still labelled "needs check"; only verified +
  client-safe facts enter "You can say".
- Preserve the verifier's `verifyError`: `entailment_partial`, `entailment_refutes`,
  `negative_inference`, `evidence_incomplete` are different states. `entailment_refutes` is not a
  neutral "needs check" — it is **not supported by its quote** and must not enter the top story,
  "You can say", or a client reply. It can remain in the evidence list with a clear "quote does not
  support this claim" label, or be replaced by a narrower claim that does pass. Negative inferences
  require a completeness/coverage proof (G-03).

**Acceptance:** the realistic "Coverage was thin during the failure window" fact never appears in
"You can say"; the demo QA-rule decision never appears as a safe reply sentence.

### A3. One count object and invariant assertions

- Build `counts` from the exact lists (`facts`, `verifiedFacts`, `needsCheckFacts`, `questions`,
  `questionGroups`, `promises`) in one function.
- Assert `counts.findings === facts.length`, `counts.verified === verifiedFacts.length`, etc., at
  construction time in all environments. Throw on mismatch; tests fail immediately.
- Remove the duplicate count derivation in `buildBottomLine`/`buildBriefing`; make them read
  `DecisionModel.counts`. If legacy API fields must remain for compatibility, derive them from the same
  object and add a test that they equal the model.
- Label grouped vs raw counts explicitly: `"Open questions"` = groups, with a details line
  `"N themes, M individual questions"`; never show 4 at the top and 7 in the bottom without labels.

**Acceptance:** a test asserts the top stats line, scoreboard and bottom-line question count all come
from one object. The seven real runs produce zero mismatches.

## 5. Workstream B — scope, project, client and roles

This is the largest correctness item. The observed run-to-run scope difference is not acceptable in a
trust product.

### B1. A deterministic scope graph

Replace the anchor-component heuristic in [`lib/pipeline/scope.ts:609`](../lib/pipeline/scope.ts#L609-L748)
with a deterministic graph:

- **Nodes:** declared client, project names, ticket prefixes, ticket keys, channels, sender domains,
  email threads.
- **Edges:** co-occurrence in a record, ticket refs in a record, thread membership, plan hypotheses,
  manager overrides.
- **Seeds:** declared client (linked domains/channels/prefixes), escalation ticket keys/domains,
  manager review includes, learned scopes. The analyst plan's ticket keys/channels become seeds after
  the plan stage (B4).
- **Selection:** the connected component(s) containing seeds. If several components contain a seed,
  keep all of them; never drop a declared/learned/escalation anchor because it does not share a record
  with another seed.
- **Project units:** once a ticket prefix is selected, every record of that prefix is in scope; once a
  channel is selected, every record in that channel is in scope; once an email thread is selected, every
  message in it is in scope. A linked ticket (e.g. LUM-804 referenced by LUM-811) is included as a ticket
  unit at one hop, but it does not automatically pull in its whole unrelated project.
- **Noise stays searchable but not incident-active.** Channel membership keeps noise retrievable; it must
  not determine the timeline/silence (see E3).

**Acceptance:** two calls with the same events and two plausible model proposals produce the same
selected client/project/ticket prefixes/channels and the same in-scope event ids. The demo fixture keeps
MER status/assignee/comment records; the realistic fixture keeps LUM-804 and the qa/assignee records.
Add a deterministic `tests/scope-determinism.test.ts`.

### B2. Separate client and project resolution

`buildClientModel` currently requires **both** client and project
([`lib/report/model.ts:572`](../lib/report/model.ts#L572-L588)). Split it:

- `clientKnown` = declared client or a verified client-domain/name anchor.
- `projectKnown` = explicit project, or a selected ticket prefix/channel with a readable label.
- A client with no project is still resolved; the project card says "Not named; scope is MER /
  meridian-billing" rather than blocking all role/state cards.
- Only when no client can be established at all does the "Confirm client" action appear, and the form
  must be prefilled with the declared client and registry candidates.

**Acceptance:** the demo shows "Northwind Logistics" as the known client and "MER / meridian-billing" as
the selected scope even if the model never returns a project string. The API and page expose the same
scope.

### B3. Plan-assisted scope refinement

The analyst plan names the target tickets (MER-87/MER-101 in both demo runs), but scope runs before the
plan. Add a code step after the plan and before the investigators:

- Extract ticket keys and channels the plan names; validate they exist in the registry.
- Add them to the scope graph only if they share a record, thread, or reference with a client seed, or
  if the declared client's records reference them.
- Recompute the split deterministically and record the added anchors in the plan/review.
- If the plan names a ticket outside the seed component and does not touch client evidence, do not add
  it; record why.

This is not a demo patch: any escalation with a ticket reference gets the same treatment, and any plan
that names the project can recover project records that a model proposal missed.

**Acceptance:** the demo scope always includes MER and `meridian-billing`; the realistic scope keeps
LUM-804; a plan naming a distractor ticket does not pull in another tenant.

### B4. Role resolution with evidence and confidence

The current `domainIsClient && channels.slack -> unknown` rule
([`lib/report/model.ts:526`](../lib/report/model.ts#L526-L530)) correctly avoids the demo's engineered
identity trap but also marks the real client (Dana in realistic/multi) unknown, which breaks last
contact, chasers and the audit. Replace it with an evidence scorer:

- Domain evidence: client domain vs internal/vendor domain.
- Channel evidence: participation in an internal-only project channel vs a shared/client channel.
  Define "shared" from client-domain messages in that channel; do not let an internal-domain actor make a
  channel internal against the client.
- Email direction: add `from`, `to`, `cc`, `direction` to email event meta in the parsers
  ([`lib/ingest/email.ts`](../lib/ingest/email.ts)); an inbound message to the vendor is stronger client
  evidence than an outbound message from a client-domain alias.
- Roster/manager override and learned identities.
- Model suggestion, advisory only, confidence-thresholded and recorded; never a free pass.
- If the signals conflict, role is `unknown`, but **state still computes last client contact from the
  strongest client evidence** (B5). Ambiguity should reduce what we assert, not erase known client
  contact.
- Add an explicit `roleEvidence` list to `ReportActorModel` for the UI ("client domain", "inbound
  email", "shared channel", "ambiguous: also posts in meridian-billing").

**Acceptance:** Priya/Dana are client in the fixtures; Lin Chen/Marcus are internal; when a role is
genuinely ambiguous the card says "role ambiguous" with the evidence, and `lastClientContact` can still
be known from client evidence. Add role fixture tests for demo, realistic, multi.

### B5. Last client contact and chasers from client evidence

- `lastClientContact` uses incident-relevant `clientEvidenceFor` (domains, client actors, inbound
  direction, shared channels) rather than `actor.role === "client"` in
  [`lib/report/model.ts:850`](../lib/report/model.ts#L850-L887). General chatter in a shared channel is
  not a client contact.
- Chasers count only actors with client evidence on **incident-relevant** records (client messages about
  this issue, not general channel chatter); if no client identity is available, the metric is
  "not determined (client unresolved)" — never an internal actor. Fixes sparse "3 from Lin Chen" and
  keeps the realistic client's last contact from becoming a noise message.
- Display a clean name and date; no email address in the metric.
- Add `clientEvidence` to the model so the page can explain why someone is counted.

**Acceptance:** realistic last client contact = Dana Okafor with a date; demo = Priya Nair; sparse
chasers = 0 / not determined, never Lin Chen; multi = Dana.

### B6. Pre-run review UX

- Show scope as a set of units (project/prefix/channels/domains), not only a count.
- Highlight "Project MER found but not included" / "client domain found in excluded records" with a
  one-click add.
- Persist confirmed scope anchors and show "Confirmed by you" only after a real confirm.
- Prefill client/project from declared client and registry candidates.
- The default path must not require add-backs to be correct; the review is for exceptions.

**Acceptance:** a Playwright test confirms the demo scope review shows MER, adds nothing by default,
and still produces the complete status/state answer. A second run reuses the confirmed anchors.

## 6. Workstream C — state, promises, contradictions, silence, questions

### C1. One case state, with claim fallback

Replace the parallel `buildState` ([`lib/report/model.ts:766`](../lib/report/model.ts#L766-L925)) with the
existing `buildCaseState` ([`lib/report/case-state.ts`](../lib/report/case-state.ts)) extended as follows:

- `currentStatus`: latest status transition; if none, the latest verified status/ownership claim
  ("marked resolved", "reopened") with source and actor. Label the basis (Jira transition vs Slack
  message). Do not treat a client complaint as a status.
- `owner`: latest assignee transition; else a verified ownership/handoff claim; else
  "No owner recorded" plus "Last status change by X" as a separate, labelled field. Never silently
  claim an owner.
- `latestFix`: vendor-authored fix/delivery evidence; if a later QA result contradicts it, keep the
  record but label "attempted fix, QA failed" and do not present it as the latest working fix. The
  realistic 5.3.4 fix remains the latest fix; the failed 5.3.3 does not.
- `lastClientContact` and `lastInternalUpdate`: use client evidence, not role, and use event actors as
  the fallback when the finding doesn't exist.
- `asOf`: latest incident-relevant record, not channel noise.
- Return `source`, `basis` and `unknownReason` for every field; the page should not invent its own copy.

**Acceptance:** demo A after scope fix shows Resolved with a Jira basis; demo B shows Resolved and
"No owner recorded; last status change by Marcus Webb"; realistic shows Resolved/Ravi/5.3.4/Dana;
sparse shows honest unknowns. Existing `case-state` tests expand.

### C2. Promise ledger: promise-only, canonical identity, code-computed outcome

- Tighten `isPromiseLike` ([`lib/pipeline/commitments.ts`](../lib/pipeline/commitments.ts)):
  remove `keep .* open` as a promise cue; a decision, a status assertion ("release is cut; fix
  included"), a completed-fix report and a QA result are not promises. Require a forward-looking object
  plus a deadline/date phrase or an explicit "will/commit/schedule" statement.
- Merge by canonical actor id + normalized object + deadline + issue id, not raw name/email. The demo
  duplicate `Lin Chen` / `Lin Chen <…>` must be one promise.
- Compute status in code:
  - `kept`: evidence of delivery before/on the deadline.
  - `broken`: asOf after the deadline and no delivery evidence, or a verified record that the fix did
    not work.
  - `unclear`: conflicting or absent evidence.
  - contested when sources disagree; never let a broken outcome disappear.
- The ledger, metric, story and reply read this one list. The bottom line `2 of 2`/`3 of 3` must equal
  the cards/ledger.

**Acceptance:** demo A has 1 promise; demo B has exactly Lin Chen's promise plus any genuine additional
promises (not the keep-open decision or the release status); realistic has 2 with 1 broken/1 kept or the
canonical set; duplicates merge; status assertions are rejected with a test.

### C3. Deterministic contradiction detection

Keep the skeptic LLM for soft issues, but add a `lib/report/contradictions.ts` whose detectors run on
the canonical facts/events:

- **premature_resolution:** status Resolved/Closed while a QA failure or client "still broken" record
  exists after (or same day) and no verified pass record.
- **release_fix_claim:** a release message says the fix is included while a QA record says the same
  build still fails.
- **missed_promise:** promise deadline < asOf and no delivery evidence.
- **unanswered_client:** client messages after the last vendor reply, or no reply at all; cite the
  messages and the absence boundary.
- **closure_unverified:** Resolved with no QA/verification record.
- **handoff_missing:** an owner on leave/no handoff while the ticket stays open; cite both.
- **status_reversal:** a status transition and a later claim/status contradicting it.

Each contradiction has a stable id, severity, finding/claim/event bases, and manager-facing text. The
audit renders these plus sanitized skeptic notes. If detectors find nothing and the skeptic returns
nothing, say "No contradiction detected in the records we searched" — never "No communicated update was
contradicted" as a blanket claim.

**Acceptance:** realistic shows the LUM-811 Resolved vs Sam Rivera QA contradiction; demo shows
MER-101 Resolved vs QA; the audit text has no "Claim 4", `e_…`, "stored findings" or agent voice.
Add `tests/contradictions.test.ts` and a UI assertion.

### C4. Sanitize skeptic output

- Map `claim_index` to the representative finding title, not "Claim N".
- Strip agent voice ("I was unable", "the source lookup") and use source labels ("the Jira search for
  SUP-2231").
- Drop notes that reference raw ids/claim numbers after mapping; do not replace them with "a stored
  record" placeholders ([`lib/report/gaps.ts`](../lib/report/gaps.ts) currently does).
- Deduplicate near-identical notes; cap.
- The skeptic remains advisory; deterministic detectors are required. A zero-finding skeptic must not
  suppress the audit when a detector has fired.

**Acceptance:** multi audit reads like a manager note; realistic's premature resolution is present even
if the skeptic returns zero.

### C5. One silence definition

Replace `computeSilence` over all scoped events and the different bottom-line calculation with one
`lib/report/silence.ts`:

- `incidentRelevant(events)` = events cited by claims/commitments/gaps, status/assignee transitions,
  client messages, fix/release records; exclude channel chatter and distractor events.
- `clientWait` = last client message → first vendor response after it, or asOf if none.
- `projectSilence` = longest gap between incident-relevant records.
- `sourceSilence[source]` = longest gap for that source among incident-relevant records (the 13-day Jira
  silence in the demo; the 8-day project silence in realistic).
- Choose one `headlineSilence` by decision impact (client wait first if a client is waiting; else the
  longest project/source silence), and expose all three with distinct labels. The **client wait** is the
  decision metric; the **project/source silence** is the process metric. They are not the same number
  and must never be conflated.
- Never say "no recorded activity" when noise exists; say "no incident activity" and explain the record
  set.

**Acceptance:** demo displays the ~13-day Jira/project silence and the client wait as separate,
consistent values (both from the same `silences` object); realistic displays the 8-day Sep 9→17 project
silence and the client wait separately; noise events do not set or break either. Add silence tests with
the coffee-machine and distractor messages.

### C6. Open questions: structured categories, one count

- Extend `GapInput`/`Gap` with a `category` (`scope | coverage | state | technical | commitment |
  communication | ownership | other`). Agents/tools set it; legacy gaps get a deterministic fallback,
  not a text regex.
- Group by category; use explicit next-step copy per category. Do not match the word "identified" to
  "Client and project".
- Only add system questions that are true:
  - client unresolved only when client is actually unknown;
  - owner unknown only when truly no owner/last actor;
  - fix unknown only when no fix;
  - no client contact only when no client evidence;
  - never-searched only for sources that were available but not searched.
- Deduplicate questions by normalized meaning; cap groups (8) and questions (20/30 raw) consistently.
- Counts: `counts.questionGroups` and `counts.questions` both in the model; the UI uses groups for the
  card and shows "N themes · M questions"; the bottom line uses the same object.

**Acceptance:** realistic no longer says "What remains open: client and project" on a scoped run;
demo top 5 and bottom use the same group/raw pair; sparse 34 vs 6 becomes one labelled pair.

## 7. Workstream D — answer-first story

### D1. Story spec

Build `lib/report/story.ts` from `DecisionModel`, deterministic:

1. **Cause:** the highest-ranked verified cause fact: `<subject> was caused by <cause> on <date>.` If
   only supported: `The evidence points to <cause>, but that finding still needs a check.` If none:
   `The records do not establish a technical cause.`
2. **Promise:** from the canonical ledger: `<promisor> promised <promisee> <object> by <deadline>; it
   was <broken/kept/unclear>.` If none: `No client-facing promise was recorded.`
3. **Now:** from `CaseState`: `As of <date>, <status>; <owner/fix/client wait>.` Use only known fields;
   unknown fields are stated, not guessed.
4. **Open:** the highest-impact question and the action: `Still unknown: <question>. Next: <action>.`

Each sentence carries finding/claim/event ids. No sentence describes a finding type, no "first record"
or "latest record" language, no severity-order "then".

### D2. Chronology rules

- Sort by timestamp for any "then"/"after"/"before" statement. Never use `findings[0]`/`findings[last]`
  from a severity-sorted list.
- A "latest" record must be the max timestamp among the relevant set, not the last UI sort.
- If timestamps are date-only or unknown, do not imply an order; say "on/around <date>".
- Add a property test: for any story with "then", the second date ≥ first date.

### D3. Thin evidence

- If fewer than 4 relevant records or no verified fact, the first sentence must say the account is
  thin; do not pad with metadata.
- "You can say" empty means "No verified, client-safe statement is available", not "nothing is
  verified" when verified internal facts exist.

### D4. Tests

- Golden deterministic fixtures for demo A/B (same scope), realistic, sparse; assert the story contains
  the answer-key facts, not exact prose.
- Snapshot the deterministic story for a fixed recorded claim set (not for live model output).
- UI test: the first screen contains cause, promise outcome, current status and next step.

## 8. Workstream E — reply safety and multi-issue

### E1. Eligibility

`reply.eligible` is true only when:

- client resolved and project/scope named;
- at least one verified, client-safe fact exists;
- no blocking client-evidence exclusion;
- for multi-issue, an explicit issue id is supplied.
Otherwise `/reply` returns 422 with the specific reason and the UI shows "Confirm client" / "Not enough
verified facts" instead of a draft button.

### E2. Fact pack and validation

Build the reply from a typed safe fact pack:
cause/fix/promise/status/client communication only. Exclude process, coverage, internal decisions,
QA internals, role guesses and agent observations.

Validate each sentence:

- all cited claim ids are verified, unflagged, unreviewed and client-safe;
- no number/date not in the cited fact (existing);
- **status truth:** any status word must match `CaseState` now, not a historical quote. This fixes
  "the issue remains open" after it was resolved and "we are verifying" when no such action exists;
- **commitment truth:** any future/commitment/date sentence must cite a verified promise or the
  canonical open commitment; otherwise drop it or block the sentence. No implied update dates;
- **owner truth:** no owner/assignment claims unless the canonical owner is known;
- **tone:** no internal blame, no "resolution proceeded nonetheless", no QA/process narration;
- **sign-off:** vendor/team identity from scope (Meridian/Lumen/Orbit) or a neutral "Support team";
  never the product brand "Anduin";
- if fewer than one sentence survives, return an explicit no-draft result, not a generic apology.

### E3. Multi-issue

- `POST /reply` requires `issueId` when `issues.length > 1`; a missing/unknown id is 400/422.
- Drafts store under `issue_report_extras` keyed by issue; the all-issues view has no copyable reply.
- Each issue's reply fact pack is filtered by `issueId`; no cross-issue facts.
- The report model is per issue plus a case aggregate with consistent counts.

### E4. Tests

- Demo A: a sentence "the issue remains open" is rejected or must not be generated; an invented "we
  will provide an update" is rejected.
- Demo B: no invented October 2 date; no "we are verifying".
- Unresolved client: 422, no draft.
- Multi without issueId: 422; per-issue citations correct.
- Sign-off is vendor/neutral.
- Copy gate remains approval-based.

## 9. Workstream F — coverage, plan date, robustness

### F1. Coverage states

- `searched` only when a tool call returned a result count (not just was attempted); add
  `searched: false` when `available === 0` and the source is not part of the export.
- States: `not-in-export` (no records/source), `available-not-searched`, `searched-with-results`,
  `searched-empty`, `failed`.
- Agent prompts receive the state; no "Slack returned zero" when Slack was unavailable.
- The report says "Slack was not part of this export; no conclusion about Slack."
- `neverSearched` only for available sources that were not searched.

**Acceptance:** sparse never says Slack was searched; gaps say not in export; coverage tests.

### F2. Plan date anchor

`deriveDateWindow` uses `investigation.createdAt`
([`lib/agents/analyst.ts:67`](../lib/agents/analyst.ts#L67)); this produced a 2026 window for 2024
records. Anchor relative phrases to the latest **incident-relevant event** (or an explicit as-of date),
label it "relative to the latest record", and pass that reference into the analyst prompt. If the
escalation has explicit dates, use them as given. Tests with 2024 data must produce 2024 windows.

### F3. Sparse and weird inputs

- Chasers: client evidence only; unresolved → "not determined", never an internal actor.
- Gaps: dedupe/normalize, cap, rank; no "a stored record" placeholders; no 34 vs 6.
- Actions: never "Resolve the conflict around <arbitrary finding label>"; see §10.
- Scope copy: one "confirmed by you" only after a real confirm; blank form prefilled; no duplicated
  phrase.
- HTML entities (`&lt;…&gt;`) decoded at display/commitment identity; no address in names.
- Actor display names used in all metrics.
- Fix the synthetic demo copy: the start-page escalation currently starts "Meridian reports…" while
  the declared client is Northwind Logistics. Say "Northwind reports…" and make the vendor/project
  explicit; update the UI fixture. This is scenario data correctness, not a runtime special case.
- Intake labels must distinguish "Client (the external party)" from "Project/product (optional)"; the
  current single "client" field makes the manager declare one party while the escalation names another.

### F4. Coverage/retry for multi-issue

If time remains: per-issue coverage counts, per-issue retry decision, and a cross-issue bucket for
shared evidence. The plan treats this as P1 unless the submission demos multi-issue.

### F5. Unscoped / multi-tenant behaviour

The vague run honestly says "no client or project could be identified", but then produces a single
story that mixes Bright Market and Vertex facts, a combined promise ledger and a confident client
reply. Honest scope disclosure is not enough.

- Detect tenant/engagement clusters in the registry (email domains, ticket prefixes, channels and
  client-name mentions).
- If no client seed is resolved and more than one cluster exists, do **not** build a single
  `DecisionModel` across them. Build candidate engagement cards ("Bright Market / LUM", "Vertex / RAV")
  with evidence counts and ask the manager to confirm one.
- Until confirmed, show no single-client answer, no cross-tenant ledger/story and no reply. A summary
  may say "N candidate engagements; the escalation does not identify which one."
- If the manager explicitly chooses an engagement, persist that scope and run the normal decision model.
- In a truly single-tenant registry, an unscoped run may still show the one tenant's facts, labelled
  "single engagement in the export; client not confirmed."

**Acceptance:** the vague scenario produces candidate engagements and does not mix Bright Market and
Vertex in one story or reply. Add a fixture with two tenants and an eval assertion that the answer is
either grouped by tenant or asks for confirmation.

## 10. Workstream G — actions and audit

### G1. Action policy

Build actions from the decision model, not from arbitrary finding labels:

- If client is waiting/unanswered: "Reply to <client> with the verified status and the open question."
  This is a real action, not a new promise.
- Broken promise: "Agree a new date with <promisor> for <object> and tell <promisee>." Do not invent the
  date.
- Contradiction: "Resolve <specific contradiction> before repeating the resolution."
- Missing owner: "Assign an owner for <ticket>."
- No urgent action only when resolved, no contradiction, client contacted, no open question.
- Each action: finding ids, owner/due if recorded, impact, full text (not truncated in the data). The UI
  may show a short label plus an accessible full sentence.

**Acceptance:** demo "resolve MER-101 status contradiction / confirm fix with client"; realistic "agree
a new date for the Sep 20 promise"; no "Resolve the conflict around Ravi Menon owned the VAT…"; no
"No urgent next step" while the client is unresolved.

### G2. Audit

- Render deterministic contradictions first, then sanitized skeptic notes.
- For each row: finding title, the two sides, source/date, and a manager next step.
- No raw ids, claim numbers, "stored record" placeholders, or internal agent voice.
- If the client is unresolved, still show internal contradictions with an "internal only" label.

## 11. Sequencing and milestones

Estimates assume one senior full-stack dev; two can parallelise B (scope/roles) and C (state/promises)
after A1/A3 land.

| Milestone | Work | Estimate |
|---|---|---:|
| **M0 — Contract & instrumentation** | DecisionModel types, invariants, decision fixtures from the seven runs, real-run harness in `scripts/`, count assertion, I6 retrieval checks | 0.5–1 day |
| **M1 — Scope, project, client, roles** | B1–B6 + I2 tool semantics + I5 plan/identity + determinism tests; unblocks state and demo | 3–4 days |
| **M2 — Trust/facts/counts** | A1–A3 + I1 atomic claims + tests; verified findings and one count object | 2.5–3 days |
| **M3 — State/promises/contradictions/silence/questions** | C1–C6 + I3 retry + I4 skeptic + tests | 3–3.5 days |
| **M4 — Story, actions, audit** | D1–D4, G1–G2 + golden tests | 1.5–2 days |
| **M5 — Reply and multi-issue** | E1–E4 + tests | 1.5–2 days |
| **M6 — Coverage, plan date, robustness** | F1–F5 + tests | 1–1.5 days |
| **M7 — Real-run verification and freeze** | 5 scenarios × 2, answer-key checks, screenshots, fixes | 1–1.5 days |
| **Total** | | **~14–18.5 dev days one dev; ~9–11.5 with two** |

**Submission-critical slice:** M0 → M1 → M2 → M3 → M4 → M5, then M7 = **~13–17 dev days** one dev
(~8–11 with two). M3 is not optional: the story and reply consume the canonical state and promise
ledger. M6 is required before claiming judge-supplied-export readiness; it can run in parallel with
M4/M5. Do not cut M1, M2 or M5 — they are the observed demo-breaking paths.

**Critical path:** I1/I2/I5 (investigation hardening) → B1 (scope units) → C1 (state) → D1 (story) →
E2 (reply validation), with A1/A3 running in parallel. Do not build more UI before the model is single-source; the current UI is already
strong.

## 12. Verification protocol (the gate)

### 12.1 Deterministic fixtures

Export the seven real runs (events, claims, commitments, gaps, notes, scope) into
`tests/fixtures/decision/{demo,realistic,multi,vague,sparse}.json` with a small script. These are not
answer keys in the app; they are regression data. Build the `DecisionModel` from the fixture and assert
the invariants below.

### 12.2 Required automated invariants

The decision layer is pure, so most assertions are unit/integration over recorded events+claims. The
observable contract is still tested through the real interfaces: a route test builds the report API from
a migrated Postgres with the recorded fixtures, and a Playwright test renders the page and asserts the
first screen, counts and reply gate (per AGENTS.md's end-to-end rule). Do not assert only helper
functions.

- `counts` equal the lists they summarize (findings, verified, needsCheck, groups, questions, promises).
- every story sentence has ≥1 finding id; every finding id exists; every fact has a claim/event id.
- no verified fact has a rejected/unverified representative; no supported fact is in "You can say".
- scope: all selected ticket-prefix records are in scope; no client-evidence exclusion; deterministic
  repeat.
- state: current status is the latest status evidence; owner is known only with assignee/ownership
  evidence; last client contact is a client evidence event.
- promises: only promise-like objects; merge key works; status computed; no decision/status accepts.
- contradictions: the expected premature resolution/release conflict exist in demo/realistic.
- silence: expected window is within the accepted range; top and bottom use the same object.
- reply: zero invented dates/commitments/status; blocked when client unresolved; per-issue id required.
- coverage: unavailable ≠ searched; no absence from unavailable sources.
- no cross-tenant claims in any scoped run.

### 12.3 Real-LLM eval (not CI, run before submission)

Keep/extend [`.eval/review-run.mjs`](../.eval/review-run.mjs) or move it to
`scripts/decision-eval.ts`. For each scenario run twice and assert answer-key facts:

- **Demo:** MER-87/UTC/4.12; promise Sep 24 broken; resolved then QA fails; 4 chases; undocumented call
  gap; current status Resolved; client Northwind; ~13-day Jira/project silence.
- **Realistic:** KESTREL/LUM-804; 5.3.3 failed; 5.3.4 fixed; Resolved/Ravi; Dana 3 chases; 8-day
  Sep 9→17 silence; 0 cross-tenant.
- **Multi:** exactly 2 issues; each root cause/owner/next step; per-issue reply; no mixed tenant.
- **Vague:** unscoped honest line; no confident wrong-client answer; no reply; cross-tenant grouped or
  refused.
- **Sparse:** 3 records; no invented cause; no Slack absence; chasers not internal; no reply.

The eval reports the same metrics as the invariants and saves screenshots. A run is a failure if any
count contradicts, any reply invents a fact, or the first screen lacks the answer.

### 12.4 Manual QA

- One reviewer who did not implement it clicks each scenario cold.
- Check the first screen without scrolling: can they say what happened, what was promised, what is true
  now and what is unknown?
- Check the reply with a "would I send this?" review; check the audit against the answer key.
- Check mobile print/print view and the evidence drawer.

## 13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Scope model variability returns | Seed graph + plan refinement + deterministic selection; never drop declared anchors; repeat test |
| Role ambiguity remains | Evidence scorer + inbound direction + human override; state/last contact use client evidence, not role |
| More facts/counts confuse UI | One model; per-record grouping for display; counts from facts; labels "themes/questions" |
| Existing tests encode old behavior | Update tests with the new contract; keep old assertions where they still hold; add fixtures from real runs |
| Multi-issue scope/coverage complexity | Case-level scope/coverage with explicit labels; per-issue model; defer per-issue retry if needed |
| Reply policy too strict → no reply | Return explicit "not enough verified client-safe facts" + what to check; don't invent |
| Latency | All new logic is local; no new LLM calls in decision layer; only optional advisory proposals |
| Answer-key overfitting | Tests use general rules; no scenario constants in `app/`/`lib/`; judge exports in eval |

## 14. Anti-goals (explicitly out of scope for submission)

- Continuous sync/real-time, auth, multi-project management.
- A perfect role classifier for adversarial vanity domains; the requirement is honest ambiguity and
  usable client evidence, not omniscience.
- A PDF/print redesign; current print tests stay.
- More report sections. Remove duplicate derivations before adding UI.
- Changing the retrieval agents' architecture; the evidence layer is not the bottleneck.

## 15. First two days, concretely

If work starts immediately:

**Day 1**
- Add `DecisionModel` shape and `counts` assertions; make the page consume it (A3).
- Add fixture export from the seven run ids and a failing invariant test for verified-finding
  aggregation (A1).
- Add the plan-assisted scope refinement + project units for the demo fixture (B1/B3), and a failing
  determinism test for the two demo runs.

**Day 2**
- Implement assertion clusters and representative selection; make "You can say" use verified client-safe
  facts (A1/A2).
- Split client/project resolution and role evidence (B2/B4); make last client contact use client
  evidence (B5).
- Add the story builder skeleton for cause/promise/state/open question and make the demo/realistic
  first screen assert it (D1).

Do not touch reply or actions until A1/B1/C1 are stable; otherwise the new reply will cite a moving
truth.

## 16. Definition of done checklist

- [ ] One `DecisionModel`; no other count/state/silence derivation in the page/API.
- [ ] Verified facts surface; `verified` count equals verified client-safe facts; no 0-vs-9 contradiction.
- [ ] Demo and realistic stories answer cause, promise outcome, current state and top gap with citations.
- [ ] Declared client resolved; roles/last contact/chasers correct for the test casts; ambiguous roles
      disclosed, not blocking.
- [ ] Scope deterministic; project units include status/assignee/comment records; no client evidence
      excluded; review is an exception path.
- [ ] Promise ledger is promise-only, deduped and outcome-computed; story/metric/ledger agree.
- [ ] Deterministic contradictions present; audit readable; no raw ids/claim numbers/agent voice.
- [ ] One silence object; demo ~13-day Jira, realistic ~8-day project; top/bottom agree.
- [ ] Open questions grouped by category; one labelled count; no false "client and project".
- [ ] Actions specific, owner/date-aware, not truncated; no "no urgent next step" while unresolved.
- [ ] Reply blocked when unresolved; no invented date/commitment/status; vendor sign-off; per issue.
- [ ] Coverage states honest; plan dates anchored to records; sparse metrics correct.
- [ ] `npm run lint`, `typecheck`, `build`, Vitest, Playwright green.
- [ ] Five real-LLM scenarios × 2 pass the answer keys and invariants; cold reviewer passes the
      first-screen test.

## 17. If the submission deadline cannot move

There is no honest 1–2 day path to the full "answer-first, client-safe" claim. The current evidence
layer is real; the decision layer needs the sequence above. If the deadline is fixed, choose one of two
truthful options:

1. **Move the deadline / submit after the critical slice.** Execute M0 → M5, then M7. This is the only
   path that matches the product's current pitch.
2. **Narrow the product claim for this submission.** Present the evidence workbench — registry,
   exact-quote verification, actor/time checks, scope disclosure, findings and evidence drawer — and
   explicitly label the decision layer and client reply as beta/not ready. Remove the "answer in
   minutes" claim and disable the copyable reply. This is not hiding a failure; it is telling the
   truth about what is ready and what is not.

Do **not** submit the current top answer and client reply as if they were ready. The demo is strong
enough to show the evidence work; it is not strong enough to claim the decision layer.
