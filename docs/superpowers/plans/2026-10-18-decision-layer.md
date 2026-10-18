# Decision Layer Submission Readiness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a judge answers the escalation from the first screen; every number and statement matches stored evidence; the same answer survives repeated runs and judge-supplied exports.

**Architecture:** evolve the existing `lib/report/model.ts` `ReportModel` into the canonical `DecisionModel` (facts/trust, promises, contradictions, silences, structured questions, actions, audit, reply eligibility) — no parallel model. New concerns get new modules (`contradictions.ts`, `silence.ts`, `story.ts`); legacy report API fields become adapters over the one model. Investigation hardening (claim quality, tool semantics, scope determinism) lands first because the decision layer consumes its output.

**Tech Stack:** Next.js App Router, TypeScript, Postgres (migrations via `lib/db/migrate.ts`), Vitest + Playwright (fake LLM on :9401), plain CSS.

**Spec:** `docs/decision-layer-plan.md` (the binding authority; §-references below point there). Live-review evidence: `docs/live-run-review-2026-10-18.md`.

## Global Constraints

- No scenario names, ticket prefixes, dates, names or expected sentences in `app/` or `lib/` runtime code (spec §2). Answer keys live in tests/README only.
- `claims.verify_status` three-state contract untouched; facts are a view over it (spec §3).
- Never edit an applied migration; next migration number is **018** (016 scope_review and 017 claim_reviews exist).
- Next requires `export const maxDuration = 60` as a LITERAL in every route.
- No Tailwind; use existing CSS classes in `app/globals.css`.
- Test output pristine; unused vars fail the gate.
- Never call the real LLM in tests (`setLlmClientForTests`, fake fetch); never call real Jira/Slack/Gmail (injected `fetchImpl`).
- Email sender actors keep `Name <addr>` (identity links across tools); display metrics never show raw addresses.
- Prefer e2e for features: route features extend `tests/routes.test.ts` patterns against migrated Postgres; UI features extend `tests/ui/*.spec.ts`.
- Keep `npm run lint`, `npm run typecheck`, `npm run build`, `npx vitest run`, `npm run test:ui` green at every task boundary.

## Review Focus

The five input classes most likely to bite a person, each pinned by a task's test:

1. Repeat run changes the answer (scope drift) — pinned by `tests/scope-determinism.test.ts` (Task 7).
2. A supported restatement downgrades a verified fact — pinned by the cluster fixture (Task 13).
3. Reply invents a date/commitment/status absent from cited facts — pinned by reply validation tests (Tasks 28–30).
4. An unavailable source yields an absence claim ("Slack returned zero") — pinned by coverage tests (Task 31).
5. An unscoped run mixes tenants into one story/reply — pinned by the two-tenant fixture (Task 33).

---

### Task 1: DecisionModel types + count invariants (A3 core)

**Files:**
- Create: `lib/report/decision.ts`
- Test: `tests/decision-facts.test.ts` (new)

**Interfaces:**
- Produces: `type FactState`, `interface Fact`, `interface PromiseRecord`, `interface DecisionCounts`, `buildDecisionCounts(lists)` in `lib/report/decision.ts`. Later tasks extend `DecisionCounts` and hang builders off this module.

**Steps:**
- [ ] RED: `tests/decision-facts.test.ts` — (a) `buildDecisionCounts` returns counts equal to the lengths of the exact lists passed (`facts`, `verifiedFacts`, `needsCheckFacts`, `questions`, `questionGroups`, `promises`, `broken`, `kept`, `unclear` derived from the promises list); (b) constructing counts from a mismatched object throws (simulate by exporting an internal `assertCounts` that takes lists + counts and throws on any mismatch).
- [ ] Run: `npx vitest run tests/decision-facts.test.ts` → FAIL (module missing).
- [ ] GREEN: implement types per spec §3 (`Fact`, `PromiseRecord`, `DecisionCounts`) + `buildDecisionCounts`/`assertCounts` in `lib/report/decision.ts`.
- [ ] Run: same command → PASS.
- [ ] Commit: `feat(decision): DecisionModel types and asserted counts`

### Task 2: Decision fixture export from recorded runs

**Files:**
- Create: `scripts/export-decision-fixtures.ts`
- Create (generated): `tests/fixtures/decision/{demo,realistic,multi,vague,sparse}.json`
- Test: extend `tests/decision-facts.test.ts`

