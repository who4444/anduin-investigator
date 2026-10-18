# Current gaps — Anduin Investigator

**Status:** working document for implementation agents. Last updated 2026-10-18.
**Read first:** `AGENTS.md` (architecture, invariants, test rules). This file is the prioritised gap list; it does not replace `AGENTS.md`.

**Purpose.** The system already proves the hard part — an evidence registry, exact-quote verification, actor/time checks, and a readable client narrative on real, scattered data. The gaps below are about **making that evidence trustworthy at the decision layer**: scope/recall, commitments, derived numbers, current state, client-safe language, and the report/UX around them.

**Priority key**

| Priority | Meaning |
|---|---|
| **P0** | Can cause a wrong client statement or a wrong action. Fix before adding features. |
| **P1** | Makes the answer usable in minutes, or prevents an operational dead end. |
| **P2** | Scale, collaboration, evaluation, governance. |

**Rule for agents:** every gap below has acceptance criteria. A gap is not done until an end-to-end test exercises the observable outcome (per `AGENTS.md`), `npm run build`, `npm run lint`, and `npm run typecheck` are green, and the relevant report behaviour is verified in the UI.

---

## 1. What works — do not regress

- Evidence Registry: every retrieved item is normalised with source, item id, UTC timestamp, author, raw text, URL.
- Two-layer verifier: verbatim quote + actor/time + isolated model support; three states (`verified`, `supported`, `rejected`).
- Evidence drawer: quote, actor/time match, model support, recorded reason.
- Coverage counts and source labels; synthetic/cached labels; upload fallback.
- Investigators split by question (root cause / commitments / ownership); skeptic; one retry pass.
- Honest aggregate stats (`verified/supported/rejected/flagged`), even when the answer is weak.
- The system can find a root cause that exists only in a linked ticket comment, and can distinguish a first fix from a later real fix.

Keep these properties. Any fix below must preserve them.

---

## 2. Observed failure patterns (generic)

These repeated across live runs on different projects and should be treated as systemic, not data-specific:

1. A declared client/project scope **excluded the client's own mailbox or the shared channel where the client posted**; the report then said "no email records" / "Slack zero results" instead of "excluded".
2. The same real promise was rendered **three times with three different statuses**, and "days late" was computed from a partial date token; lateness exceeded the incident window.
3. "Unanswered chases" was attributed to an **internal** person in every run, never the client.
4. "Longest silence" contradicted the report's own gap analysis and understated the client's wait.
5. Promise counts in the top line disagreed with chapter counts and the ledger.
6. Internal audit notes and raw agent voice ("I was unable to…", event ids) appeared in the manager-facing report.
7. "Safe to repeat externally" included an inference from absence of records.
8. A draft reply invented a past follow-up date and asserted an unverified inference; it had no greeting/sign-off.
9. The pipeline stopped when the browser tab closed; a run could sit with claims and no verify/assemble stages.
10. The cached path could serve placeholder/scaffold findings while looking like a normal report.

Each is mapped to a gap below.

---

## 3. P0 — trust and correctness

### G-01 — Scope must be a recall guard, not a silent subtraction

**Status:** **implemented (recall guard + participant identity) — 2026-10-18.** Client-domain authorship, email threads, client channels (including a shared `general` room), and manager overrides all survive the split. Slack actors are linked to client email senders by resolved display name, so a client Slack account without an address still makes its channel client evidence. Client-evidence invariant: report banner, draft block, `POST /reply` 409; excluded list with add-back + re-run. Verified by unit ratchets, a cross-tool Slack-identity fixture, a tools-level chase retrieval, an assemble-level chase→report→chasers test, a route PUT test, and a Playwright review→re-run test.
**Known caveat:** a client mailbox on a free-mail domain with no scope domain still needs the scope to carry that domain; a truly Slack-only client with no email sender and no client-name mention has no identity signal. The excluded-records review remains post-run (add-back + re-run), not a pre-run pause.

