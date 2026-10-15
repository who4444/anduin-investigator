# Anduin Investigator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Web app that ingests Jira/email/Slack exports into one Postgres event store, runs parallel LLM investigators + skeptic (DeepSeek, OpenAI-compatible endpoint), verifies every claim's quote in deterministic code, and renders timeline + commitments ledger + gaps.

**Architecture:** Next.js App Router (TS) at repo root. The client orchestrates the pipeline stage-by-stage through API routes (one stage per request, each <60s for Vercel Hobby); Postgres holds events/claims/stages; a hand-rolled OpenAI-compatible fetch client with a tool-call loop drives agents; deterministic verifier code gates the timeline.

**Tech Stack:** Next.js 15, TypeScript, Tailwind CSS v4, postgres.js, postal-mime, fflate, Vitest. LLM: DeepSeek via `DEEPSEEK_BASE_URL`/`DEEPSEEK_MODEL`/`DEEPSEEK_API_KEY` env vars.

**Spec:** `docs/superpowers/specs/2026-10-15-anduin-investigator-design.md` (read it; it argues the decisions)

## Global Constraints (apply to every task)

- No hardcoded outputs: runtime must never embed demo answers, event ids, quotes, or expected findings. Demo answer key lives in README only.
- Every shown claim links `event_id` + exact `quote`; verification is deterministic code: whitespace-normalized verbatim substring check. Failed → flag + exclude from timeline.
- Never invent content for events with no record → gaps panel. Label synthetic data synthetic; label cached fallback runs cached.
- Secrets only in env vars; never commit `.env.local` or keys. Never `git add` `.env.local`.
- TDD per task: failing test → pass → commit. Tests never call the real LLM (mock `fetch`); Postgres integration tests skip when `DATABASE_URL` is unset.
- Commands: `npm run lint`, `npm run typecheck` (add if scaffold lacks it), `npx vitest run` — all must pass before a task is committed.
- Commits: Conventional Commits (`feat:`, `test:`, `chore:`), one commit per task (may be several small commits).

## Review Focus

1. Malformed/partial judge exports (missing fields, empty arrays, unknown keys, non-UTF8) → parsers degrade to zero events for that file, never throw. Pinned by malformed-fixture tests in Tasks 5–7, 9.
2. Mixed timestamp formats (Jira UTC ISO, email +08:00/−05:00 offsets, Slack epoch seconds with fraction) → all normalize to UTC ISO. Pinned in Tasks 4–7.
3. Quote near-misses (line wrapping, double spaces, tabs) → verifier normalizes and keeps; case/character substitutions → excluded. Pinned in Task 3.
4. Silences & unanswered questions (13-day Jira gap; 4-day unanswered client chase) → skeptic `silence` notes + gaps entries, not invented events. Pinned in Tasks 11–12.
5. Missing `DEEPSEEK_API_KEY` or API failure mid-pipeline → earlier stages' verified results still render, failed stage shows error + retry affordance; repeat upload offers cached run labeled cached. Pinned in Tasks 9, 14.
6. Cross-source references (email mentioning `SUP-2231`) → extracted into `meta.refs` and surfaced on the event. Pinned in Task 8.

## File map

- `lib/types.ts` — shared TS types (Event, Claim, Stage, etc.)
- `lib/db/pool.ts`, `lib/db/migrate.ts`, `migrations/001_init.sql` — Postgres access
- `lib/store.ts` — all DB reads/writes (investigations, events, claims, skeptic_notes, gaps, stage_runs, identity_resolutions)
- `lib/verify.ts` — `normalizeWhitespace`, `verifyQuote`
- `lib/ingest/{detect,jira,email,slack,normalize,refs,identity}.ts` — parsing/normalization/resolution
- `lib/llm.ts` — OpenAI-compatible client + `runToolLoop`
- `lib/agents/{tools,analyst,investigator,skeptic}.ts`
- `lib/pipeline/{verify-claims,assemble}.ts`
- `app/api/investigations/route.ts` (POST create+ingest), `app/api/investigations/[id]/{plan,investigate,skeptic,verify,assemble,status,result}/route.ts`
- `lib/orchestrator.ts` — client-side stage sequencer (+ `useInvestigation` hook)
- `app/page.tsx` (screen 1), `app/investigations/[id]/page.tsx` (screens 2+3), components in `app/_components/`
- `scripts/gen-demo.ts` → writes real export files into `public/demo/`
- `docker-compose.yml`, `.env.example`, `vercel.json`, `README.md`