**Interfaces:**
- Consumes: `lib/store.ts` readers (`getInvestigation`, events/claims/commitments/gaps/skeptic notes/scope/coverage) and `lib/db/env.ts` for `DATABASE_URL`.
- Produces: fixture JSON shape `{ investigationId, events, claims, commitments, gaps, skepticNotes, scope, coverage }` used by later tasks' invariant tests.

**Steps:**
- [ ] Script takes `--id <uuid> --name <scenario>` (repeatable) and writes the fixture files; investigation ids are in `docs/live-run-review-2026-10-18.md` (demo A/B, realistic, multi, vague, sparse).
- [ ] RED: test loads each fixture and asserts non-empty `events`/`claims` and the expected scenario record counts (41, 41, 276, 276, 3).
- [ ] Run → FAIL (no fixtures). Run the script against local Postgres → fixtures written. Run → PASS.
- [ ] Commit: `test(decision): regression fixtures from the seven recorded runs`

### Task 3: I6 retrieval checks in the eval harness

**Files:**
- Modify: `.eval/review-run.mjs`

**Interfaces:**
- Produces: per-run `retrieval` section in `.eval/review-*-summary.json` — answer-key record read (yes/no + claim/event id) per scenario, per-investigator verified/supported/rejected, failed/never-searched queries, invented keys.

**Steps:**
- [ ] Add an answer-key table (scenario → must-read record markers, e.g. text fragments/ticket keys from README-level keys, kept in `.eval/` only, never in `app/`/`lib/`).
- [ ] After assemble, read the report JSON + registry claims and emit the retrieval report; a `--gate` flag fails the run when a must-have record was never read.
- [ ] Verify: `node .eval/review-run.mjs --help` runs; no `app/`/`lib/` changes. Commit: `eval: retrieval answer-key checks in the review harness`

### Task 4: I2 — structured tool result statuses

**Files:**
- Modify: `lib/agents/tools.ts`, `lib/pipeline/coverage.ts`
- Test: `tests/agent-tools.test.ts`

**Interfaces:**
- Produces: tool results carry `status: "ok" | "not_in_export" | "excluded_by_scope" | "empty" | "failed"`; `get_issue` checks the full registry before scope filtering (exists-but-excluded → `excluded_by_scope` with add-back hint; absent → `not_in_export`; source absent → `not_in_export`). Coverage gains `state: "not-in-export" | "available-not-searched" | "searched-with-results" | "searched-empty" | "failed"`.

**Steps:**
- [ ] RED: `tests/agent-tools.test.ts` — (a) `get_issue` on a key absent from the registry returns `status: "not_in_export"` and message "not in this export"; (b) a key present but scope-excluded returns `excluded_by_scope` with the add-back path; (c) `search_*` on an unavailable source returns `status: "not_in_export"`, never `count: 0`.
- [ ] Run → FAIL. Implement in `tools.ts` (registry check precedes scope filter) + coverage `state` derivation. Run → PASS; full `npx vitest run` green.
- [ ] Commit: `feat(tools): structured source statuses separate absence from exclusion`

### Task 5: I5/F2 — plan date window anchored to records

**Files:**
- Modify: `lib/pipeline/plan.ts`, `lib/agents/analyst.ts`
- Test: `tests/plan-data.test.ts`

**Interfaces:**
- Produces: `deriveDateWindow(escalation, referenceIso)` unchanged signature, but `analyst.ts` passes the **latest incident-relevant event ts** (max event UTC timestamp in the registry at plan time) as `referenceIso`, labelled "relative to the latest record"; a model-returned window wholly outside the registry range is rejected (falls back to the derived window).

**Steps:**
- [ ] RED: plan-data test with 2024-only events asserts the derived window is in 2024, not wall-clock 2026; a model window in 2026 is rejected.
- [ ] Run → FAIL; implement; Run → PASS; full suite green.
- [ ] Commit: `fix(plan): anchor focus windows to the latest record, not the wall clock`

### Task 6: I5 — promisor canonicalization + entity decoding

**Files:**
- Modify: `lib/pipeline/commitments.ts` (merge key uses resolved actor id), `lib/report/build.ts` (ledger display)
- Test: `tests/commitments.test.ts` (extend; create if absent)

**Interfaces:**
- Consumes: identity map from `lib/ingest/identity.ts` / store actors.
- Produces: one commitment per canonical actor + normalized object + deadline + issue; `Lin Chen` and `Lin Chen <l.chen@…>` merge; HTML entities decoded before display and matching; no address in the ledger metric.