**Type:** scope, recall, safety.
**Problem:** scoping runs before anyone checks whether the client's own evidence is in the excluded set. A declared client, project name, or channel list can drop the client's mailbox, a shared channel (`general`), or a thread. Exclusion is visible only as a count, never as a list, and the report can still produce a client reply.
**Required behaviour**
- Scope is a **recall guard** first:
  - include every event authored by or addressed to a client identity/domain;
  - include every channel/thread where a client participant posted in the focus window;
  - include the full email thread of any client message;
  - include events explicitly referenced by a client message (ticket keys, links);
  - only exclude with evidence that the event belongs to a different client/project.
- Add a **client-evidence invariant**: if client evidence is excluded, the report must show a blocking banner and the draft reply endpoint must refuse (`409` with a reason) or the UI must disable drafting.
- Pre-run scope review: show included/excluded counts per source and a list of excluded items; allow the user to add them back and re-run.
- Upload and live paths must reach parity: the upload intake currently has no client field; the start page does. A user must be able to declare/repair the client on every intake path.
**Acceptance criteria**
- Fixture: client's only chases are in a shared channel not named after the project; the timeline includes them, and "unanswered chases" counts the client.
- Fixture: declared client whose mailbox domain matches; all client emails are in scope and visible in coverage.
- No user-visible string may say "no records exist" when `excluded > 0`; it must say "not searched (excluded)".
- No draft is produced when the client-evidence invariant fails.
- An e2e upload test asserts the client message appears and the coverage panel says `searched`.
**Likely touchpoints:** `lib/pipeline/scope.ts`, `lib/pipeline/coverage.ts`, `lib/store.ts`, `app/api/investigations/**`, `app/page.tsx`, `app/upload/page.tsx`, `app/_components/briefing/*`.
**Notes:** name-only anchoring is insufficient; use participant identity/domain and thread membership. Do not let a declared client make recall worse than no declaration.

### G-02 — Three coverage states, everywhere

**Status:** **implemented (coverage side) — 2026-10-17.** `coverageState`/`coverageLabel` encode searched / not-searched-excluded / not-searched with unit tests; `SourceCoverage.excludedEventIds` disclosed per source; the progress panel shows failed queries and excluded counts; the report exposes the excluded list for review. Negative-assertion copy follows in G-03.

**Type:** honesty, coverage, copy.
**Problem:** coverage has `available`, `excluded`, `searched`, `failedQueries`, but the report prose collapses "excluded" and "absent" into one. The same report can show "Slack zero results" while hundreds of Slack records were excluded.
**Required behaviour**
- Every source/claim/negative assertion uses three states: **searched and found**, **searched and absent**, **not searched (excluded)**.
- A coverage panel (UI) lists per source: available, included, excluded, failed queries, queries run, threads expanded. Excluded items are inspectable and addable.
- Add a `notSearched` reason to report-level coverage; do not infer absence for excluded sources.
**Acceptance criteria**
- For a run with excluded emails, the gaps/causes never say "no email records"; they say "email not searched (N excluded)".
- The coverage panel exposes `failedQueries` and the excluded count/list.
- Unit test for the copy/state mapping; e2e assert on the report text.
**Likely touchpoints:** `lib/pipeline/coverage.ts`, `lib/report/build.ts`, `app/_components/briefing/*`, `app/investigations/[id]/progress`.

### G-03 — Negative claims require completeness

**Status:** **implemented (core) — 2026-10-18.** Classifier + case-level completeness proof (every available source searched, no failed queries, no excluded client evidence; client evidence now includes Slack participants). Incomplete negatives cap at `supported`/`evidence_incomplete` — never verified, never safe-to-repeat, out of causes, chip reads "coverage incomplete", the proof is in the drawer; complete negatives cap at `negative_inference` — still never verified. Drafts use verified-only, and reply sentences that assert an absence are labelled `needs-check` for the approval gate. Remaining: per-question source relevance (proofs are case-level) and synthesized gap rows for incomplete negatives.

