# AGENTS.md

## Project context

### Problem statement (verbatim)
A client escalates a problem, and the team has to piece together what happened:
who did what, when, what was promised, and what went wrong. The history is
spread across tickets, emails and chat, so the answer takes days and the client
waits. Can you build a tool to consolidate and organize context around a project,
and give a clear picture of what has happened every step along the way?

### Our interpretation
A tool that investigates a project's scattered history (Jira, email, Slack) and
produces a clear, ordered, source-backed account of what happened, so a manager
can answer an escalation in minutes instead of days.
Scope: consolidate multiple sources into one organized view, then produce the
step-by-step picture. OUT of scope: continuous sync, real-time ingestion,
multi-project management, auth, client-safe vs internal views.

### Primary user
A manager (account manager, support lead, eng manager) who must answer an upset
client now. Success metric: time to a trustworthy answer.

### What the output must answer
1. Who did what
2. When (ordered timeline across all sources)
3. What was promised (ledger: who, to whom, deadline, status kept/broken/unclear)
4. What went wrong (root cause AND process failures: missed handoffs,
   unannounced releases, unanswered messages)
5. What we could not determine (explicit gaps; never guess)

### Architecture: agents retrieve, code verifies
Agents do the retrieval. They call source tools to find and read items. The tool
layer, not the agent, is the system of record: every item a source tool returns
is normalized and saved to the Evidence Registry automatically, with source,
item ID, UTC timestamp, author, full raw text and URL. Agents cite an item ID
plus an exact quote. A deterministic verifier checks that quote against the
stored raw text. Trust never depends on what an agent claims it saw.

(In code the registry rows are the `events` table and the `Event` type; "item"
is the user-facing name for the same thing. Agent tools take `item_id`; the
stored claim field is `eventId` and both spellings are accepted on input.)

(In code the registry rows are the `events` table and the `Event` type; "item"
is the user-facing name for the same thing. Agent tools take `item_id`; the
stored claim field is `eventId` and both spellings are accepted on input.
Verification states are `verified | supported | rejected | unverified`, stored
in `claims.verify_status` with per-check detail in `claims.verify_checks`.)

### Pipeline
1. Escalation intake: the manager pastes the client's escalation message and
   selects the project sources (Jira project key, Slack channels, mailbox filter).
2. Issue Analyst: reads the escalation and writes a structured investigation
   plan — hypotheses to test (each with a test and a falsification criterion),
   a per-source search plan, seed terms/synonyms, people to look at, a focus
   window, and the unknowns to keep open. It plans against a deterministic
   vocabulary digest of the in-scope records (ticket keys, version-like
   builds, channels, domains, frequent terms — `lib/pipeline/vocabulary.ts`),
   so internal code names and versions are planned for even when the
   escalation never mentions them. The plan is stored rendered in `plan` and
   structured in `plan_data` (`lib/pipeline/plan.ts`); unusable model output
   degrades to free text.
2b. Scope identification (at plan time, `lib/pipeline/scope.ts`): the manager
   may declare the client at intake; the model proposes further identifiers
   (client, project, ticket prefixes, Slack channels, sender domains) from the
   escalation, and CODE keeps only identifiers that actually exist in the
   registry (a key mentioned or referenced in any record exists — an
   engagement may live entirely in Slack/email). The declared client also
   links deterministically to registry features whose names start with one of
   its tokens (`northwind.example` with "Northwind Logistics"; a token merely
   appearing mid-name never links). Anchors (declared client, escalation
   sender/ticket evidence, deterministic links, previously learned
   identifiers, model proposals) are graded: >2 convergent anchors -> `scoped`, 1-2 -> `partial`
   (runs scoped but the report shows an "unconfirmed scope" warning with the
   linking evidence), 0 -> unscoped with an honest "every stored record was
   searched" line. Convergence is bridged by shared records AND shared email
   threads. Anchors carrying escalation evidence or learned identifiers are
   never dropped when components disagree — they union and confidence stays
   capped. Confirmed scopes are learned per declared client
   (`learned_scopes` table, migrations/011) and offered back as re-verified
   prior anchors on the next investigation. All source tools, agent prompts
   and the report are scoped accordingly (email replies follow their thread);
   excluded records AND claims are counted and disclosed in the report.
2c. Issue decomposition (G-23, `lib/pipeline/issues.ts`, migration 012): the
   analyst also decides how many **independent** issues the escalation
   contains (1–3), and returns `issues[]` (title, client ask, summary,
   confidence). Facets of one incident — root cause, a failed fix, a
   premature closure, unanswered chases, an SLA consequence — are ONE issue,
   not several. CODE persists the issues (`issues` table) and auto-confirms a
   single issue; with more than one, the pipeline pauses after plan and the
   progress page shows an editable review (rename, edit ask/summary, remove,
   merge into one, add up to three) before any investigator runs. The cap is
   three; beyond that the plan reports the overflow and the manager is asked to
   split the escalation. Claims and gaps carry `issue_id`; the review is what
   separates the timeline, promises and reply.