**Steps:**
- [ ] RED: fixture with two promises (plain name vs `Name <addr>`) and an `&amp;`-encoded name asserts one merged promise, decoded display name.
- [ ] Run → FAIL; implement (resolve promisor through the actor-identity map at merge time); Run → PASS.
- [ ] Commit: `fix(commitments): canonical promisor identity and entity decoding`

### Task 7: B1 — deterministic scope graph

**Files:**
- Modify: `lib/pipeline/scope.ts` (replace `anchorComponents` :579 + `resolveScope` :609 selection with a deterministic graph)
- Test: `tests/scope-determinism.test.ts` (new), `tests/scope.test.ts` (keep green)

**Interfaces:**
- Produces: `resolveScope(events, input)` — same signature — now: nodes (declared client, projects, prefixes, keys, channels, sender domains, email threads), edges (co-occurrence, ticket refs, thread membership, plan hypotheses, overrides), seeds (declared/learned/escalation anchors + manager includes), selection = seed-connected components; several seeded components all kept; declared/learned/escalation anchors never dropped for disjointness; project units (a selected prefix/channel/thread pulls in ALL its records); linked tickets at one hop only.

**Steps:**
- [ ] RED: `tests/scope-determinism.test.ts` — (a) two runs with different model-proposal orders over the same events produce identical selected scope + in-scope event ids; (b) demo-shaped fixture: selecting prefix MER keeps MER status/assignee/comment records; (c) realistic-shaped fixture: selecting LUM keeps referenced LUM-804 without pulling distractor prefixes.
- [ ] Run → FAIL; implement the graph; Run → PASS; `tests/scope.test.ts` + full suite green.
- [ ] Commit: `feat(scope): deterministic seed graph with project units`

### Task 8: B3 — plan-assisted scope refinement

**Files:**
- Modify: `lib/pipeline/scope.ts` (export `refineScopeWithPlan`), `app/api/investigations/[id]/plan/route.ts` (call after plan), `lib/store.ts` (record added anchors)
- Test: `tests/scope.test.ts` (extend)

**Interfaces:**
- Produces: `refineScopeWithPlan(scope, plan, events): { scope, added }` — plan-named ticket keys/channels validated against the registry, added only when they share a record/thread/reference with a client seed or the declared client's records reference them; additions logged for the review UI.

**Steps:**
- [ ] RED: plan naming MER-87/MER-101 + meridian-billing on a client-seeded fixture adds MER + channel; a plan naming a distractor-tenant key adds nothing and records why.
- [ ] Run → FAIL; implement; Run → PASS; full suite green.
- [ ] Commit: `feat(scope): plan-assisted refinement with registry validation`

### Task 9: B2 — split client vs project resolution

**Files:**
- Modify: `lib/report/model.ts` (`buildClientModel` :572), `app/_components/briefing/model-view.tsx`
- Test: `tests/report-model.test.ts` (extend)

**Interfaces:**
- Produces: `clientKnown` (declared client OR verified client-domain/name anchor) and `projectKnown` (explicit project OR selected prefix/channel label) resolved independently; a client with no project renders the project card as "Not named; scope is MER / meridian-billing"; "Confirm client" appears only when NO client can be established, prefilled with declared client + registry candidates (the `/client` route from the baseline already persists this).

**Steps:**
- [ ] RED: report-model fixture with declared client + scope prefix but no model project string asserts client resolved, project card named from scope, no blocking of role/state cards.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `fix(report): client and project resolve independently`

### Task 10: B4 — email direction meta + role evidence scorer

**Files:**
- Modify: `lib/ingest/email.ts` (meta gains `from`, `to`, `cc`, `direction: "inbound" | "outbound"`), `lib/report/model.ts` (role scorer replaces :526 rule, `ReportActorModel.roleEvidence: string[]`)
- Test: `tests/normalize.test.ts` (email meta), `tests/report-model.test.ts` (roles)

**Interfaces:**
- Produces: role scored from domain evidence + channel evidence (shared = client-domain messages present) + email direction + roster override + recorded model suggestion (thresholded, never a free pass); conflicts → `unknown` WITH evidence list; state still computes last client contact from client evidence (Task 11).

**Steps:**
- [ ] RED: (a) ingest test: email event meta carries direction in/out from headers; (b) role tests: Priya (demo cast, client domain + slack) = client; Dana (realistic, inbound email) = client; Lin/Marcus = internal; an ambiguous actor gets `role: "unknown"` + non-empty `roleEvidence`.
- [ ] Run → FAIL; implement; Run → PASS; full suite green (re-ingest fixtures regenerate meta, so re-run demo-roundtrip too).
- [ ] Commit: `feat(roles): evidence-scored client/internal roles with email direction`

