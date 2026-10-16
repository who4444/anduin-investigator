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

### Pipeline
1. Escalation intake: the manager pastes the client's escalation message and
   selects the project sources (Jira project key, Slack channels, mailbox filter).
2. Issue Analyst: reads the escalation and writes an investigation plan that
   names which sources and search angles to try (keywords, ticket IDs, people,
   date ranges), so unsearched sources are visible.
3. Investigators run in PARALLEL, split by QUESTION, not by person. Each may
   search any source:
   - Root cause: what went wrong technically, when it first appeared, failed fixes
   - Commitments: promises made and whether they were kept
   - Decisions and ownership: who decided or owned what, handoffs, escalations
4. Evidence Registry: filled by the tool layer on every retrieval.
5. Skeptic (runs after the investigators): finds contradictions, claims with weak
   support, suspicious silences, unanswered questions, and sources or angles
   that were never searched. Feeds the "could not determine" list.
6. Verifier (CODE, not a model): for each claim, check that the whitespace-
   normalized quote appears verbatim in the cited item. Failures are flagged
   and excluded from the timeline. If key questions remain open, allow one
   retry pass (max 2 iterations total), then finish with the gaps listed.
7. Assemble: timeline, commitments ledger, gaps, and stats (claims verified/total).

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
  status (kept|broken|unclear|n/a), confidence }

### Demo scenario (synthetic, labeled as such in the app)
Northwind Logistics vs Meridian Billing: invoice totals wrong after a timezone
change in release 4.12. Fix promised for the Sep 24 release, never shipped;
engineer on leave with no handoff; ticket marked Resolved after QA failed;
client chased 4 days with no reply. ~45 items across Jira, email, Slack, with
planted traps: mismatched identities across tools, mixed timestamp formats,
a 13-day Jira silence, a premature "Resolved" contradicting Slack, an
undocumented client call, ~30% noise. The answer key lives in the README only,
never in the app runtime.

### Tech stack
Next.js (App Router) on Vercel; tool-use LLM API with the model name in an env
var — this build runs DeepSeek through its OpenAI-compatible endpoint
(`DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL`, no vendor SDK); Postgres for the registry
(Docker locally, hosted `DATABASE_URL` on Vercel); deterministic verifier.
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
- `npm run lint`, `npm run typecheck`, `npm run build` — build must stay green; Next requires `export const maxDuration = 60` as a LITERAL in every route (an imported constant breaks the build).
- `npm run demo:gen` — regenerates the synthetic exports into `public/demo/` (+ `manifest.json`). Deterministic; re-run after editing `scripts/gen-demo.ts`.
- `npm run dev` — local app. `.env.local` (never committed) supplies `DATABASE_URL`, `DEEPSEEK_*`, and the optional live-source credentials (`JIRA_*`, `SLACK_TOKEN`, `GMAIL_*`); `lib/db/env.ts` loads it for scripts and tests.

## Layout & wiring
- `lib/ingest/*` parsers + `detect.ts` (file-kind sniffing, zip expansion) + `normalize.ts` (`toUtcIso` at the ingest boundary, `eventId`, `capText`) + `identity.ts` (deterministic email/name merges; LLM suggestions applied only at confidence ≥ 0.9 AND with a signal overlap, otherwise recorded `applied:false`) + `run.ts` (shared ingest flow used by both uploads and live pulls).
- `lib/sources/*`: the Source implementations — `jira.ts`, `slack.ts`, `gmail.ts` (live, read-only), with the upload path as the export fallback.
- `lib/agents/*`: `tools.ts` (per-source tools + registry tools + `submit_claim`), `analyst.ts`, `investigator.ts` (three kinds: root_cause | commitments | ownership), `skeptic.ts` (advisory — degrades to zero findings on LLM failure, never blocks the pipeline), `summary.ts`.
- `lib/pipeline/*`: `verify-claims.ts` (code verifier), `coverage.ts` (which sources/queries were actually searched), `assemble.ts` (`buildResult` is side-effect free; `assemble` adds the stage log; `needsRetry` = a question group has zero verified claims and only one retry pass remains).
- `app/api/investigations/**`: one route per stage (`plan`, `investigate`, `skeptic`, `verify`, `assemble`, `status`, `result`) + the multipart ingest route; `app/api/sources/**` serves configuration/targets and live pulls. `lib/api/pipeline.ts` holds `runStage`/`readInvestigationOrDefault` (400 malformed uuid, 404 unknown).
- `lib/orchestrator.ts` is the CLIENT-side sequencer (plan → 3 investigators in parallel → skeptic → verify → assemble, then one retry for only the missing kinds). Stage progress is client-driven; `/api/investigations/[id]/events` streams stage/log changes over SSE for the progress screen.
- `lib/report/build.ts` + `lib/agents/reply.ts`: the report layer. Every metric, silence, ownership lane, audit row and trust split is computed in CODE from events/claims/notes (`buildReportView`); the only model text is the verdict + client reply, which is restricted to verified claims and validated sentence-by-sentence against known claim ids before storage (`report_extras` table). `migrations/002_report_extras.sql`.
- UI (plain CSS in `app/globals.css`, tokens at the top; fonts via next/font — Atkinson Hyperlegible for UI, Source Serif 4 for evidence): `app/page.tsx` (start: escalation + source scopes + synthetic scenario), `app/upload/page.tsx` (exports fallback), `app/investigations/[id]/progress/page.tsx` (stages, live activity log, coverage; also the read-only "How this was produced" review), `app/investigations/[id]/page.tsx` (report: header + six tabs via `app/_components/report-shell.tsx`, evidence drawer in `app/_components/evidence.tsx`). No Tailwind — do not reintroduce preset-style classes; use the existing CSS classes.

## Testing quirks
- Never call the real LLM in tests: inject a fake via `setLlmClientForTests` (lib/llm.ts) or mock global `fetch`. `tests/demo-roundtrip.test.ts` proves the generated exports parse through the real parsers.
- Never call real Jira/Slack/Gmail in tests: adapters take an injected `fetchImpl`/`env` (`tests/sources.test.ts`); route tests swap the registry via `setSourcesForTests`.
- Test outputs must be pristine (no lint warnings) — unused vars fail the gate even as warnings.
- Email sender actors keep the address (`Name <addr>`) on purpose: it is what lets identity resolution link email senders to Jira/Slack people.