3. Investigators run in PARALLEL, split by QUESTION, not by person. Each may
   search any source:
   - Root cause: what went wrong technically, when it first appeared, failed fixes
   - Commitments: promises made and whether they were kept
   - Decisions and ownership: who decided or owned what, handoffs, escalations
4. Evidence Registry: filled by the tool layer on every retrieval.
5. Skeptic (runs after the investigators): finds contradictions, claims with weak
   support, suspicious silences, unanswered questions, and sources or angles
   that were never searched. Feeds the "could not determine" list.
6. Verifier, two layers. Layer 1 (CODE): the whitespace-normalized quote must
   appear verbatim in the cited item, and the claim's actor and timestamp must
   match the item's author and time (normalized identity comparison; ts within
   60s or a date-only claim ts on the item's UTC date; a missing claim ts is
   nothing to check). Layer 2 (isolated model call): one call per code-surviving
   claim that sees ONLY the claim text and the quote and answers whether the
   quote supports the claim (`lib/pipeline/entailment.ts`; concurrency 8, 10s
   per call, ~40s budget, degrades to `unavailable`). Three states:
   **verified** (quote + actor/time + model support), **supported** (quote
   verified but any soft check failed or the model check didn't run — shown in
   the timeline wearing a "check before repeating" label), **rejected** (quote
   not found or item missing — excluded from the timeline; a model can only
   downgrade, never reject). If key questions remain open, allow one
   retry pass (max 2 iterations total), then finish with the gaps listed.
7. Assemble: timeline, commitments ledger, gaps, and three-state stats
   (verified/supported/rejected); a question group counts as answered when it
   has at least one verified or supported claim.

### Source tools (agents call these)
search_jira(jql_or_text), get_issue(key) (comments + changelog),
search_slack(query, channel?, date range?), get_slack_thread(channel, ts),
search_email(query, from?, date range?), get_email_thread(id).
Registry tools: verify_quote(item_id, quote), submit_claim(...).
Each source tool sits behind a Source interface with two implementations:
live (server-held read-only credentials) and export-upload (fallback).
Normalization and identity resolution (alias map, LLM-suggested merges, ticket-ID
cross-references) run inside the tool layer on whatever is retrieved.

### Shared claim schema (all agents)
{ type, text (one sentence), actor, quote (exact substring), item_id, ts,
  status (kept|broken|unclear|n/a), confidence, issue_id (one of the confirmed
  issues; required when the escalation has more than one) }

### Demo scenario (synthetic, labeled as such in the app)
Northwind Logistics vs Meridian Billing: invoice totals wrong after a timezone
change in release 4.12. Fix promised for the Sep 24 release, never shipped;
engineer on leave with no handoff; ticket marked Resolved after QA failed;
client chased 4 days with no reply. ~45 items across Jira, email, Slack, with
planted traps: mismatched identities across tools, mixed timestamp formats,
a 13-day Jira silence, a premature "Resolved" contradicting Slack, an
undocumented client call, ~30% noise. The answer key lives in the README only,
never in the app runtime.

### Realistic scattered-data scenario (`npm run realistic:gen`)
`scripts/gen-realistic.ts` emits `public/realistic/` (`+ manifest.json`): a
276-record four-tenant workspace (Bright Market / Lumen Ledger LUM-* as the
target engagement; Acme KST-*, Halcyon VEG-*, Vertex RAV-* as distractors,
~85% of records unrelated) where every answer is a cross-source fragment:
root cause only in a linked ticket's comment, premature "Resolved"
challenged in a Slack thread, leave in Slack + handoff only in an assignee
changelog, client chases inside the vendor's shared `general` room, the
promise in email, a canned-template twin pair and a distractor channel
named `vertex-billing` for vague-escalation pressure. Tests: fixture
roundtrip/trap checks in `tests/realistic.test.ts`, offline full-pipeline
UI coverage in `tests/ui/realistic.spec.ts` (fake LLM has a LUM branch).
Live verification protocol + answer key: README.

### Multi-issue scenario (synthetic, G-23)
`public/multi/` (manifest + Jira JSON + mbox + Slack folder) is a compact
Contoso / Orbit case with **two independent issues**: blank VAT invoice totals
after 2.1.0 and finance SSO failing after the identity migration. Each has its
own root cause ticket, promise, owner and fix version; the shared `general`
room holds the client chases. The start page's **Load multi-issue scenario**
button runs it end to end (`origin=demo`, labelled synthetic). The plan must
split exactly those two issues; the progress page pauses for the editable
review; the report exposes `?issue=<id>` and an `?issue=all` combined view;
drafts are per issue. A one-incident escalation (Northwind) must stay one issue
— the analyst prompt explicitly treats a failed fix, a premature closure,
unanswered chases and an SLA consequence as facets, not separate issues.
Tests: `tests/ui/multi-issue.spec.ts` (fake LLM two-issue branch).