### Task 11: B5 — last contact and chasers from client evidence

**Files:**
- Modify: `lib/report/model.ts` (:850-887 lastClientContact), `lib/report/build.ts` (chasers in `buildMetrics`)
- Test: `tests/report-model.test.ts` (extend)

**Interfaces:**
- Produces: `clientEvidenceFor(actor, events)` shared helper (client domain, inbound direction, shared-channel participation, client channels); `lastClientContact` = latest incident-relevant client-evidence event (not role, not general chatter); chasers count client-evidence actors on incident-relevant records, else "not determined (client unresolved)"; clean names, no addresses; model exposes `clientEvidence`.

**Steps:**
- [ ] RED: sparse-shaped fixture (client unresolved, internal engineer chases) asserts chasers "not determined"; realistic-shaped asserts Dana with date; demo asserts Priya.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `fix(report): last client contact and chasers from client evidence`

### Task 12: B6 — pre-run scope review UX

**Files:**
- Modify: `app/investigations/[id]/progress/page.tsx`
- Test: `tests/ui/robustness.spec.ts` (extend)

**Interfaces:**
- Consumes: scope + coverage from the run state; added anchors from Task 8.
- Produces: review shows scope as units (project/prefix/channels/domains); "Project MER found but not included" / "client domain in excluded records" one-click add; "Confirmed by you" only after a real confirm; client/project prefilled from declared client + registry candidates.

**Steps:**
- [ ] RED: Playwright — demo scope review lists MER + channel as units, adds nothing by default, completes to a report with status/state answered; re-run reuses confirmed anchors.
- [ ] Run → FAIL; implement; Run → PASS; full UI suite green.
- [ ] Commit: `feat(ui): scope review shows units with one-click add-back`

### Task 13: A1 — assertion clusters

**Files:**
- Modify: `lib/report/model.ts` (`verificationFor` :395 + finding grouping)
- Test: `tests/decision-facts.test.ts` (extend), `tests/report-model.test.ts`

**Interfaces:**
- Produces: assertion key `(eventId, category, normalizedText)`; fact clusters across records (same actor + normalized object + high text similarity — reuse `clusterCommitments` similarity approach from `build.ts:309`); representative = verified > supported > unverified, then confidence, then recency; incompatible assertions → `conflict` flag, both claim ids kept; rejected claims never form a fact.

**Steps:**
- [ ] RED: one verified + two supported restatements (same event/category) → ONE verified fact; `counts.verified === facts.filter(state === "verified").length`; contradictory pair emits `conflict`.
- [ ] Run → FAIL; implement; Run → PASS; report-model tests green.
- [ ] Commit: `feat(facts): assertion clusters keep the strongest verified state`

### Task 14: A2 — client-safe classification

**Files:**
- Modify: `lib/report/model.ts` (Fact `clientSafe` + flags), reply consumers read it
- Test: `tests/decision-facts.test.ts` (extend)

**Interfaces:**
- Produces: `clientSafe` per fact from category (cause/fix/promise/client-visible status/communication = safe; process/coverage/ownership/internal-decision/QA chatter = not); `entailment_refutes`/`negative_inference` (without completeness proof) facts are flagged `needs_check` at best, never in top story/"You can say"/reply; supported+clientSafe labelled "needs check".

