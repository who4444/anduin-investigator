# Live LLM run review — Anduin Investigator

**Date:** 2026-10-18
**Reviewer:** product/QA pass over the real pipeline (no fake LLM; the sparse case uses the real parsers on a small export)
**Build:** current working tree, `npm run start` on `:3000`, Postgres 16, real DeepSeek endpoint
**Question:** Does the product answer the escalation cleanly enough to hand off / submit to a hackathon?

## Verdict

**Not ready to submit as the "answer-first, evidence-backed" product it claims to be.** The expensive,
credible part is real: the registry fills automatically, quotes and authors verify deterministically,
the product finds the planted cross-source facts (including the KESTREL root cause and the
premature resolution), and all code gates are green. The **decision layer is not yet trustworthy**:
the top answer is usually a metadata sentence rather than the answer; verified evidence is hidden by
deduplication; the flagship demo can lose the ticket's status transitions; the client identity is
declared but rendered as unresolved; the client reply invents commitments; and counts/contradictions
disagree across sections.

It is **ready to hand off to a developer as a strong prototype with a concrete P0 list** (below). It is
**not ready for a trust-focused hackathon demo until P0-1 … P0-5 are fixed and this same run set is
repeated.**

## What I ran

Six real runs, all through the running app and the real LLM, using the same stage sequence the UI uses
(scope review and issue review confirmed through the same API endpoints the review screens call). The harness is
[`.eval/review-run.mjs`](../.eval/review-run.mjs); each run saved its full report JSON, visible page
text and screenshots under `.eval/review-*`.

| Run | Input | Ingested | Scope | Claims (V/S/R) | Model findings | Outcome |
|---|---|---:|---|---|---|---|
| Northwind A | start-page demo, declared Northwind | 41 | partial, **22 in / 19 out** | 38 (9/29/0) | 14 (0 verified) | status/owner unknown; 0 safe; reply invented next step |
| Northwind B | same input, repeated | 41 | partial, **32 in / 9 out** | 41 (11/30/0) | 18 (1 verified) | status Resolved, owner unknown; reply invented a dated update |
| Realistic | four-tenant upload, declared Bright Market | 276 | scoped, **54 in / 222 out** | 30 (12/18/0) | 21 (4 verified) | root cause/fix found; skeptic 0; client contact unknown |
| Multi | Contoso/Orbit, two issues | 50 | partial, 47 in / 3 out | 36 (6/30/0) | 27 case / 14 issue 1 (0 verified) | issue split correct; top answer and actions wrong |
| Vague | four-tenant upload, no client | 276 | unscoped, **276 searched** | 30 (13/17/0) | 20 (2 verified) | honest scope line; but mixed tenants and a confident reply |
| Sparse | 3-record Jira+email export | 3 | partial / unscoped | 8 (0/8/0) | 3 (0 verified) | honest "only 3 records"; reply correctly refused; metrics/coverage wrong |

Stage time is not a problem: each run finished the pipeline in roughly **50–60 seconds** (plan 6–9 s,
investigators 18–32 s, skeptic 5–14 s, verify 3–4 s), safely inside the 60 s per-stage budget.
The retrieval work is real, not cached.