**Type:** inference policy, verification, safety.
**Problem:** "no reply", "no handoff", "never shipped", "no confirmation" are rendered as findings from missing records. With an excluded mailbox or failed thread lookup, the negative is unsafe.
**Required behaviour**
- A negative claim must carry a completeness proof: source scope, window, excluded count, failed queries, threads checked.
- If completeness is not proven, render "no record found in X/Y" in **gaps**, never in causes or "safe to repeat".
- Add a verifier soft check for negative claims; `verifyError = evidence_incomplete` and `supported`/gap placement.
- The client-safe gate must reject negative claims without completeness.
**Acceptance criteria**
- Fixture: "no reply" while 10 emails are excluded → not verified, not in safe-to-repeat, shown as "not searched"; draft does not assert it.
- Fixture: complete mailbox with no reply → may be marked supported; still shows the basis.
- Unit tests for the negative-claim classifier and the completeness gate.
**Likely touchpoints:** `lib/pipeline/verify-claims.ts`, `lib/pipeline/attribution.ts`/`entailment.ts`, `lib/report/build.ts`, `lib/agents/reply.ts`.

### G-04 — Derived facts need the same trust as quotes

**Status:** **implemented (dates + metrics) — 2026-10-18.** The bare-month deadline regex is gone; dates fail closed. `unanswered chases` now counts only client actors and requires an interleaved reply to break the run; longest silence is computed from the cited record, not uncited noise; the commitments metric, promises section, bottom line and briefing all read the canonical ledger. Remaining: per-source/functional silence breakdown and the first-response definition are still single-case metrics.

**Type:** metric correctness, provenance, tests.
**Problem:** quotes are verified; numbers are not. "Days late", "longest silence", "unanswered chases", "first response", "findings", promise counts are computed in code and shown as fact. A partial date token can produce "185 days late" inside a 26-day incident.
**Required behaviour**
- Define each metric as a pure function with inputs and a formula; store `claimIds`/`eventIds` for every rendered number.
- Date handling:
  - require a day+month (+ resolved year) for a deadline; reject bare month names and name prefixes;
  - never use the promise's made-date as the deadline;
  - parse dates with word boundaries and anchor relative dates to the source timestamp;
  - "days late" = proof date − deadline, with an as-of date; if the result exceeds the incident window, render "invalid deadline" rather than a number.
- "Longest silence": compute per source and overall separately; do not let an excluded source look silent; surface the longest *functional* silence (e.g., ticket open → first action) as well as the longest record gap.
- "Unanswered chases": only client actors with an outbound expectation; exclude internal chatter; link to the actual client messages.
- "First response": define the first cited event and the responder; do not count the first event itself as a response.
- Counts: promise counts must come from the canonical ledger, not claim statuses; chapter counts must be derived from the same set.
- Fail closed: if a metric's inputs are missing or invalid, render "not determined" and a gap.
**Acceptance criteria**
- Unit table for partial dates, name-prefix tokens, month-only, year rollover, timezones, relative dates.
- A property test: "days late" cannot exceed the incident window without a warning/invalid state.
- A report test: if a promise row is deduped, the top count and ledger count match.
- E2e: a fixture with an internal-only "chase" is not counted as a client chase.
**Likely touchpoints:** `lib/report/build.ts`, `lib/report/briefing.ts`, `app/_components/briefing/sections.tsx`, `lib/agents/reply.ts`.

### G-05 — A promise is a first-class entity, not a claim

**Status:** **implemented (canonical) — 2026-10-18.** `commitments` table (014) backed by one verified claim each. `submit_commitment` now rejects completed-fix/QA/status objects as non-promises (the backing claim remains a finding, not a ledger row); restatements with the same promisor + deadline + issue merge even when the object is phrased differently. The metric, promises section, bottom line and briefing read the same ledger; UI shows the contested chip and status rationale. Remaining: commitments-native verification (they ride the backing claim) and a cross-issue commitment bucket.

**Type:** data model, commitments, client-facing correctness.
**Problem:** promises are claims with a sentence. There is no explicit promisor/promisee/object/condition/deadline; near-duplicates across email/Jira/Slack are not merged; non-promises (QA reports, leave notices, merge notes) are counted; one promise can appear with contradictory statuses.
**Required behaviour**
- Introduce a `Commitment` entity (table or first-class report object) with:
  - promisor, promisee (client/role/person), exact object, conditions, deadline (ISO + source phrase), source(s), status (`kept|broken|unclear|withdrawn`), evidence-for-fulfilment, evidence-for-failure, rationale.