### Tech stack
Next.js (App Router) on Vercel; tool-use LLM API with the model name in an env
var — this build runs DeepSeek through its OpenAI-compatible endpoint
(`DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL`, no vendor SDK); Postgres for the registry
(Docker locally, hosted `DATABASE_URL` on Vercel); two-layer verifier (deterministic quote + author/time checks, then an isolated model support call; three states).
Constraints: Vercel function timeouts (one API route per stage, stream progress,
keep the dataset under a few hundred items); credentials only in env vars,
read-only scopes, sandbox workspaces only.

### Non-negotiable rules
- No hardcoded outputs. Everything shown is produced live from retrieved items.
- Every claim shown links to a stored source item and a verified quote.
- Never invent content for events with no record; list them under gaps.
- Must also work on judge-supplied exports through the upload fallback.
- Label synthetic data as synthetic and any cached fallback run as cached.
- Report coverage honestly: which sources and queries were actually searched.

### Optional, only if time remains
Draft client reply grounded only in verified claims; time scrubber.

## Commands
- `npm run db:up` then `npm run db:migrate` — required before anything that touches Postgres (local docker postgres:16, anduin/anduin/anduin on 5432). Migrations are `migrations/*.sql`, applied by `lib/db/migrate.ts` (idempotent, tracked in `schema_migrations`).
- `npx vitest run` — full suite. DB-backed suites skip cleanly when `DATABASE_URL` is unset; with it set, Postgres must be up and migrated or they fail.
- `npm run test:ui` — Playwright UI tests (`tests/ui/**`) against the real built app on port 3100; run `npm run build` first. A deterministic fake OpenAI-compatible LLM (`tests/ui/fake-llm.ts`, started by globalSetup on 9401) serves every agent call, so the full pipeline runs free and offline; seeds hit the content-hash cache across runs, so specs must tolerate both fresh (201) and cached (200) states.
- `npm run lint`, `npm run typecheck`, `npm run build` — build must stay green; Next requires `export const maxDuration = 60` as a LITERAL in every route (an imported constant breaks the build).
- `npm run demo:gen` — regenerates the synthetic exports into `public/demo/` (+ `manifest.json`). Deterministic; re-run after editing `scripts/gen-demo.ts`.
- `npm run realistic:gen` — regenerates the four-tenant scattered-data workspace into `public/realistic/` (+ `manifest.json`). Deterministic; re-run after editing `scripts/gen-realistic.ts`.
- `npm run real:smoke [demo|realistic|vague|all]` — drives a RUNNING app (`npm run start` on :3000 with REAL LLM credentials) through the browser: demo start-page flow, realistic four-tenant zip upload, and a vague escalation; prints stage timings, saves screenshots to `test-results/real/`, fails on any error state. Costs real tokens; not part of the offline suite.
- `npm run dev` — local app. `.env.local` (never committed) supplies `DATABASE_URL`, `DEEPSEEK_*`, and the optional live-source credentials (`JIRA_*`, `SLACK_TOKEN`, `GMAIL_*`); `lib/db/env.ts` loads it for scripts and tests.