**Steps:**
- [ ] RED: a `entailment_refutes` fact and a coverage-process fact never enter `verifiedClientSafeFacts`; a supported clientSafe fact is labelled needs-check.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(facts): client-safe classification and refute gating`

### Task 15: A3 — one count object everywhere

**Files:**
- Modify: `lib/report/model.ts` (counts via `buildDecisionCounts`), `lib/report/bottomline.ts`, `lib/report/briefing.ts` (confidence counts read the model), report route/page
- Test: `tests/report-model.test.ts` (extend), `tests/ui/model-report.spec.ts`

**Interfaces:**
- Consumes: `buildDecisionCounts` (Task 1).
- Produces: every count the API/page shows derives from one object; grouped-vs-raw question counts labelled ("N themes · M questions"); legacy API fields (briefing confidence, bottomLine cells) become adapters over it.

**Steps:**
- [ ] RED: report API test (routes pattern) asserts `bottomLine` question count equals model's labelled group/raw pair; briefing confidence equals model counts; mismatch throws.
- [ ] Run → FAIL; implement; Run → PASS; full suite + build green.
- [ ] Commit: `refactor(report): one count object behind every displayed number`

### Task 16: I1 — atomic, quote-grounded claims

**Files:**
- Modify: `lib/agents/investigator.ts` (system prompt), `lib/agents/tools.ts` (`claimFromArgs` validation)
- Test: `tests/agent-tools.test.ts`, `tests/investigator.test.ts`

**Interfaces:**
- Produces: submission validation — causal/ownership language ("proves/caused/means/attributes") absent from the quote rejects the claim with a message offering observation-or-note; negative claims require a completeness/coverage phrase ("no reply in the records searched") else rejected as note-worthy; prompt gains positive/negative examples (observation, restatement, inference, decision, promise, status).

**Steps:**
- [ ] RED: (a) claim "X is the identified cause" with quote lacking causal language → rejected with guidance; (b) negative claim without coverage phrase → rejected; (c) observation claim passes.
- [ ] Run → FAIL; implement prompt + validation; Run → PASS.
- [ ] Commit: `feat(investigators): one quote, one assertion at the claim boundary`

### Task 17: C1 — one case state

**Files:**
- Modify: `lib/report/model.ts` (delete `buildState` :766-925; render state from `buildCaseState` extended), `lib/report/case-state.ts`
- Test: `tests/case-state.test.ts` (extend), `tests/report-model.test.ts`

**Interfaces:**
- Produces: extended `CaseState` — `currentStatus` (latest transition, else verified status claim, labelled basis, never a client complaint), `owner` (assignee transition → verified ownership claim → "No owner recorded" + separate labelled last-status-change-by), `latestFix` (vendor-authored; contradicted fix labelled "attempted fix, QA failed"), `lastClientContact`/`lastInternalUpdate` (client evidence, event-actor fallback), `asOf` (latest incident-relevant record), every field with `source`/`basis`/`unknownReason`.

**Steps:**
- [ ] RED: demo-shaped fixture asserts Resolved with Jira basis; ownerless variant renders "No owner recorded; last status change by Marcus Webb"; realistic asserts Resolved/Ravi/5.3.4; sparse asserts honest unknowns. API test asserts `report.caseState` IS this object (no parallel buildState output).
- [ ] Run → FAIL; implement; Run → PASS; full suite green.
- [ ] Commit: `refactor(report): one case state with claim fallback`

### Task 18: C2 — promise-only ledger with computed outcome

**Files:**
- Modify: `lib/pipeline/commitments.ts` (`PROMISE_CUE` :69 drops `keep .* open`; require forward-looking object + deadline/date or will/commit/schedule wording)
- Test: `tests/commitments.test.ts` (extend)

**Interfaces:**
- Produces: decisions, status assertions ("release is cut; fix included"), completed-fix reports, QA results rejected at submission; merge per Task 6 key; `applyStatusRules` outcome (kept/broken/unclear/withdrawn, contested flag) is the single source for ledger, metric, story, bottom line.

**Steps:**
- [ ] RED: status-assertion and completed-fix submissions rejected; "keep MER-101 open until QA passes" rejected; demo fixture has exactly Lin Chen's promise (+ any genuine others); bottom-line "2 of 2" equals cards/ledger.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `fix(commitments): promise-only ledger with code-computed outcomes`

### Task 19: C3 — deterministic contradiction detection

**Files:**
- Create: `lib/report/contradictions.ts`
- Modify: `lib/report/model.ts` (audit merges detectors), `lib/pipeline/verify-claims.ts` OR report build boundary (run detectors)
- Test: `tests/contradictions.test.ts` (new)

**Interfaces:**
- Produces: `detectContradictions(facts, events, promises, asOf): Contradiction[]` — detectors `premature_resolution`, `release_fix_claim`, `missed_promise`, `unanswered_client`, `closure_unverified`, `handoff_missing`, `status_reversal`; each with stable id, severity, bases (finding/claim/event ids), manager-facing text.

**Steps:**
- [ ] RED: realistic-shaped fixture fires `premature_resolution` (Resolved + same-day QA re-run); demo-shaped fires `premature_resolution` (MER-101) + `missed_promise`; empty input → empty array.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(report): deterministic contradiction detectors`

### Task 20: C4 — skeptic output sanitization

**Files:**
- Modify: `lib/report/gaps.ts` (`cleanGapText` :37), skeptic note mapping in `lib/report/model.ts`
- Test: `tests/gaps-rank.test.ts` (extend)

**Interfaces:**
- Produces: `claim_index` mapped to representative finding title (never "Claim N"); agent voice stripped to source labels ("the Jira search for SUP-2231"); notes referencing un-mappable raw ids are dropped (no "a stored record" placeholder); near-duplicates deduped; capped.