- Dedupe by promisor + promisee + object + deadline + conditions; merge sources and show "N sources".
- Status rules:
  - `kept` requires evidence the object was delivered/accepted by the promisee;
  - `broken` requires a missed deadline or explicit failure, not a mere restatement of intent;
  - `unclear` otherwise;
  - a QA report or a leave notice is not a promise.
- "Who → whom" must be explicit; do not infer a recipient from the word "to" in prose.
- Surface conflicts: same promise, two statuses → one row with a `contested` rationale.
**Acceptance criteria**
- Fixture: same Sep 20 promise in email + Jira + Slack → one row, sources shown, one status; no "Mar"/made-date deadline.
- Fixture: QA failure and leave notice are not in the promise ledger.
- Ledger count = distinct promises; top/chapter counts reconcile.
- "Days late" uses the canonical deadline and proof date, not a token.
**Likely touchpoints:** migrations, `lib/store.ts`, `lib/agents/investigator.ts` (commitments), `submit_claim` schema, `lib/report/build.ts`, `app/_components/briefing/sections.tsx`, `lib/agents/reply.ts`.

### G-06 — Current state, owner, and next action

**Status:** **implemented (core) — 2026-10-18.** `buildCaseState` computes the "now" from stored records only: current status (latest transition wins), latest **internal** version-bearing fix (client-authored escalation emails are excluded) + QA check, owner, next commitment, last client contact (email or linked Slack identity) and last internal update, with `asOf`. Rendered as the "now" strip; a missing owner renders critical. The draft-reply validator drops status/owner assertions the case state and cited findings do not carry. Remaining: role labels for owners, and folding CaseState into the action list (G-09/G-11).

**Type:** decision layer, missing model.
**Problem:** the report is historical. The client asks "when is this fixed?"; the manager asks "who acts now?" There is no current status, current owner, latest fix, latest verification, next commitment, or named client-comms owner.
**Required behaviour**
- Add a structured `CaseState` (computed from evidence, never guessed):
  - current status + since;
  - latest fix/build + verification;
  - current owner/assignee + role;
  - next commitment + date;
  - last client contact + last internal update;
  - as-of timestamp.
- Each field is either evidence-linked or explicitly `unknown` with a reason.
- Show it in the report header and use it in the draft reply.
- Add an action list with owner, due, and source; separate internal actions from client-reply actions.
**Acceptance criteria**
- A case with a reopen and a later fix shows the current status/fix, not the first Resolved.
- A case with no current owner shows "no owner" as a critical gap, not a green metric.
- The draft cannot state a status/owner/date not in `CaseState`.
**Likely touchpoints:** `lib/report/build.ts`, `lib/report/briefing.ts`, `app/_components/briefing/*`, `lib/agents/reply.ts`.

### G-07 — Client-safe mode and a real reply gate

**Status:** **implemented (core) — 2026-10-18.** The draft is now an explicit client-safe object: greeting/sign-off, per-sentence `safe / needs-check / do-not-send`, an approval checkbox persisted in `report_extras`/`issue_report_extras`, and copying gated on approval. Absence assertions and new commitments are labelled needs-check; verified, unflagged findings are the only input. The "What was communicated" audit table is renamed as internal review. Remaining: a separate client-pack page/PDF and a server-side per-sentence gate for future non-verified inputs.

**Type:** safety, separation of internal/external, reply quality.
**Problem:** internal audit notes, agent voice, and raw ids appear in the same report as "safe to repeat externally"; the draft can invent a follow-up date, state an inference as fact, and lacks greeting/sign-off. "Safe" is not an approval state.
**Required behaviour**
- Two explicit modes:
  - **Internal investigation:** all evidence, audit notes, skeptic notes, agent rationale, metadata.
  - **Client pack:** only verified, unflagged, complete claims; no agent voice; no internal blame; no unverified negatives; approved statements only.
- Remove/rename the audit table if it is not client communications; never place it under "What was communicated".
- Reply generation:
  - every sentence must be entailed by cited claims (claim-id validation is necessary, not sufficient);
  - no new commitments, dates, owners, or statuses not in `CaseState`;
  - explicit greeting/sign-off fields;
  - per-sentence labels `safe / needs check / do not send`;
  - approval state; no "send" claim from the app.
