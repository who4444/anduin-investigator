# AGENTS.md

## Project
Anduin Investigator: ingests a project's scattered history (Jira JSON, email .mbox/.eml, Slack export), builds one unified event store, and produces a source-backed timeline, commitments ledger, and gaps list so a manager can answer a client escalation in minutes.

## Commands
- `npm run db:up` then `npm run db:migrate` — required before anything that touches Postgres (local docker postgres:16, anduin/anduin/anduin on 5432). Migrations are `migrations/*.sql`, applied by `lib/db/migrate.ts` (idempotent, tracked in `schema_migrations`).
- `npx vitest run` — full suite. DB-backed suites skip cleanly when `DATABASE_URL` is unset; with it set, Postgres must be up and migrated or they fail.
- `npm run lint`, `npm run typecheck`, `npm run build` — build must stay green; Next requires `export const maxDuration = 60` as a LITERAL in every route (an imported constant breaks the build).
- `npm run demo:gen` — regenerates the synthetic exports into `public/demo/` (+ `manifest.json`). Deterministic; re-run after editing `scripts/gen-demo.ts`.
- `npm run dev` — local app. `.env.local` (never committed) supplies `DATABASE_URL` and `DEEPSEEK_API_KEY`/`DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL`; `lib/db/env.ts` loads it for scripts and tests.

## Non-negotiables (enforced in code, not by prompt)
- No hardcoded outputs: everything shown comes live from the uploaded files. The demo answer key lives in README only — never import it or restate findings in runtime code.
- Every claim links an `event_id` + an exact quote; verification is deterministic code (`lib/verify.ts`, whitespace-normalized verbatim substring), never a model.
- Failed verification → claim flagged and excluded from timeline/ledger (it stays visible only as explicitly failed).
- Never invent content for events with no record → gaps panel. Parsers never throw on malformed exports; they yield fewer events and push a warning.
- Must work on judge-supplied exports, not just the built-in scenario. Label synthetic data synthetic and cached runs cached.

## Layout & wiring
- `lib/ingest/*` parsers + `detect.ts` (file-kind sniffing, zip expansion) + `normalize.ts` (`toUtcIso` at the ingest boundary, `eventId`, `capText`) + `identity.ts` (deterministic email/name merges; LLM suggestions applied only at confidence ≥ 0.9 AND with a signal overlap, otherwise recorded `applied:false`).
- `lib/agents/*`: `tools.ts` (event-store tools + `submit_claim`), `analyst.ts`, `investigator.ts` (three kinds: root_cause | commitments | ownership), `skeptic.ts` (advisory — degrades to zero findings on LLM failure, never blocks the pipeline), `summary.ts`.
- `lib/pipeline/*`: `verify-claims.ts` (code verifier), `assemble.ts` (`buildResult` is side-effect free; `assemble` adds the stage log; `needsRetry` = a question group has zero verified claims and pass < 3).
- `app/api/investigations/**`: one route per stage (`plan`, `investigate`, `skeptic`, `verify`, `assemble`, `status`, `result`) + the multipart ingest route. `lib/api/pipeline.ts` holds `runStage`/`readInvestigationOrDefault` (400 malformed uuid, 404 unknown).
- `lib/orchestrator.ts` is the CLIENT-side sequencer (plan → 3 investigators in parallel → skeptic → verify → assemble, then retry only the missing kinds). Stage progress is client-driven; there is no server-side poller.
- UI: `app/page.tsx` (upload + live progress, optional escalation textarea, built-in demo loader) and `app/investigations/[id]/page.tsx` (timeline + drawer with highlighted quotes, commitments table, gaps panel, stats).

## Testing quirks
- Never call the real LLM in tests: inject a fake via `setLlmClientForTests` (lib/llm.ts) or mock global `fetch`. `tests/demo-roundtrip.test.ts` proves the generated exports parse through the real parsers.
- Test outputs must be pristine (no lint warnings) — unused vars fail the gate even as warnings.
- Email sender actors keep the address (`Name <addr>`) on purpose: it is what lets identity resolution link email senders to Jira/Slack people.