---

### Task 1: Scaffold

**Files:** Create: Next.js app at repo root (`app/`, `package.json`, `tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `app/globals.css` with Tailwind v4 `@import "tailwind"`), `vitest.config.ts`, `docker-compose.yml`, `.env.example`, `.gitignore` (add `.env.local`), `app/layout.tsx`, `app/page.tsx` (placeholder heading), `app/api/health/route.ts` returning `{ok:true}`.

- [ ] Scaffold via `npx create-next-app@latest . --ts --tailwind --eslint --app --no-src-dir --import-alias "@/*" --use-npm` in the existing (non-empty but no-conflict) dir; then `npm i postgres postal-mime fflate` and `npm i -D vitest`
- [ ] Add scripts: `typecheck: tsc --noEmit`, `db:migrate: tsx lib/db/migrate.ts` (add `tsx` dev dep), `db:up: docker compose up -d`, `demo:gen: tsx scripts/gen-demo.ts`
- [ ] `docker-compose.yml`: `postgres:16-alpine`, port 5432, `POSTGRES_USER=anduin POSTGRES_PASSWORD=anduin POSTGRES_DB=anduin`, volume
- [ ] `.env.example`: `DATABASE_URL=postgres://anduin:anduin@localhost:5432/anduin`, `DEEPSEEK_API_KEY=`, `DEEPSEEK_BASE_URL=https://api.deepseek.com`, `DEEPSEEK_MODEL=deepseek-chat`
- [ ] `vitest.config.ts`: node environment, `include: ["tests/**/*.test.ts"]`
- [ ] Write `tests/smoke.test.ts`: asserts `1+1===2` placeholder — no, real test: `GET /api/health` handler returns `{ok:true}` (import handler directly, unit-level)
- [ ] Verify: `npm run lint && npm run typecheck && npx vitest run` green; `docker compose up -d && pg_isready` OK
- [ ] Commit `chore: scaffold next app, postgres compose, vitest`

### Task 2: Types + migration + store

**Files:** Create: `lib/types.ts`, `migrations/001_init.sql`, `lib/db/pool.ts`, `lib/db/migrate.ts` (reads migrations/*.sql, creates `schema_migrations`, applies unapplied, idempotent), `lib/store.ts`, `tests/store.test.ts`.

**Interfaces (produced, used by all later tasks):**

```ts
type SourceKind = "jira" | "email" | "slack";
type StageName = "ingest" | "plan" | "root_cause" | "commitments" | "ownership" | "skeptic" | "verify" | "assemble";
interface EventInput { source: SourceKind; ts: string; actor: string; channel: string; text: string; url?: string; threadId?: string; refs?: string[]; meta?: Record<string, unknown>; }
interface Event extends EventInput { id: string; investigationId: string; actorResolved?: string | null }
interface ClaimInput { agent: string; type: string; text: string; actor?: string; quote: string; eventId: string; ts?: string; status: "kept" | "broken" | "unclear" | "n/a"; confidence: number }
interface Claim extends ClaimInput { id: string; investigationId: string; verifyStatus: "kept" | "excluded" | "unverified"; verifyError?: string | null; skepticFlag: boolean }
// store.ts (all take explicit pool-independent ctx; investigationId: string uuid)
createInvestigation({ title, escalationText, contentHash }): Promise<string>
getInvestigation(id): Promise<Investigation | null>
findInvestigationByHash(hash): Promise<Investigation | null>
setPlan(id, plan: string): Promise<void>
insertEvents(invId, events: (EventInput & { id: string })[]): Promise<void>
getEvents(invId): Promise<Event[]>
getEvent(invId, eventId): Promise<Event | null>
insertClaims(invId, claims: ClaimInput[]): Promise<Claim[]>
getClaims(invId): Promise<Claim[]>
setClaimVerification(claimId, verifyStatus, verifyError?): Promise<void>
setClaimSkepticFlag(claimId, flag: boolean): Promise<void>
insertSkepticNotes(invId, notes: { claimId?: string; kind: "contradiction" | "unsupported" | "silence" | "unanswered"; text: string; eventIds: string[] }[]): Promise<void>
insertGaps(invId, gaps: { question: string; note: string; eventIds: string[] }[]): Promise<void>
upsertStage(invId, stage: StageName, pass: number, status: "pending" | "running" | "done" | "error", error?): Promise<void>
appendStageLog(invId, stage: StageName, pass: number, entry: unknown): Promise<void>
getStages(invId): Promise<Stage[]>
upsertIdentity(invId, { alias, canonical, method, confidence, applied }): Promise<void>
getIdentities(invId): Promise<IdentityResolution[]>
```

- [ ] Write `tests/store.test.ts` (skips suite if `!process.env.DATABASE_URL`): create investigation → insert 2 events → read back equal (ts preserved as UTC ISO) → insert claim → verifyStatus update → stage upsert/append → identity upsert. Also test `findInvestigationByHash` returns same id.
- [ ] Run `npx vitest run tests/store.test.ts` → FAIL (no module). Implement types + SQL + store. `docker compose up -d && npm run db:migrate`. Run again → PASS. Also: unique event id per (investigation, id) — second insert of same id must throw.
- [ ] Verify: `npm run lint && npm run typecheck && npx vitest run` green. Commit `feat: event store schema and access layer`

### Task 3: Verifier (pure code)

**Files:** Create: `lib/verify.ts`, `tests/verify.test.ts`.

**Interfaces:** `normalizeWhitespace(s: string): string` (collapse any `/\s+/` to single space, trim; no case folding); `verifyQuote(eventText: string, quote: string): { ok: boolean; error?: string }` (error `"quote_not_found"`).

- [ ] Failing tests: exact substring ok; multi-line event vs single-line quote ok (newline collapsed); double-space quote ok; leading/trailing whitespace ok; wrong word → not ok; changed case → not ok; empty quote → not ok; curly vs straight quote → not ok.
- [ ] Run → FAIL. Implement. Run → PASS. Lint/typecheck. Commit `feat: whitespace-normalized quote verifier`

### Task 4: Ingest foundations — ids, timestamps, refs, text cap

**Files:** Create: `lib/ingest/normalize.ts`, `lib/ingest/refs.ts`, `tests/ingest-normalize.test.ts`, `tests/refs.test.ts`.

**Interfaces:**

```ts
eventId(source: SourceKind, ts: string, actor: string, channel: string, text: string): string // `e_` + sha1(...).slice(0,16)
isoFromEpoch(sec: number | string): string          // Slack ts "1727136000.000100" → "2024-09-24T00:00:00.000Z" (fraction = fractional SECONDS, parse the whole value as a float; ms precision)
capText(s: string, max = 4000): string               // appends "…[truncated]"
dedupeEvents(events: EventInput[]): EventInput[]     // identical (source,ts,actor,channel,text) collapse
extractTicketRefs(text: string): string[]            // /\b[A-Z][A-Z0-9]{1,9}-\d+\b/, uppercase, deduped
```

- [ ] Tests: epoch fraction preserved in ms; negative-offset email ts handled by caller (parsers own source-specific parsing — here only epoch helper + id stability: same inputs → same id, different text → different id); capText truncates >4000 at word boundary-ish and marks; extractTicketRefs finds `SUP-2231`, `ABC-12`, ignores `sup-2231` lowercase? (NO — case-insensitive match but output uppercase) and ignores `FOO-` alone.
- [ ] Run → FAIL → implement → PASS. Commit `feat: ingest normalization helpers`

### Task 5: Jira parser

**Files:** Create: `lib/ingest/jira.ts`, `tests/jira.test.ts`, fixture `tests/fixtures/jira-search.json` (2 issues: MER-101 with comments + changelog status transitions created→inprogress→resolved; MER-102 minimal), `tests/fixtures/jira-single.json` (single issue object, no changelog).

**Interfaces:**

```ts
parseJira(data: unknown): { events: EventInput[]; issues: { key: string; summary: string }[] }
// events: issue_created (reporter), comment (author, body), status_changed (from→to in text, actor=changelog author), assignee_changed, resolution_set
// channel = issue key (e.g. "MER-101"); url = issue browse URL from self/key; ts from comment.created / changelog item.created / fields.created (already ISO, keep as-is)
```

- [ ] Tests: search-shaped JSON → expected event count + first event fields (actor, channel=MER-101, ts exact from fixture); single-issue shape parses; missing changelog → zero status events, no throw; comment body HTML stripped of `<p>` tags; empty `issues: []` → zero events, no throw; non-object input → zero events, no throw.
- [ ] FAIL → implement → PASS. Commit `feat: jira export parser`

### Task 6: Email parser

**Files:** Create: `lib/ingest/email.ts`, `tests/email.test.ts`, fixtures `tests/fixtures/sample.mbox` (3 messages: two from Northwind +0800 offset, one reply with `In-Reply-To` linking thread, one with HTML body and "re SUP-2231" in subject), `tests/fixtures/single.eml`.

**Interfaces:**

```ts
parseMbox(bytes: Uint8Array): { events: EventInput[]; threads: Map<string, string[]> } // mbox "From " separator split → postal-mime per message
parseEml(bytes: Uint8Array): { events: EventInput[]; threads: Map<string, string[]> }
// actor = From display name; channel = "email"; text = text body (prefer text/plain; else strip HTML tags + decode entities); url = null; ts = Date header → UTC ISO;
// threadId = base Message-ID normalized (strip <>) mapped through In-Reply-To/References chain; refs = extractTicketRefs(subject + body); meta keeps messageId
```

- [ ] Tests: 3-message mbox → 3 events, ts UTC-correct for +0800 (e.g. header `Date: Tue, 24 Sep 2024 09:30:00 +0800` → `2024-09-24T01:30:00.000Z`); thread: reply shares threadId with first message; HTML body → plain text without tags/entities; subject refs land in `refs` containing "SUP-2231"; single .eml parses; truncated/garbage bytes → zero events, no throw.
- [ ] FAIL → implement (postal-mime; hand-rolled mbox splitter on `^From ` lines only) → PASS. Commit `feat: email mbox/eml parser`

### Task 7: Slack parser

**Files:** Create: `lib/ingest/slack.ts`, `tests/slack.test.ts`, fixtures `tests/fixtures/slack-users.json` (`{ "U1": { "name": "linchen", "profile": { "real_name": "Lin Chen" } }, ... }`), `tests/fixtures/slack-channel.json` (array incl. message with `thread_ts` + replies, one bot message subtype, one with epoch string ts).

**Interfaces:**

```ts
parseSlackFiles(files: { name: string; json: unknown }[]): { events: EventInput[] }
// users.json → id→real_name||name map; channels.json → channel id→name (optional)
// per channel JSON (name pattern `<channel>/*.json` or any array of messages with numeric-ish ts):
//   actor = user map lookup else raw user id; channel = channel file name stem (e.g. "meridian-billing") or channels.json name;
//   ts = isoFromEpoch(msg.ts); text = msg.text; refs = extractTicketRefs(text); thread replies inherit parent thread_ts → threadId = `slack:${channel}:${thread_ts}`
// unknown shapes (users.json missing) → fall back to raw ids, no throw
```

- [ ] Tests: user id resolved to "Lin Chen"; epoch ts → exact ISO; thread reply gets threadId equal to parent's; missing users.json → raw id actor, no throw; non-array JSON → zero events; channel name from filename.
- [ ] FAIL → implement → PASS. Commit `feat: slack export parser`

### Task 8: LLM client + tool loop

**Files:** Create: `lib/llm.ts`, `tests/llm.test.ts`.

**Interfaces:**

```ts
interface LlmClient { chat(messages: ChatMessage[], opts?: { tools?: ToolSpec[]; temperature?: number; forceJson?: boolean }): Promise<LlmResponse> } // LlmResponse { content: string; toolCalls?: { id, name, args: Record<string,unknown> }[]; usage?: {...} }
createLlmClient(opts?: Partial<{ baseUrl: string; apiKey: string; model: string; timeoutMs: number }>): LlmClient // reads env; POST `${baseUrl}/chat/completions` (fetch, no SDK); `forceJson` sets response_format {type:"json_object"}; throws LlmError with status text on non-2xx
runToolLoop({ client, system, user, tools, exec: (name, args) => Promise<string>, maxRounds = 8 }): Promise<{ content: string; log: { round, name, args, resultPreview }[] }>
// loop: chat → if toolCalls: append assistant msg + tool results (role "tool"), repeat; else return content
setLlmClientForTests(client: LlmClient | null): void // route tests swap the default client
```

- [ ] Tests (mock global fetch): non-2xx → LlmError; forceJson sends response_format; tool loop: first response toolCalls, second plain → exec called with parsed args, log has 2 entries, final content returned; maxRounds hit → stops, returns last content; tool result role messages shaped per OpenAI spec (`tool_call_id`).
- [ ] FAIL → implement → PASS. Commit `feat: openai-compatible llm client and tool loop`

### Task 9: Cross-source refs + identity resolution

**Files:** Create: `lib/ingest/identity.ts`, `tests/identity.test.ts`. Modify: none. **Consumes:** `LlmClient` (Task 8), `extractTicketRefs` (Task 4).

**Interfaces:**

```ts
deterministicAliases(events: EventInput[]): Map<string, string>       // key raw actor → canonical: same email (actor "L. Chen <l.chen@nw.com>") → display name; normalized exact name match ("Lin Chen" vs "lin chen")
suggestLlmMerges(events: EventInput[], client: LlmClient): Promise<{ alias: string; canonical: string; confidence: number }[]> // one LLM call, JSON out; prompt lists aliases + up to 3 sample messages each
applyAliases(events: EventInput[], resolved: Map<string, string>, store: { upsertIdentity }): EventInput[] // sets actor to canonical, records each (applied true for deterministic + llm≥0.9 AND signal overlap, else applied false)
```

- [ ] Tests (mock client): deterministic email merge `"L. Chen <l.chen@northwind.com>"` + `"l.chen@northwind.com"` + `"Lin Chen"` → all "Lin Chen"; exact-name case-insensitive merge; LLM suggests ("L. Chen"→"Lin Chen", conf 0.95, overlapping) → applied, identity row method "llm"; LLM suggests conf 0.6 → NOT applied (actor unchanged), row applied=false; no email/name overlap → not applied.
- [ ] FAIL → implement → PASS. Commit `feat: identity resolution`

### Task 10: Ingest API route (upload → investigation)

**Files:** Create: `app/api/investigations/route.ts`, `lib/ingest/detect.ts`, `tests/ingest-route.test.ts`, `tests/detect.test.ts`.

**Interfaces:** `POST /api/investigations` multipart form: `files` (multiple; also accepts one `.zip` unpacked via fflate), `escalation` (optional string), `title` (optional). Detect per file: `.zip` → unzip → recurse; `.mbox`/`.eml` → email parser; `.json` → sniff: object with `issues` array or issue-shaped → jira; `users.json`/`channels.json` or array-of-messages-with-ts → slack; else ignore. Flow: classify → parse → dedupe → capText → ids → insert → `upsertStage(ingest,1,"done")` → respond `{ investigationId, eventCount, cached?: false, warnings: string[] }`. If `findInvestigationByHash(hash)` matches AND that investigation has a done `assemble` stage → respond `{ investigationId, cached: true }` (200, no duplicate work). `hash = sha1(sorted file names + bytes lengths + content)`. Route sets `export const maxDuration = 60`.

- [ ] `tests/detect.test.ts`: classification table (jira search json → jira; users.json → slack-users; messages array → slack; eml bytes → email).
- [ ] `tests/ingest-route.test.ts` (mock DB via test DATABASE_URL or in-memory postgres container? use real test DB, skip if unset): POST FormData with 1 jira json + 1 mbox → 201, eventCount > 0, stage ingest done; repeat POST same bytes → `cached: true` same id; empty body → 400 with message.
- [ ] FAIL → implement → PASS. Commit `feat: ingest upload route with zip support`

### Task 11: Agent tools + analyst + investigators

**Files:** Create: `lib/agents/tools.ts`, `lib/agents/analyst.ts`, `lib/agents/investigator.ts`, `tests/agent-tools.test.ts`, `tests/analyst.test.ts`, `tests/investigator.test.ts`.

**Interfaces:**

```ts
buildAgentTools(invId: string): { specs: ToolSpec[]; exec: (name: string, args: Record<string, unknown>) => Promise<string> }
// implements search_events(query, actor?, source?, from?, to?), get_event(id), get_thread(id), list_events(actor?, from?, to?), verify_quote(event_id, quote) [uses lib/verify], submit_claim(type, text, actor?, quote, event_id, ts?, status, confidence) → inserts via store, returns {claimId}
runAnalyst(invId: string, escalation: string): Promise<string> // returns plan (markdown, ≤300 words); LLM call with events summary (count per source, actors, date range, sample of 10 events); if escalation empty prompt says "infer the likely escalation from these records"
runInvestigator(invId: string, kind: "root_cause" | "commitments" | "ownership", plan: string): Promise<{ claims: Claim[]; log: unknown[] }> // tool loop maxRounds 8; prompt: cite exact quotes, submit via submit_claim, ONLY facts with record, unknown → say so in final JSON {claims:[], notes:[...]}; notes become gaps rows
```

- [ ] `tests/agent-tools.test.ts` (real test DB): search_events filters by actor+window; get_event returns full text; verify_quote wired to verifier returns ok/error; submit_claim persists.
- [ ] `tests/analyst.test.ts` (mock client returning fixed plan): returns content, log recorded to stage `plan`.
- [ ] `tests/investigator.test.ts` (mock client scripted: round1 search_events toolcall, round2 submit_claim toolcall, round3 final): claims persisted with agent=kind, gaps written from notes; maxRounds cap respected.
- [ ] FAIL → implement → PASS each file as built. Commit `feat: analyst and investigator agents with event-store tools`

### Task 12: Skeptic + verification + assemble (+ retry decision)

**Files:** Create: `lib/agents/skeptic.ts`, `lib/pipeline/verify-claims.ts`, `lib/pipeline/assemble.ts`, `tests/skeptic.test.ts`, `tests/assemble.test.ts`.

**Interfaces:**

```ts
runSkeptic(invId: string): Promise<{ flagged: number }> // reads all claims + tools access; emits skeptic_notes (kinds contradiction|unsupported|silence|unanswered); flags claims setClaimSkepticFlag; unanswered/silence notes ALSO inserted as gaps
runClaimVerification(invId: string): Promise<{ kept: number; excluded: number }> // for every claim: verifyQuote(events[event_id].text, quote) → setClaimVerification kept|excluded(+error); missing event_id → excluded "event_not_found"
assemble(invId: string): Promise<AssembledResult & { needsRetry: boolean; missing: string[] }>
// AssembledResult: { timeline: Event[] (ts asc, actorResolved coalesced), ledger: Claim[] (type commitment/decision etc.), gaps, stats: { total, kept, excluded }, identities, stages }
// needsRetry: any of ["root_cause","commitments","ownership"] has zero kept claims AND pass < 3
```

- [ ] `tests/skeptic.test.ts` (mock client): contradiction note references both claim ids; flagged claim gets skepticFlag=true; silence note lands in gaps.
- [ ] `tests/assemble.test.ts` (real test DB, seeded claims: 2 kept, 1 excluded, 1 unverified-then-verified): stats correct; ledger excludes verifyStatus "excluded"; needsRetry true when root_cause has no kept claims and pass=1; false when pass=3; timeline sorted asc.
- [ ] FAIL → implement → PASS. Commit `feat: skeptic, claim verification, assemble with retry decision`

### Task 13: Pipeline API routes

**Files:** Create: `app/api/investigations/[id]/plan/route.ts`, `.../investigate/route.ts` (body `{ kind, pass }`), `.../skeptic/route.ts`, `.../verify/route.ts`, `.../assemble/route.ts`, `.../status/route.ts` (GET: stages + errors, no LLM), `.../result/route.ts` (GET: AssembledResult). All `export const maxDuration = 60`.

- [ ] Each route: upsertStage(running) → call lib fn → upsertStage(done), errors → upsertStage(error, message) + HTTP 500 with `{ error }`. Status route returns all stages incl. log tails (last 20 entries each).
- [ ] `tests/routes.test.ts` (mock client injected via module-level setter `setLlmClientForTests`): investigate route persists claims and stage log; skeptic route flags; status returns stage list; 404 unknown id.
- [ ] FAIL → implement → PASS. Commit `feat: pipeline api routes`

### Task 14: Screen 1 — upload + progress

**Files:** Create: `lib/orchestrator.ts` (pure sequencer), `app/page.tsx`, `app/_components/UploadForm.tsx`, `app/_components/StageProgress.tsx`, `tests/orchestrator.test.ts`.

**Interfaces:** `runPipeline(invId, opts: { onStage: (name, pass, status, logTail?) => void }): Promise<"done" | { error: string }>` — sequence: plan → Promise.all([root_cause, commitments, ownership]) → skeptic → verify → assemble; if `needsRetry && missing` → re-run missing investigators (pass+1) → skeptic → verify → assemble; loops max 2 retry passes. Label logic: `"synthetic"` when files came from `/demo/*`; `"cached"` when route returned `cached:true`.

- [ ] `tests/orchestrator.test.ts` (mock fetch): happy path stage order recorded; investigator failure → error surfaced, earlier stages kept "done"; retry path runs only missing kinds then re-verifies.
- [ ] UI: dropzone + directory picker + textarea (optional, placeholder text) + "Load built-in demo exports" button (fetches `public/demo/*` list, builds File objects, marks synthetic) → POST → poll `status` every 2s while orchestrating → StageProgress checklist (✓/spinner/✗ + error + log tail accordion) → on done redirect to `/investigations/[id]`.
- [ ] Orchestrator tests FAIL → implement → PASS; lint/typecheck; `npm run dev` + manual check upload works against local Postgres (empty DB → friendly "run npm run db:migrate" message).
- [ ] Commit `feat: upload screen with live stage progress`

### Task 15: Screens 2+3 — timeline, ledger, gaps

**Files:** Create: `app/investigations/[id]/page.tsx`, `app/_components/Timeline.tsx`, `app/_components/EventDrawer.tsx`, `app/_components/CommitmentsTable.tsx`, `app/_components/GapsPanel.tsx`, `app/_components/StatsBar.tsx`.

**Interfaces:** page fetches `/result`; components props = slices of AssembledResult. Timeline: rows `[ts, actor, channel, text(≤120 chars), source badge]`, filters: actor (select), channel/source (select), commitments toggle (filters to events cited by kept claims). Row click → EventDrawer: full original text with claimed quotes `<mark>`-highlighted (whitespace-normalized highlight via normalizeWhitespace alignment on the ORIGINAL text) + claim cards (text, status badge kept/broken/unclear, confidence High/Med/Low, skeptic flag ⚠, verify excluded → red "failed verification — excluded"). CommitmentsTable: who / to whom (actor pair from claim text) / what / deadline (ts or "—") / status / source link. GapsPanel: question + note + linked event chips. StatsBar: `kept/total verified`, excluded count, synthetic/cached labels shown when flagged in investigation meta.

- [ ] Manual verify against demo data; quote highlight appears for a kept claim; excluded claim shows red badge and no mark highlight. No test framework for these (UI thin layer over tested lib); rely on lint/typecheck + manual smoke. (Component tests optional if time — skip.)
- [ ] Commit `feat: timeline, commitments ledger, gaps screens`

### Task 16: Demo data + README + deploy config + smoke

**Files:** Create: `scripts/gen-demo.ts`, `public/demo/*` (generated), `vercel.json`, README sections. `npm run demo:gen` must regenerate deterministically.

**Demo scenario facts (from spec — author these):** Northwind Logistics (client) vs Meridian Billing (vendor). Invoice totals wrong after a timezone-change bug in release 4.12 (Jira MER-87 introduced; deployed Sep 10). Fix promised for Sep 24 release — never shipped. Engineer Lin Chen on leave Sep 20–Oct 2 with no handoff (Slack OOO + no Jira activity). Ticket MER-101 marked Resolved Sep 26 while Slack QA discussion (Sep 25) says still failing. Client (Priya Nair) chased Sep 27–30 via email, no reply (emails have no responding event — plant silence). One email says "as discussed on our call" with NO call record anywhere (gap). ~45 events total: ~14 Jira (changelog 13-day silence Sep 10→23), ~14 emails (+0800 and −0500 offsets mixed, one mentions SUP-2231), ~17 Slack (`meridian-billing` + `general`, epoch ts, user ids resolved via users.json; identities planted: `l.chen@northwind.com`/"L. Chen"/"Lin Chen" same person; `Priya Nair`/"priya.n@northwind…"). ~30% noise: unrelated `random-ticket` churn, off-topic Slack chatter, marketing blast emails.
- [ ] Implement generator (plain ts script using the SAME parser fixtures format — files must parse with our parsers, prove by round-trip test `tests/demo-roundtrip.test.ts`: generate → parse → event counts ≈ 45 ± 5, no parser throws).
- [ ] README: overview, setup (docker compose up, npm i, db:migrate, .env.local from .env.example, dev), deploy to Vercel (hosted DATABASE_URL, env vars list), **Answer key section** (expected: root cause MER-87 timezone change in 4.12 shipped Sep 10; broken commitment "fix in Sep 24 release" — never shipped; process failures: no handoff for Lin Chen's leave, premature Resolved vs QA fail, unanswered Sep 27–30 chase; undocumented call gap; expected gaps list) — README only, never imported by app code.
- [ ] `vercel.json`: functions maxDuration 60 for `app/api/**`; note Hobby 4.5MB body limit in README (demo zip ~<1MB).
- [ ] Verify: `npm run lint && npm run typecheck && npx vitest run` green; `npm run demo:gen && npm run build` green; manual end-to-end: dev server → load demo → pipeline completes (requires DEEPSEEK_API_KEY set — if absent, verify stages error gracefully per Review Focus 5).
- [ ] Commit `feat: synthetic demo scenario, answer key README, vercel config`

---

## Execution

Executor: `coder` subagent (`.opencode/agents/coder.md`, model `opencode-go/deepseek-v4.1-flash`), one fresh dispatch per task, with the reviewer gate from superpowers:subagent-driven-development between tasks. Orchestrator (me) owns reviews, integration, and the final smoke test.