- If client-safe is out of scope, remove "Safe to repeat externally" and the draft, or label them strictly internal. Do not imply external safety without a gate.
**Acceptance criteria**
- A sentence with a new date not entailed by a claim is rejected or flagged; it cannot enter the client pack.
- "No reply" without complete coverage cannot enter the client pack.
- No agent voice/ids appear in the client pack.
- A draft with an invented past date fails an e2e test.
**Likely touchpoints:** `lib/agents/reply.ts`, `lib/report/build.ts` (`safeToRepeat`), `report_extras`, `app/_components/briefing/sections.tsx`, `app/api/investigations/[id]/reply`.

### G-08 — Immutable report version; no mutating top answer

**Status:** **implemented (core) — 2026-10-18.** Migration 015 `report_versions`; assemble freezes a case-level and per-issue narrative with stats/model/prompt version. The report reads the latest version for the selected issue and shows `Report vN · frozen date · model`; the reply's verdict no longer replaces the top answer. The content hash includes pipeline + model versions, so a different model cannot serve a cached run. Remaining: a version diff/refresh action and a per-sentence server gate before copy for future editable drafts.

**Type:** reproducibility, trust.
**Problem:** the top answer/verdict can change after another action (e.g., drafting), and cached vs live runs diverge. The manager cannot tell whether the story changed or the model did.
**Required behaviour**
- A report version per run with: run parameters, source snapshot, stage status, model/prompt versions, and a diff.
- The top answer is computed once per version and stored; drafting must not replace it.
- Show "as of" and "cached/live/partial" labels with an explanation and a refresh action.
**Acceptance criteria**
- Drafting does not change the top answer; a new version shows a diff.
- Cached result is visibly distinct and cannot be mistaken for a fresh run; scaffold/fake findings are never served as a normal report.
**Likely touchpoints:** `report_extras`, `lib/report/build.ts`, `app/investigations/[id]/page.tsx`, cache path.

---

## 4. P1 — usable in five minutes

### G-09 — Answer-first decision brief

**Problem:** five equal metric cards dominate; the answer, current state, owner and next action are not first.
**Required:** replace the cards with: 3–5 verified facts; current status; named owner; next commitment/date; top unknown; "what you can say / what you cannot"; confidence. Metrics move to a secondary evidence strip, each with provenance.
**Acceptance:** a manager can answer the four decisions from the first viewport; no metric without a source/drill-down.

### G-10 — Timeline as the spine

**Problem:** "What happened" is a claim dump with duplicates and chapter labels; the actual sequence is not the primary artifact.
**Required:** one canonical event per step (date, actor, one sentence, source count, conflict/verification badge), expandable to evidence; no duplicate claims; collapse/expand; a "current as of" marker.
**Acceptance:** fixture with the same event in three sources renders one timeline step with three sources; no repeated near-identical steps.

### G-11 — Promise table and ranked gaps

**Problem:** promise cards are inconsistent and duplicated; gaps are a 30–50 item wall with agent voice.
**Required:** one row per distinct promise (G-05); gaps ranked by decision impact, deduped, tagged `not searched / searched-absent / conflicting`, with no ids/agent voice.
**Acceptance:** promise table count/status reconcile with the top; gaps have priority and no duplicate.

### G-12 — Scope review before the run

**Problem:** the manager cannot see or correct what will be searched; the upload path cannot declare a client.
**Required:** pre-run preview of sources, client identity, included/excluded counts, estimated time; allow add/remove/split/merge; require confirmation for low-confidence scope; parity across start/upload/live.
**Acceptance:** a declared client can be corrected before the run; the preview lists excluded items; no silent run.

### G-13 — Resumable, background, partial results

**Problem:** the pipeline is client-driven; closing the tab can stop it; no resume/retry/partial.
**Required:** server-side job with resumable stages, notification, partial report with "partial" label, retry only failed stage, no "keep this tab open".
**Acceptance:** kill the tab mid-run, reopen, the run completes or resumes; stages durable; e2e test.

### G-14 — Human-in-the-loop review and feedback

**Problem:** the manager cannot correct a claim, merge identities, add a source, mark a claim wrong, or approve a sentence.
**Required:** review checkpoints (scope/identity → claims → reply approval); `mark wrong / unsupported / out of scope` with a reason; corrections feed a feedback store and the next run; audit trail.
**Acceptance:** a corrected claim disappears from the client pack and the report version records the correction.