**Steps:**
- [ ] RED: notes with "Claim 4 (and 9, 26)", `e_58b4…`, "I was unable" render as manager-facing text with source labels; unmappable id-only notes dropped.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `fix(skeptic): manager-facing audit text without ids or agent voice`

### Task 21: C5 — one silence definition

**Files:**
- Create: `lib/report/silence.ts`
- Modify: `lib/report/model.ts` (delete `computeSilence` :744), `lib/report/build.ts` (`buildSilences` + inline metric read it), `lib/report/briefing.ts`
- Test: `tests/silence.test.ts` (new)

**Interfaces:**
- Produces: `incidentRelevant(events, claims, commitments, gaps): Event[]` (cited + status/assignee transitions + client messages + fix/release records; excludes channel chatter/distractors); `computeSilences(...)` returns `{ clientWait, project, bySource, headline }` — clientWait = last client message → first vendor response (or asOf); project = longest incident-relevant gap; per-source longest; one headline by decision impact. All four old derivations become projections.

**Steps:**
- [ ] RED: demo fixture → ~13-day Jira/project silence AND separate clientWait, both from one object; coffee-machine/distractor messages never set or break a window; "no incident activity" wording (never "no recorded activity") when noise exists.
- [ ] Run → FAIL; implement; Run → PASS; full suite green.
- [ ] Commit: `refactor(report): one incident-relevant silence computation`

### Task 22: C6 — structured gap categories

**Files:**
- Create: `migrations/018_decision_layer.sql` (`gaps.category` nullable + backfill via deterministic derivation)
- Modify: `lib/store.ts` (write/read category), `lib/agents/tools.ts` (gap submission accepts category), `lib/report/gaps.ts` + `lib/report/model.ts` (group by category, explicit next-step copy per category)
- Test: `tests/routes.test.ts` (migration + API), `tests/gaps-rank.test.ts`

**Interfaces:**
- Produces: `GapInput.category: "scope" | "coverage" | "state" | "technical" | "commitment" | "communication" | "ownership" | "other"`; legacy gaps get deterministic fallback (NOT text regex); system questions added only when true (client unresolved / no owner / no fix / no client evidence / available-not-searched); dedupe by normalized meaning; caps (8 groups / 20-30 raw); `counts.questionGroups` + `counts.questions` labelled everywhere.

**Steps:**
- [ ] RED: route test creates gaps with categories and asserts grouped output; legacy rows (no category) get fallback; the realistic "client and project" false positive is gone.
- [ ] Run `npm run db:migrate` then tests → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(gaps): structured categories with one labelled count`

### Task 23: I3 — gap-driven targeted retry

**Files:**
- Modify: `lib/pipeline/assemble.ts` (`needsRetry` :158 extended with reasons), `lib/orchestrator.ts` (targeted retry with explicit queries)
- Test: `tests/orchestrator.test.ts` (extend), `tests/routes.test.ts`

**Interfaces:**
- Produces: retry reasons from unresolved hypotheses, available-unsearched sources, answerable skeptic unanswered/never-searched notes, question groups with zero visible facts; retries only the relevant investigator kind(s) with explicit queries; ONE extra pass; reason + queries logged to the stage log and surfaced in "How this was produced" ("retried for X").

**Steps:**
- [ ] RED: fixture with a missing referenced ticket triggers exactly one targeted retry of root_cause; a fully covered run does not retry; retry does not duplicate claims or rerun done investigators.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(orchestrator): gap-driven targeted retry with logged reasons`

### Task 24: I4 — skeptic reliability

**Files:**
- Modify: `lib/agents/skeptic.ts` (prompt carries deterministic-detector checklist), orchestrator/skeptic boundary (focused second pass over top claims only when a detector fired or first pass found nothing, capped)
- Test: `tests/skeptic.test.ts` (extend; create if absent)

**Interfaces:**
- Consumes: `detectContradictions` (Task 19).
- Produces: detector findings always present regardless of skeptic output; "no contradiction found in the records searched" wording only when BOTH are empty; a zero-finding skeptic never suppresses a fired detector.