## Layout & wiring
- `lib/ingest/*` parsers + `detect.ts` (file-kind sniffing, zip expansion) + `normalize.ts` (`toUtcIso` at the ingest boundary, `eventId`, `capText`) + `identity.ts` (deterministic email/name merges; LLM suggestions applied only at confidence ≥ 0.9 AND with a signal overlap, otherwise recorded `applied:false`; suggestions are chained and can never strip an email address out of a canonical — the address is what links people across tools) + `run.ts` (shared ingest flow used by both uploads and live pulls).
- `lib/sources/*`: the Source implementations — `jira.ts`, `slack.ts`, `gmail.ts` (live, read-only), with the upload path as the export fallback.
- `lib/agents/*`: `tools.ts` (per-source tools + registry tools + `submit_claim`; searches match text, channel, actor and ticket refs, and results are relevance-ordered via `ranking.ts` — cited refs > literal phrase > tokens, recency tiebreak — before the cap), `analyst.ts`, `investigator.ts` (three kinds: root_cause | commitments | ownership), `skeptic.ts` (advisory — degrades to zero findings on LLM failure, never blocks the pipeline), `summary.ts`.
- `lib/pipeline/*`: `scope.ts` (anchor-based client/project resolution: declared client, escalation evidence, model proposals, all registry-verified; >2 convergent anchors = scoped, 1-2 = partial with disclosure, 0 = unscoped), `plan.ts` (structured plan parsing/rendering + relative date-window heuristic), `issues.ts` (G-23 issue prompt block + issue-id resolution/fallback), `vocabulary.ts` (deterministic vocabulary digest), `verify-claims.ts` (two-layer verifier: quote + author/time in `attribution.ts`, isolated model support check in `entailment.ts`; writes the three states), `coverage.ts` (which sources/queries were actually searched), `assemble.ts` (`buildResult` is side-effect free and returns the case's `issues`; `assemble` adds the stage log; `needsRetry` = a question group has zero visible (verified or supported) claims and only one retry pass remains).
- `app/api/investigations/**`: one route per stage (`plan`, `investigate`, `skeptic`, `verify`, `assemble`, `status`, `result`) + the multipart ingest route + `issues` (GET/PUT the confirmed issue split before investigation) + `reply` (per-issue drafts); `app/api/sources/**` serves configuration/targets and live pulls. `lib/api/pipeline.ts` holds `runStage`/`readInvestigationOrDefault` (400 malformed uuid, 404 unknown).
- `lib/orchestrator.ts` is the CLIENT-side sequencer (plan → optional issue review → 3 investigators in parallel → skeptic → verify → assemble, then one retry for only the missing kinds). Stage progress is client-driven; `/api/investigations/[id]/events` streams stage/log changes over SSE for the progress screen. A multi-issue run pauses after plan (`paused`) and resumes with `startAt: "investigate"`; the worker id is kept in sessionStorage so the paused lease is reused.
- `lib/report/build.ts` + `lib/report/briefing.ts` + `lib/agents/reply.ts`: the report layer. Every metric, silence, ownership lane, audit row and trust split is computed in CODE from events/claims/notes (`buildReportView`); `buildBriefing` deterministically builds the story structure (chapters cut at silences, importance weighting, lane assignment, key moments, person palette) over verified claims only. The only model text is the verdict + client reply, which is restricted to verified, unflagged claims and validated sentence-by-sentence against known claim ids before storage (`report_extras` for legacy/single-issue; `issue_report_extras` for per-issue G-23 drafts). The page selects an issue with `?issue=<id>` (or `?issue=all` for the combined view); per-issue claims/events/gaps drive the briefing, ledger, causes and reply, while coverage/scope stay case-level.
- UI (plain CSS in `app/globals.css`, tokens at the top; fonts via next/font — Atkinson Hyperlegible for UI, Source Serif 4 for evidence): `app/page.tsx` (start: escalation + source scopes + Northwind and multi-issue synthetic scenarios), `app/upload/page.tsx` (exports fallback), `app/investigations/[id]/progress/page.tsx` (summary-first counts, stages, activity behind a "Show activity" toggle; the pre-run editable issue review; also the read-only "How this was produced" review), `app/investigations/[id]/page.tsx` (report: one scrolling briefing via `app/_components/briefing/*` — story + key moments + metrics, swimlane board, chapters, promises, causes, gaps, draft reply; issue tabs + case overview for multi-issue runs; shared evidence drawer in `app/_components/evidence.tsx`). No Tailwind — do not reintroduce preset-style classes; use the existing CSS classes.

## Testing quirks
- **Prefer end-to-end tests for features.** A feature is not done until a test exercises it through its real interface — the HTTP route handler against a migrated Postgres with the real parsers/store (mocked LLM or mocked external sources only), asserting the observable outcome. Unit tests are for pure logic (verifier, metrics builders, parsers). When adding a feature, extend the e2e suite first; see `tests/routes.test.ts`, `tests/sources-route.test.ts` and `tests/ingest-route.test.ts` for the pattern.
- Never call the real LLM in tests: inject a fake via `setLlmClientForTests` (lib/llm.ts) or mock global `fetch`. `tests/demo-roundtrip.test.ts` proves the generated exports parse through the real parsers.
- Never call real Jira/Slack/Gmail in tests: adapters take an injected `fetchImpl`/`env` (`tests/sources.test.ts`); route tests swap the registry via `setSourcesForTests`.
- G-23 UI coverage: `tests/ui/multi-issue.spec.ts` drives the upload page through plan → editable issue review → confirm → per-issue report/all-issues view with the fake LLM's two-issue branch. The unit coverage lives in `tests/plan-data.test.ts` (issue cap/normalization) and `tests/orchestrator.test.ts` (pause, confirmed continuation, `startAt: "investigate"`). The real-LLM check is the start page's **Load multi-issue scenario** flow (plan must split exactly two; Northwind must stay one); it is a manual smoke, not part of the offline suite.
- Test outputs must be pristine (no lint warnings) — unused vars fail the gate even as warnings.
- Email sender actors keep the address (`Name <addr>`) on purpose: it is what lets identity resolution link email senders to Jira/Slack people.