### G-15 — Role views and collaboration

**Problem:** account manager, engineering manager and executive all get the same 39-claim report.
**Required:** three views over the same evidence — **Reply** (client-safe), **Fix/own** (causes, owners, handoffs, actions), **5-bullet brief** (exec); comments/assignment/share with redaction; approvals.
**Acceptance:** each view answers its primary question in one screen without losing evidence access.

### G-16 — Incremental update / delta

**Problem:** a new email or thread means a new run from scratch; the report goes stale.
**Required:** add source/re-run affected stages; "what changed since the last run"; newly contradicted claims surfaced.
**Acceptance:** add one email that contradicts a promise; the delta marks the promise contested without rebuilding the whole case.

---

## 5. P2 — scale and governance

- **G-17 Evaluation harness:** labeled incidents (single-issue, multi-facet, multi-issue, shared-channel, excluded-mailbox, draft-safety); metrics: key-fact precision/recall, scope recall, promise accuracy, negative-claim correctness, unsafe-sentence rate; run on real model traces.
- **G-18 Cached-run integrity:** cached runs labelled and explained; never serve scaffold/fake findings; one-click refresh; cache key includes model/prompt version.
- **G-19 Governance:** per-source permissions, PII/redaction, retention, access control, export audit; client pack redaction.
- **G-20 Scale/cost:** token budget per run, issue/source caps, latency estimate, degradation policy ("partial investigation").
- **G-21 Mobile/accessibility:** responsive report, keyboard/focus, text labels for colour, print/PDF.
- **G-22 Export/share:** client pack PDF, copy-with-sources, redacted link, no internal notes.

---

## 6. G-23 — Multiple independent issues in one escalation

**Status:** **implemented — Option B core (2026-10-17)**. **Scope note:** multi-project is out of scope; multi-issue **within one client/project** is in this gap.

**Problem.** The system models one causal story. It handles facets of one incident (root cause + promises + ownership + comms), but two independent incidents are silently collapsed: one root-cause list, one promise ledger, one "longest silence", one reply. The report does not say "this escalation contains N issues".

**What shipped (Option B core):**
- `issues` table (migration 012) + `claims.issue_id` + `gaps.issue_id` + `issue_report_extras`.
- Analyst returns 1–3 issues with title/ask/summary/confidence; CODE caps, persists, auto-confirms a single issue, and reports overflow beyond 3. The prompt treats a failed fix, premature closure, unanswered chases and an SLA consequence as facets, not separate issues.
- Pre-investigation pause + editable review on the progress page (rename/ask/summary, remove, merge into one, add, max 3); confirm resumes at `investigate` with the same worker lease.
- Investigators must set `issue_id`; `lib/pipeline/issues.ts` resolves missing/invalid ids (single issue → that issue; else token overlap; otherwise unassigned and disclosed).
- Per-issue report at `?issue=<id>`: timeline, promises, causes, gaps, stats and draft reply; `?issue=all` shows the case overview + combined view; drafts stored per issue; unassigned findings are disclosed.
- Synthetic `public/multi/` two-issue fixture, start-page scenario, fake-LLM branch, `tests/ui/multi-issue.spec.ts`, plan-data/orchestrator unit tests.
- Real LLM validation: two-issue Contoso run split exactly 2, paused, confirmed, reported per issue and drafted per issue; single-issue Northwind run stayed one issue (no review).

**Still open in B:**
- Coverage remains case-level, not per issue.
- Claims are single-issue, not many-to-many for shared evidence (events are shared by citation).
- Retry is still kind-level, not per issue.
- No explicit "no issue / cross-issue" bucket; unassigned claims are counted and warned, not browsable.
- The real multi-issue run still exposed the pre-existing G-01/G-02 failures: the client email and the shared `general` chases were excluded by scope, and the report's "unanswered chases" picked an internal actor. G-23 works structurally, but the one-issue trust gaps still dominate.