**Steps:**
- [ ] RED: fixture with a premature resolution + skeptic mocked to zero still renders the contradiction in the audit.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(skeptic): deterministic checklist gates the soft pass`

### Task 25: D1–D3 — deterministic answer-first story

**Files:**
- Create: `lib/report/story.ts`
- Modify: `lib/report/model.ts` (headline from story builder), `app/_components/briefing/*` (first screen)
- Test: `tests/story.test.ts` (new), `tests/ui/model-report.spec.ts` (extend)

**Interfaces:**
- Consumes: facts (Task 13/14), promises ledger (Task 18), CaseState (Task 17), questions/actions.
- Produces: `buildStory(model): { sentences: { text, findingIds }[], statsLine, nextStep, tooThin }` — cause (verified cause / "evidence points to… needs a check" / "records do not establish a cause"), promise from the ledger, now-state from CaseState (known fields only), open question + next step; timestamp-ordered ("then" never introduces an earlier date; date-only ts → "on/around"); <4 relevant records or no verified fact → first sentence states thinness.

**Steps:**
- [ ] RED: golden fixture tests (demo, realistic, sparse) assert story contains cause/promise-outcome/status/next-step and NO finding-type metadata ("the first record is a…"); property test: any "then" pair has date2 ≥ date1.
- [ ] Run → FAIL; implement; Run → PASS; UI test asserts first screen shows all four.
- [ ] Commit: `feat(story): deterministic answer-first narrative with citations`

### Task 26: G1 — action policy from the decision model

**Files:**
- Modify: `lib/report/model.ts` (`buildActions` :927)
- Test: `tests/report-model.test.ts` (extend)

**Interfaces:**
- Produces: actions built from model state — client waiting/unanswered → "Reply to <client> with the verified status and the open question"; broken promise → "Agree a new date with <promisor> for <object> and tell <promisee>"; contradiction → "Resolve <specific contradiction> before repeating the resolution"; missing owner → "Assign an owner for <ticket>"; "no urgent action" only when resolved + no contradiction + client contacted + no open question; each action carries finding ids, impact, full text.

**Steps:**
- [ ] RED: realistic-shaped fixture asserts the promise action names promisor/object (no truncation); no "Resolve the conflict around <finding label>"; no "No urgent next step" while the client is unresolved.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `fix(actions): decision-model actions with owners and full text`

### Task 27: G2 — audit rendering

**Files:**
- Modify: `lib/report/model.ts` (`buildAudit`), `app/_components/briefing/sections.tsx`
- Test: `tests/report-model.test.ts` (extend)

**Interfaces:**
- Consumes: contradictions (Task 19) + sanitized skeptic notes (Task 20).
- Produces: deterministic contradictions first, then notes; each row = finding title, two sides, source/date, manager next step; no raw ids/claim numbers/placeholders/agent voice; unresolved client → contradictions still shown labelled "internal only".

**Steps:**
- [ ] RED: audit fixture asserts order + readable text; unresolved-client case still lists internal contradictions.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `fix(audit): contradictions first, manager-readable rows`

### Task 28: E1 — reply eligibility gate

**Files:**
- Modify: `lib/agents/reply.ts`, `app/api/investigations/[id]/reply/route.ts` (422 with reason)
- Test: `tests/routes.test.ts` (extend)

**Interfaces:**
- Produces: `replyEligible(model)` — client resolved AND project/scope named AND ≥1 verified client-safe fact AND no blocking client-evidence exclusion AND (multi-issue ⇒ explicit issueId); otherwise 422 + specific reason; UI shows "Confirm client"/"Not enough verified facts" instead of a draft button.

**Steps:**
- [ ] RED: unresolved client → 422 "client unresolved", no draft; zero verified client-safe facts → 422; eligible run drafts.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(reply): eligibility gate with explicit reasons`

### Task 29: E2 — reply fact pack and sentence validation

**Files:**
- Modify: `lib/agents/reply.ts` (typed fact pack + validators), `lib/report/case-state.ts` consumers
- Test: `tests/reply.test.ts` (extend; create if absent)

**Interfaces:**
- Produces: fact pack = cause/fix/promise/status/client-communication only (verified, unflagged, unreviewed, clientSafe); sentence validators — status words match `CaseState` NOW (not historical quotes), commitments/dates cite a verified promise (no implied update dates), owner claims require canonical owner, no internal blame/QA narration, sign-off = vendor/team identity from scope or neutral "Support team" (never "Anduin"); <1 surviving sentence → explicit no-draft result.

**Steps:**
- [ ] RED: "the issue remains open" against a Resolved CaseState is dropped; invented "we will provide an update"/dated sentence dropped; "we are verifying" with no record dropped; "resolution proceeded nonetheless" dropped; sign-off asserted vendor/neutral.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(reply): sentence-level truth validation against the decision model`

### Task 30: E3 — multi-issue reply enforcement

**Files:**
- Modify: `app/api/investigations/[id]/reply/route.ts`, `lib/agents/reply.ts` (per-issue fact pack)
- Test: `tests/routes.test.ts` (extend), `tests/ui/multi-issue.spec.ts`

**Interfaces:**
- Produces: `issueId` required when `issues.length > 1` (missing/unknown → 400/422); drafts stored per issue (`issue_report_extras`); all-issues view has no copyable reply; per-issue fact packs never cross issues.

**Steps:**
- [ ] RED: multi-issue POST /reply without issueId → 422; with issueId → draft cites only that issue's claims; combined draft impossible.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(reply): per-issue drafting enforced at the API boundary`

### Task 31: F1 — coverage states end to end

**Files:**
- Modify: `lib/pipeline/coverage.ts` (state field surfaced), prompts (`lib/agents/*`) receive the state, report coverage section wording
- Test: `tests/routes.test.ts` / `tests/coverage.test.ts` (extend)

**Interfaces:**
- Consumes: Task 4 statuses.
- Produces: `searched` only when a tool call returned a result count; `not-in-export` when no records/source; `available-not-searched`; `searched-empty`; `failed`; report says "Slack was not part of this export; no conclusion about Slack."; `neverSearched` only for available-unsearched.

**Steps:**
- [ ] RED: sparse-shaped fixture asserts Slack not-in-export (not "searched: true"), no absence claim; agent prompt includes the state.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `fix(coverage): five honest states, no absence from unavailable sources`

### Task 32: F3 — sparse inputs, copy fixes, intake labels

**Files:**
- Modify: `lib/report/model.ts`/`build.ts` (chasers/gaps/actions degrade), `scripts/gen-demo.ts` + regenerate `public/demo/` (escalation starts "Northwind reports…", vendor/project explicit), `app/page.tsx` (intake labels: "Client (the external party)" vs "Project/product (optional)"), entity decoding at display
- Test: `tests/ui/report.spec.ts` / fixture tests

**Interfaces:**
- Produces: sparse: chasers "not determined", deduped capped gaps, no placeholder text; demo escalation copy corrected; intake distinguishes client from project; actor display names everywhere; no duplicated "confirmed by you" phrase.

**Steps:**
- [ ] RED: fixture tests for chasers-not-internal + gap dedupe; start-page test asserts "Northwind reports…" copy and distinct labels.
- [ ] Run → FAIL; implement; `npm run demo:gen`; Run → PASS.
- [ ] Commit: `fix(scenarios): truthful sparse metrics, demo copy, intake labels`

### Task 33: F5 — unscoped multi-tenant cards

**Files:**
- Modify: `lib/pipeline/scope.ts` (tenant cluster detection: domains/prefixes/channels/mentions), `lib/report/model.ts` (candidate engagement cards), `app/_components/briefing/*`
- Test: `tests/scope.test.ts` (extend), `tests/ui/report.spec.ts`

**Interfaces:**
- Produces: no client seed + >1 tenant cluster → NO single DecisionModel story/ledger/reply across tenants; candidate engagement cards ("Bright Market / LUM", "Vertex / RAV") with evidence counts + confirm action; confirmed scope persists and runs the normal model; single-tenant unscoped run shows the one tenant's facts labelled "single engagement in the export; client not confirmed".

**Steps:**
- [ ] RED: two-tenant fixture asserts candidate cards, no cross-tenant story sentence, no reply; single-tenant unscoped asserts the labelled line.
- [ ] Run → FAIL; implement; Run → PASS.
- [ ] Commit: `feat(scope): tenant clustering with candidate engagement cards`

### Task 34: P7 — real-run verification and freeze

**Files:**
- Modify: `.eval/review-run.mjs` (gate flags from Task 3 + invariant checks), README (answer-key/verification protocol)
- No new runtime code.

**Steps:**
- [ ] Run `npm run lint`, `npm run typecheck`, `npm run build`, `npx vitest run`, `npm run test:ui` — all green.
- [ ] Real-LLM eval: 5 scenarios × 2 (demo, realistic, multi, vague, sparse) with `--gate`; zero count mismatches, zero invented reply facts, first screen complete. Costs real tokens — requires the running app on :3000 with credentials.
- [ ] Fix any failures (each fix RED→GREEN), re-run to green.
- [ ] Update AGENTS.md stale migration reference (015 → latest) + report revision notes; commit.
- [ ] Cold-review pass of first screens + replies per spec §12.4.