**Later repeat (added after the first pass):** the realistic scenario was run a second time
(investigation `ffd6c63f-9786-4b46-ae2b-07b0c1904965`). Retrieval was stable — root cause, 5.3.3
failure, 5.3.4 fix, handoff and chases all appeared — but the run differed on the plan and the
skeptic: the first realistic plan said **2026**-09-18 → 2026-09-28, the repeat said **2024**; the first
skeptic returned 0 issues, the repeat returned 14 flagged / 16 issues; verified claims were 12/30 vs
14/30. The repeat is the evidence for the investigation-variance gaps in
[the plan](decision-layer-plan.md#35-investigation-prerequisites-folded-into-m1m3).

Investigation ids for replay: demo A `ad944ff6-e567-4846-81b7-9f266ae114fa`, demo B
`153e3cd5-eb6e-4f95-8d94-881cdf130426`, realistic `f78de150-98ce-4b4f-b435-a71c358a65bd`, multi
`1189f885-4238-428b-8d44-3afcbac38a12`, vague `74d11e9d-fc02-48c4-9852-1b21f6027267`, sparse
`2cca755f-39e7-4ea4-95b6-cbb36f78d313`.

## What the runs prove works

- **Evidence registry + quote verification.** Every run had `rejected: 0`; no agent claim failed the
  verbatim quote check. The verification path is doing its job on model output from three different
  scenarios.
- **Cross-source retrieval.** The realistic run found the root cause that exists only in a comment on
  the linked `LUM-804` ticket ("KESTREL refactor … billing-v2"), the failed 5.3.3 attempt, the real
  fix in 5.3.4, Ravi Menon's ownership/handoff, and Dana Okafor's three chases. The demo found
  MER-87/UTC, Lin Chen's leave, the premature resolution and four client chases. The multi run split
  exactly the two intended issues.
- **Scope recall guard for client evidence.** The realistic run excluded 222 of 276 records with
  `excludedClientRecords: 0`; the scoped runs did not pull distractor-tenant claims into the report.
- **Honest failure modes exist.** Sparse evidence produces "Only 3 records were found; a full account
  is not possible" and refuses to draft a reply with 0 verified claims. The vague run says
  "No client or project could be identified … every stored record was searched."
- **UI/craft.** The report structure, evidence drawer, synthetic labelling, multi-issue tabs and
  progress screens are visually strong. The 31 Playwright UI tests pass.

## Answer-key scorecard

Legend: ✅ present and usable · ◐ present but buried/wrong framing · ❌ missing or contradicted.

### Northwind demo (the path a judge clicks first)

| Expected | Run A | Run B |
|---|---|---|
| Root cause: MER-87 UTC merge in 4.12 | ✅ in findings | ✅ in findings |
| Promise: fix in Sep 24 release | ✅ but ledger counted 2 duplicates | ✅ but ledger counted 3 "broken promises", two are decisions/status assertions |
| Premature resolution vs QA failing | ✅ in findings | ✅ in findings |
| No handoff / Lin Chen leave | ✅ | ✅ |
| Four unanswered chases | ✅ (`4 from Priya Nair <…>`) | ✅ |
| Current status Resolved after record | ❌ "No status transition is recorded" | ✅ Resolved |
| Owner now | ❌ unknown | ❌ unknown |
| Last client contact | ❌ "client is not identified" | ❌ "client is not identified" |
| Undocumented client call gap | ❌ absent | ◐ in open questions |
| Silence (~13-day Jira quiet) | ❌ top 3 days / bottom 10 days | ❌ top 3 days / bottom 10 days |
| Answer visible in the first two sentences | ❌ metadata about finding types | ❌ metadata about a status change |
| Safe-to-repeat counts match verification | ❌ 9 verified claims, "0 verified" findings | ❌ 11 verified claims, "1 verified" finding |

The two runs used the same input and produced materially different scopes (22 vs 32 in-scope records;
19 vs 9 excluded). Run A's scope excluded `MER-87` creation/status and `MER-101` status/comment; that
is why A reported "no status transition" and a 3-day silence. Run B's scope included the MER project
but still excluded the relevant email "Build is going out tonight; the invoice fix is included." The
difference is model-proposed anchors, not a deterministic rule; a judge can get either answer on two
clicks.

### Realistic four-tenant workspace

| Expected | Observed |
|---|---|
| Root cause in LUM-804 comment (KESTREL / VAT rounding) | ✅ f12 and the cause cell |
| Promise broken (Sep 20) | ✅ first ledger entry broken |
| Premature resolution challenged by QA | ✅ findings f7–f10; but **skeptic flagged 0** and the audit says "No communicated update was contradicted by another record" |
| Real fix 5.3.4 and client confirmation | ✅ latest fix 5.3.4 · resolved · Ravi Menon |
| 8-day quiet period Sep 9 → 17 | ❌ timeline says 3 days; bottom line says 11 days |
| Handoff Nadia → Ravi | ✅ ownership finding |
| Three client chases | ✅ `3 from Dana Okafor` |
| Scope protects the client and excludes distractors | ✅ 222 excluded, 0 client records excluded |
| Last client contact / client role | ❌ Dana Okafor is "role unknown"; last client contact unknown |
| Top answer explains what happened | ❌ "ticket moved to In Progress on Sep 18, then the client followed up on Sep 28" |

The report can answer the question if a human narrates "What happened" and "Promises", but the first
screen does not.

### Multi-issue Contoso/Orbit

- ✅ Split exactly two issues; both titles and the issue tabs are present; the manager review is usable.
- ✅ A useful contradiction audit exists on this run (4–6 rows).
- ❌ Issue view: 0 verified, "You can say 0", owner unknown, last client contact unknown, and actions
  such as "Resolve the conflict around Ravi Menon owned the VAT…." (truncated, no next step).
- ❌ Skeptic notes leak internal voice and raw ids: "Claim 4 (and 9, 26) asserts …", `e_58b4307b…`.
- ❌ `/reply` without an `issueId` produced one combined draft for both issues; per-issue drafting is
  not enforced at the API boundary.
- ◐ The API's case-level model (27 findings) and the page's issue-level model (14 findings on issue 1)
  show different counts; there is no single visible source of truth.

### Vague escalation, four-tenant data

- ✅ Honest line: "No client or project could be identified from the escalation — every stored record
  was searched." Not confidently anchored to the wrong client.
- ❌ The 20 findings mix Bright Market, Lumen, and Vertex. One action says "Close out the broken
  promise: Ravi Menon promised Bright Market…"; another says "Resolve the conflict around Sam Rivera
  promised add the Vertex finance role…". A manager cannot tell which tenant the answer is about.
- ❌ A 3-sentence client reply is still drafted and specific: "VAT export totals were blanked by a
  rounding defect in billing-v2 5.3.0 … resolved in 5.3.4 on 28 September." The client is unresolved.
- ❌ Headline chronology is backwards: "moved to In Progress on Sep 18, then the client followed up on
  Sep 4." Findings are severity-sorted; the headline treats first/last as time-ordered.
- ❌ Root cause is verified but withheld as a "conflict"; the reason is not shown in an audit section.
- ❌ Gaps leak "Claim asserts…" / "stored record" placeholders and contain miscategorized questions.

### Sparse judge-style export (3 records)

- ✅ Honest thinness line, no invented root cause, reply blocked with "No verified findings yet".
- ❌ Coverage says Slack `available: 0, searched: true` and the report says "all slack searches
  returned zero" although no Slack source was uploaded. Absence is not a search result.
- ❌ "Chasers: 3 from Lin Chen" — an internal engineer, not a client; the metric is undefined when the
  client is unresolved.
- ❌ 34 open questions in the bottom line vs 6 grouped questions at the top; 24 near-duplicate gaps.
- ❌ Actions are "Resolve the conflict around process failure: …" for all three findings.
- ❌ Plan/gap language uses a 2026 focus window for 2024 records ("no records exist from the 2026-10-17
  focus window onward").
- ❌ "Scope confirmed by you — confirmed by you before the run." redundant/contradictory copy.

## Blocking gaps (P0 before a hackathon submission)

### P0-1. Verification is computed but erased before it reaches the page

The verifier says **9 of 38** (demo A), **11 of 41** (demo B), **12 of 30** (realistic) and **13 of 30**
(vague) claims are verified. The page says **0, 1, 4 and 2** verified findings, and the top copy says
"You can say · 0" in the demo. In demo B a root-cause finding is withheld as a conflict and the one
"safe" finding is a process objection. This is not conservatism; it is aggregation:

- `verificationFor()` returns `supported` if **any** claim on the same event is supported
  ([`lib/report/model.ts:395`](../lib/report/model.ts#L395-L401)).
- `verifiedFindings` then requires the whole merged finding to be `verified` with no pill
  ([`lib/report/model.ts:1349`](../lib/report/model.ts#L1349-L1350)).
- Three investigators restating one event, one with a weaker entailment verdict, downgrades the strong
  claim. The dedupe keeps all claim ids but loses the strongest state.

**Why it blocks:** the product's central claim is "every statement is verified or clearly marked."
The first screen currently says nothing is verified while the evidence drawer contains verified
claims and the draft reply cites them. A judge will see the contradiction immediately.

**Acceptance:** a finding's state is the best supported state among its claims (or verified if any
claim is verified and unattributed claims are cosmetic restatements); "safe to repeat" is non-zero
whenever there are verified, unflagged, client-safe claims; the count on the top equals the verified
list. Add a test that constructs one event with a verified and a supported claim and asserts the
finding stays verified.

### P0-2. The top answer is a metadata sentence, not the answer

Current headlines:

- Demo A: *"The evidence shows that the first record is a technical finding on Sep 10, then the latest
  record is a process failure on Oct 1. The record now shows the current status is not recorded and no
  owner is recorded."*
- Realistic: *"The evidence shows that the ticket moved to In Progress on Sep 18, then the client
  followed up on Sep 28. … What remains open: client and project. Next step: No urgent next step."*
- Vague: *"…moved to In Progress on Sep 18, then the client followed up on Sep 4."*

These are generated by a template that names finding kinds and picks `findings[0]`/`findings[last]`
from a severity-sorted list ([`lib/report/model.ts:976`](../lib/report/model.ts#L976-L1096)). They do
not contain the root cause, the promise outcome, the current state, or the client's actual question.
The "What remains open: client and project" line on the realistic run is also **wrong** — that run is
scoped to Bright Market/LUM — because the open-question theme regex matched the word "identified" in
an unrelated question.

**Why it blocks:** the product promises "time to a trustworthy answer." The time to answer is not
reduced if the manager must read 21 findings to assemble the story.

**Acceptance:** the first 2–3 sentences state (a) what broke and why, (b) what was promised and whether
it was kept, (c) what is true now (status/owner/fix), and (d) the one open question with a next step.
They must cite findings and be deterministic on the built-in scenarios. The chronology must be
time-sorted, and "then" must never introduce an earlier date. Add a golden test for the demo and
realistic first screen.

### P0-3. Scope is unstable and can drop the project's own evidence

The same Northwind input produced two scopes:

- A: anchors `declared-client` + `northwind.example`; no `MER` prefix or `meridian-billing` channel;
  **19 excluded**, including all MER-87 status changes, MER-101's status/comment and MER-101's
  "Root cause looks like…" comment. The report then says "no status transition is recorded" and
  "no record shows a fix shipping", while those records exist.
- B: anchors `declared-client` + model-proposed `MER` + `meridian-billing`; **9 excluded**, status
  Resolved appears, but the relevant email "Build is going out tonight; the invoice fix is included"
  is excluded and the client domain anchor is gone.

The resolver only keeps a component's anchors when components share a record
([`lib/pipeline/scope.ts:695`](../lib/pipeline/scope.ts#L695-L720)) and only names a project when the
model's `project` string maps to a ticket prefix. The UI can therefore confirm a scope that looks
reasonable (MER + channel) while still saying "project not identified" and blocking every
role-dependent card. In the realistic run the scope is much better (LUM + channel + client domain), but
it still includes the client's channel noise, which breaks the silence metric.

**Why it blocks:** the answer can change on a repeat of the same demo, and on the first demo run the
scope hides exactly the records that answer "what is true now". This is a trust-critical recall bug,
not a prompt-tuning issue.

**Acceptance:** scope derivation is deterministic for the same records; once a ticket prefix/channel is
in scope, all records of that project are treated as one unit; the declared client's domain anchor
cannot be dropped when model anchors are disjoint; `project` is derived from a ticket prefix or a
channel when the model does not name one; the pre-run review shows which records are excluded by source
and why. Add a test with the demo fixture that asserts status/assignee records are in scope.

### P0-4. A declared client is rendered as "not identified"; roles and last contact are unknown

Demo A and B both declare **Northwind Logistics**, yet the page shows a large notice "Client and project
not confirmed", every finding says "needs client confirmation", the state cards say "Needs client
confirmation — the client is not identified", and the last client contact is unknown. The realistic run
is scoped to Bright Market/LUM but **Dana Okafor is "role unknown"** and last client contact is
unknown; the multi run has the same problem with Dana.

Two causes are visible:

- `buildClientModel` requires **both** client and project to mark the client resolved
  ([`lib/report/model.ts:572`](../lib/report/model.ts#L572-L588)); the demo has a client but no project
  string.
- `buildActors` deliberately turns a client-domain actor into `role: unknown` when that actor also
  posts in Slack (`domainIsClient && channels.slack`)
  ([`lib/report/model.ts:526`](../lib/report/model.ts#L526-L530)). That is intended for the demo's
  identity trap, but it also catches the actual client (Dana in realistic/multi, Priya in the demo),
  so roles, last contact and the told-vs-actual audit all fail.

**Why it blocks:** the first screen of the flagship demo says the client is unknown even though the
manager declared it. A reply is still drafted to "Hi Priya", which makes the contradiction worse.

**Acceptance:** a declared client plus a scoped sender domain is enough to render the client as known
even if the project string is missing (project separately "unknown"); client-role resolution uses the
resolved identity and permits a client who posts in Slack; `lastClientContact` is computed from client
evidence (not only role==="client"); the confirmation form is pre-filled with the declared client and
registry project candidates. Add role/state tests for Dana in realistic and Priya/Northwind in the demo.

### P0-5. The client reply is not safe enough to put in front of a client

Observed drafts:

- Demo A: *"The issue remains open until testing passes, in line with the team's stated rule…"* — the
  record says MER-101 was marked **Resolved** on Sep 26. *"We will provide an update after testing on
  the corrected build."* — no such commitment exists in the records. The sentence labeled **safe**
  cites an internal decision ("keep open until QA passes"). Sign-off is **"Anduin Support"**, the tool's
  brand, not the vendor.
- Demo B: *"We are verifying the invoice-total defect…"* and *"We will provide a status update on
  October 2."* — neither action nor date is in the record; the dated sentence is only labeled
  "needs check". *"…the resolution proceeded nonetheless"* is internal process language in a client
  note.
- Realistic: two sentences, no next step, no statement of the actual 5.3.4 fix; the system prompt asks
  for "a dated next step".
- Vague: a specific, confident 3-sentence reply to an **unresolved client** about KESTREL/billing-v2.
- Multi: a combined reply for two issues when no `issueId` is supplied.
- Sparse: correctly refuses with 502.

The reply path validates numbers/sentences against verified claims, but it allows new commitments and
status claims when the label is only "needs check"
([`lib/agents/reply.ts:43`](../lib/agents/reply.ts#L43-L170)), and it does not gate on an unresolved
client. The UI labels the whole section "Client-safe draft. Built only from verified, unflagged
findings", which is stronger than what it delivers.

**Why it blocks:** this is the surface a manager would copy to an upset client. An invented date or a
false "still open" statement is exactly the failure mode the product exists to prevent.

**Acceptance:** no reply is generated while the client/project is unresolved (a holding reply or a
blocked state instead); a sentence that adds a commitment/date/status not present in its cited quote is
either rejected or excluded from the copyable draft; no internal decisions or process language in
client copy; sign-off uses the vendor/team identity (config or inferred from records); per-issue
drafting is required for multi-issue runs. Add a test for the "resolved vs remains open" contradiction
and for an invented future date.

### P0-6. Contradiction detection, commitments, silence and counts are not trustworthy

These are separate symptoms of the same problem: the report has several independent derivations of the
same truth.

- **Skeptic misses the flagship contradiction.** Realistic: `{"flagged":0,"issues":0}` after 10 s, and
  the audit says "No communicated update was contradicted by another record" while the findings show
  Priya resolving LUM-811 on Sep 21 and Sam Rivera re-running QA with blank totals the same day. The
  multi run does flag contradictions, but leaks "Claim 4 (and 9, 26)" and event ids into the
  manager-facing audit.
- **The promise ledger accepts decisions/status assertions.** Demo B has three "broken promises":
  Lin Chen's Sep 24 promise; Marcus Webb's "let us keep MER-101 open until QA passes" (a decision);
  Marcus's "Sep 24 release is cut; invoice fix included" (a status/fix report). The second and third
  are exactly what the AGENTS.md rule says must not be commitments. Demo A has the same Lin Chen
  promise twice (`Lin Chen` and `Lin Chen <l.chen@…>`), counted as "2 of 2 broken".
- **Silence disagrees with itself and the answer key.** Demo top/timeline **3 days**
  (Sep 14→18, broken by a coffee-machine message) vs bottom **10 days**; realistic **3 days** vs bottom
  **11 days**; expected demo **~13-day Jira silence**, expected realistic **8-day Sep 9→17**. The model
  computes silence over all in-scope events (including noise), while the bottom line computes it over
  cited records ([`lib/report/model.ts:744`](../lib/report/model.ts#L744-L764),
  [`lib/report/build.ts:482`](../lib/report/build.ts#L482-L500)).
- **Open-question counts disagree at every level.** Top grouped count vs bottom raw count: realistic
  4 vs 7; multi 5 vs 14; demo 5 vs 17; vague 4 vs 5; sparse 6 vs 34. The page labels "Open questions
  4 · grouped" and the bottom line says "7 open"; both are visible.
- **Finding counts differ between the API and the page.** Realistic model 21 findings vs briefing
  narrative "18"; multi API case model 27 vs issue view 14; demo B 18 vs briefing 18 but verified 1 vs
  briefing 11. The briefing is a second source of truth and should be derived from the model or removed.

**Why it blocks:** the product's differentiation is "trust never depends on what an agent claims"; if
the same report shows two different silences and two different verified counts, the differentiation is
not visible to the judge.

**Acceptance:** one count source; one silence computation over the same cited/relevant record set (or
source-level silence with a clear label); commitments are promise-only and merge by canonical actor +
deadline + issue; deterministic contradiction checks (status Resolved vs QA failure; releasebot
"includes fixes" vs QA "still blank") in addition to the skeptic; manager-facing audit text contains no
claim numbers, ids or agent voice.

## P1 gaps (important, not necessarily submission blockers)

1. **Actions are not decision-ready.** "Resolve the conflict around Ravi Menon owned the VAT….",
   "Resolve the conflict around technical failure: The UTC conversion merged…." and "No urgent next
   step" (realistic) while the client is escalating. No owner, due date or concrete next move. The
   action builder only knows broken promises and conflict pills
   ([`lib/report/model.ts:927`](../lib/report/model.ts#L927-L974)).
2. **"Safe to say" includes non-client-safe material.** Realistic lists "Coverage was thin during
   the…"; the demo lists a process objection and internal QA rule. The label should mean "a manager
   can repeat this to the client", not "this claim is verified".
3. **Plan date window is anchored to the wall clock.** The realistic plan says
   "Focus window: 2026-09-18 → 2026-09-28" for 2024 records; gaps in the sparse run complain about a
   "2026-10-17 focus window". Anchor relative dates to the registry's latest record (or ask for an
   as-of date).
4. **Coverage claims absence when a source is empty.** Sparse: Slack `available: 0, searched: true`
   and "all slack searches returned zero" although no Slack source existed. The three coverage states
   should distinguish unavailable / searched / no results.
5. **Unscoped runs mix tenants.** Vague: 20 findings combine Bright Market and Vertex; commitments
   include a Vertex role mapping; a client reply is still drafted. Group by tenant or require client
   confirmation before drawing a single narrative/reply.
6. **Copy/format bugs.** `Resolvedrecord`, `Ravi Menonrecord` and `Nadia Chen · 2024-09-28record` are
   glued; "Scope confirmed by you — confirmed by you before the run."; blank client/project form;
   "1 verified finding withheld because they carry a conflict."; email addresses in the chasers
   metric; `&lt;…&gt;` entities in ledger actor names.
7. **Open-question grouping is regex-based.** A question about who owned the Sep 20 release decision
   lands in "Client and project" because it says "identified"; the headline then says
   "What remains open: client and project" on a scoped run. Use explicit gap metadata/category rather
   than text matching.
8. **Sparse-run gaps are noisy.** 24 near-duplicate gaps, 34 open, many mention MER-101 being out of
   scope and the 2026 window. Dedupe and rank before display; cap the default view.
9. **Multi-issue per-issue coverage/retry is still missing** (known G-23 remainder): scope/coverage are
   case-level while findings are per issue; a combined `/reply` is possible.
10. **Demo content is inverted.** The start-page escalation begins "Meridian reports that invoice
    totals…" while the declared client is Northwind Logistics; the data has Meridian as the vendor.
    This likely contributes to the scope model's client/project confusion. Change it to "Northwind
    reports…" or make the vendor/project a separate field.

## What is green

- `npm run lint` — pass
- `npm run typecheck` — pass
- `npm run build` — pass
- `npx vitest run` — **46 files / 454 tests pass**
- `npm run test:ui` — **31 Playwright tests pass** (fake LLM, offline)
- Pipeline latency ~50–60 s per run; no stage timeout; no rejected quotes; no crashes in any run.

This is important: **the codebase is healthy; the product output is not.** The current tests assert
invariants and UI mechanics, but they do not assert that the top answer contains the answer, that
verified claims surface as verified findings, that a declared client resolves, or that the demo/report
counts agree. The real-LLM runs should become a checked harness with golden assertions, not a manual
smoke.

## Readiness decision

| Audience | Ready? | Notes |
|---|---|---|
| **Hackathon submission today** | **No** | A judge clicks "Load Northwind scenario" and sees "Client and project not confirmed", "0 verified", "No status transition is recorded", and a client reply with an invented update. That contradicts the pitch. |
| **Hackathon submission after P0-1…P0-5** | Plausible | The realistic run is close; with a deterministic top answer, visible verified evidence, resolved client, safe reply and one count source, it is a strong demo. |
| **Handoff to a developer** | Yes, as a prototype | The architecture and evidence layer are real; this document plus the run artifacts is a concrete backlog. |
| **Judge-supplied exports** | Mixed | Sparse data is handled honestly, but coverage, chasers, actions and gaps need P1 fixes. |

**Recommended stabilization order (do not rewrite the retrieval layer):**

1. Scope determinism + project derivation + project-record units + declared-client role (P0-3, P0-4).
2. Verified-state aggregation and one canonical report model (P0-1, P0-6 counts).
3. Answer-first headline, time-ordered (P0-2).
4. Reply safety gate (P0-5).
5. Deterministic contradictions + commitment guard + silence from one record set (P0-6).
6. Then the P1 actions/copy/coverage/tenant-grouping pass.
7. Re-run this exact five-scenario harness and compare against the answer keys; only then submit.

## Evidence index

- Harness: [`.eval/review-run.mjs`](../.eval/review-run.mjs)
- Northwind A: [report](../.eval/review-demoA-report.json),
  [body](../.eval/review-demoA-body.txt), [top screenshot](../.eval/review-demoA-top.png)
- Northwind B: [report](../.eval/review-demo-report.json),
  [body](../.eval/review-demo-body.txt), [top screenshot](../.eval/review-demo-top.png)
- Realistic: [summary](../.eval/review-realistic-summary.json),
  [body](../.eval/review-realistic-body.txt), [top screenshot](../.eval/review-realistic-top.png)
- Multi: [summary](../.eval/review-multi-summary.json),
  [body](../.eval/review-multi-body.txt), [top screenshot](../.eval/review-multi-top.png)
- Vague: [summary](../.eval/review-realistic_vague-summary.json),
  [body](../.eval/review-realistic_vague-body.txt), [top screenshot](../.eval/review-realistic_vague-top.png)
- Sparse: [summary](../.eval/review-sparse-summary.json),
  [body](../.eval/review-sparse-body.txt), [top screenshot](../.eval/review-sparse-top.png)
- Console timings: [`.eval/review-demo-console.log`](../.eval/review-demo-console.log),
  [`.eval/review-realistic-console.log`](../.eval/review-realistic-console.log),
  [`.eval/review-multi-console.log`](../.eval/review-multi-console.log),
  [`.eval/review-vague-console.log`](../.eval/review-vague-console.log)
- Test logs: [`.eval/review-ui-test.log`](../.eval/review-ui-test.log)