**Required minimum contract (shipped):**
1. At intake/plan, decompose into `issues[]` (title, ask, summary, confidence).
2. Show the list before the run: investigate both / split / merge; cap at 3; beyond that ask to split.
3. Tag claims/gaps with an issue; events stay shared by citation.
4. Report header says "N issues detected"; per-issue brief/timeline/promises; an "All issues" case overview + combined view.
5. Never merge promises or statuses across issues; drafts are per issue.
6. Tests: multi-issue fixture; one issue must not absorb the other; counts per issue.

**Effort (one senior full-stack dev, familiar with the code):**

| Option | Scope | Estimate |
|---|---|---|
| A. Detect + tag + filter + disclose | One plan, shared registry, issue tags, switcher, cap, no client-safe reply change | **4–7 dev-days** |
| B. Issue-aware investigation (recommended) | Issue entity; one plan with issues; claim attribution; per-issue timeline/promises/gaps/stats/reply; coverage per issue; tests | **12–18 dev-days** (~3–4 weeks) |
| C. Independent investigations | Per-issue plans/agents/retrieval budgets/retries, cross-issue correlation, per-issue scopes, approvals | **25–35 dev-days** (~5–7 weeks) |

**Recommendation:** Option B core is in. Do not start C yet: fix G-01/G-02/G-04 first, then add per-issue coverage/retry and a cross-issue bucket. Option C only if bundled escalations are the norm.

**Acceptance (B) — current state:** two distinct briefs ✅; two promise ledgers ✅; case-level summary ✅; no cross-issue status merge ✅; per-issue drafts ✅; per-issue coverage ❌ (case-level only); "no issue" bucket ⚠️ (unassigned count/warning, not a browsable bucket).

---

## 7. UI/UX gap summary

| Area | Gap | Change |
|---|---|---|
| Top of report | Metric cards dominate; no answer/current state/owner | Decision brief: 3–5 verified facts, status, owner, next date, top unknown, safe/cannot-say |
| Timeline | Claim dump, duplicates | One canonical timeline step per event, source count, expandable |
| Promises | Duplicated cards, wrong dates | One row per promise, full date, explicit who→whom, status rationale |
| Gaps | Long wall, agent voice, duplicates | Ranked, deduped, `not searched / absent / conflict`, no ids/agent text |
| Evidence | Every claim equal; no filters | Verified/source/person/type filters; "show only verified"; group by event |
| Internal vs client | Audit notes and safe-to-repeat in one view | Two modes: internal investigation vs client pack; approval gate |
| Do now | Internal cleanup, no owner/date | Action list: action, owner, due, source, status |
| Draft reply | No greeting/sign-off; invented dates | Real editor, sentence safety, no new commitments, approvals |
| Navigation | 19k-px page, no TOC/collapse/mobile | Sticky TOC, collapse, print/PDF, responsive |
| Intake | No preview, no scope edit, upload lacks client | Pre-run scope review + parity across start/upload/live |
| Titles | Ticket title, not escalation | Title from escalation; subtitle with client/project/as-of |
| Counts | "2 sources" vs three icons; contradictory counts | One source of truth for counts; explain each metric |
| States | Raw errors, no partial/empty guidance | Resume/retry/add-source/clarify; partial label |
| Ambiguity | Vague escalation gets a specific client reply | Ask "which engagement?"; confirm before drafting |
| Trust | Cannot challenge a claim | Flag wrong/unsupported/out-of-scope; show rationale |

---

## 8. Suggested implementation order

**Assumption:** one senior full-stack dev familiar with the codebase; estimates are dev-days, not calendar. Parallelise with two devs where dependencies allow.

| Phase | Work | Estimate |
|---|---|---|
| 0 | Fixtures + regression tests for the failure patterns (shared channel, excluded mailbox, duplicate promise, partial date, no-reply, draft date). Add a small snapshot of the four report views. | 3–4 |
| 1 | G-01, G-02, G-03, G-04 (scope/coverage/negatives/derived facts) | 12–16 |
| 2 | G-05, G-06 (promise entity, current state/owner) | 6–9 |
| 3 | G-07, G-08 (client-safe/reply, immutable version) | 6–9 |
| 4 | G-09, G-10, G-11 (decision brief, timeline, promise table/gaps) | 8–12 |
| 5 | G-12, G-13 (scope review, resumable runs) | 6–9 |
| 6 | G-14, G-15 (review/feedback, role views) | 8–12 |
| 7 | G-23 Option B core: **done**; remaining per-issue coverage/retry + cross-issue bucket | 4–7 / 12–18 |
| 8 | G-16, G-17, G-18, G-19..G-22 | 10–15 |

**Critical path:** G-01 → G-02/G-03 → G-05 → G-06 → G-09 → G-10. Do not build the new report UI before scope/promises are correct; it will just make wrong answers prettier.

**Parallel workstreams for agents:**
- **A. Scope/coverage:** G-01, G-02, G-12, coverage UI. Start first.
- **B. Commitments/metrics:** G-04, G-05, G-06, unit tests. Depends on schema, not on A.
- **C. Safety/reply:** G-03, G-07, G-08. Depends on B.
- **D. Report UX:** G-09, G-10, G-11, G-13. Depends on A/B.
- **E. Multi-issue:** G-23 core **done**; next: per-issue coverage/retry, cross-issue bucket. Depends on A/B/C for trust.
- **F. Evaluation/governance:** G-17..G-22. Continuous.

---

## 9. Invariants for every fix

From `AGENTS.md`; do not weaken:
- No hardcoded outputs; everything comes from retrieved items.
- Every claim links to a stored item and an exact quote; quote + actor/time are checked by code, not an agent.
- Agents can downgrade; only code can reject.
- Never invent content for events with no record; list unknowns.
- Upload fallback and judge-supplied exports must keep working.
- Synthetic data labelled; cached runs labelled; cached results must not look fresh.
- Coverage honest: which sources/queries were actually searched.
- Report layer: every metric/silence/lane/audit row/trust split computed in code; model text limited to verdict + reply, restricted to verified/unflagged claims and validated.
- UI: plain CSS in `app/globals.css`; no Tailwind.
- Every API route has `export const maxDuration = 60` as a literal.
- Tests: e2e first; fake LLM only; no real Jira/Slack/Gmail; build/lint/typecheck green.
- Do not remove the evidence drawer or the three verification states.

**New invariants to add:**
- No client-facing draft if client evidence is excluded or a negative claim is incomplete.
- No derived metric without a formula, inputs, and an as-of date.
- No promise without an explicit promisor, promisee, object, deadline, and status rationale.
- No "verified" for a negative inference.
- No internal audit/agent voice in the client pack.

---

## 10. Definition of done for the P0 set

1. Fixtures: shared-channel client message, excluded mailbox, duplicate promise across three sources, partial date, "no reply" with excluded records, invented reply date.
2. G-01..G-08 acceptance tests pass; no regression in existing e2e.
3. A report for each fixture: no "no records" when excluded; no 100+ days late inside a short incident; one promise row; current state/owner; draft blocked when incomplete; no invented dates.
4. `npm run build`, `npm run lint`, `npm run typecheck` green; UI tests on port 3100.
5. A manual manager review: can answer the four decisions from the first viewport; can state what they can/cannot tell the client.

---

## 11. Open decisions for the human

1. **Is multi-issue in scope now?** Minimum contract now, Option B later, or explicitly "one incident per escalation" with a detect-and-ask guard? (Recommend: detect + ask now; B after P0.)
2. **Client-safe mode:** implement the two-mode split, or remove "Safe to repeat externally"/draft until it is real? (Do not leave the current implication.)
3. **Scope override:** should the user be able to force-include excluded records? (Recommend yes, with a "not searched" label and a draft block if client evidence is still excluded.)
4. **Promise status policy:** what counts as `kept` for a client promise — a release announcement, QA pass, or client acceptance? (Recommend: client acceptance or verifiable delivery; otherwise `unclear`.)
5. **Source precedence:** for status/owner/fix, does Jira win over Slack over email, or is it fact-type specific? (Recommend fact-type table, visible in the report.)
6. **Negative claims:** should the system ever make them, or always phrase as "no record found"? (Recommend: allowed only with a completeness proof, never in the client pack otherwise.)
7. **Cached runs:** keep as a product feature, or restrict to offline/demo only? (Recommend: label + refresh; never serve scaffold.)
8. **Data governance:** what is the minimum for PII/redaction/retention before a client pack leaves the tool?
