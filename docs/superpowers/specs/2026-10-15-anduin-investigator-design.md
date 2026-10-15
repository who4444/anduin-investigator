# Anduin Investigator — Design

Date: 2026-10-15
Status: approved by product owner (spec provided + decisions in chat); build authorized.

## Intent and why

A client escalates a problem, and the team pieces together what happened from
tickets, emails, and chat — which takes days while the client waits. Anduin
Investigator takes a project's scattered history and produces a clear, ordered,
source-backed account of what happened, so a manager can answer an escalation
in minutes instead of days.

Primary user: a manager (account manager / support lead / eng manager) who must
answer an upset client now. Success metric: time to a trustworthy answer.

## What the output must answer

1. Who did what
2. When (ordered timeline across all sources)
3. What was promised (commitments ledger: who, to whom, deadline, status kept / broken / unclear)
4. What went wrong (root cause AND process failures: missed handoffs, unannounced releases, unanswered messages)
5. What we could not determine (explicit "gaps" list; never guess)

## Goals / non-goals / anti-goals

- In scope ("layer 1"): consolidate multiple sources into one organized view, then generate the step-by-step picture.
- Out of scope: continuous sync, real-time ingestion, multi-project management, auth, client-safe vs internal views.
- Optional only if time remains: live Jira/Slack sandbox pull behind a Source interface; client-reply draft grounded only in verified claims; time scrubber.
- Anti-goals: hardcoded demo outputs; invented content for events with no record; model-judged "verification".

## Architecture: agents retrieve, code verifies

Agents do the retrieval. They call source tools to find and read items. The tool
layer, not the agent, is the system of record: every item a source tool returns
is normalized and saved to the Evidence Registry automatically, with source,
item ID, UTC timestamp, author, full raw text and URL. Agents cite an item ID
plus an exact quote. A deterministic verifier checks that quote against the
stored raw text. Trust never depends on what an agent claims it saw.
(In code the registry rows are the `events` table / `Event` type; "item" is the
user-facing name for the same thing.)

## Non-negotiable rules

- No hardcoded outputs. Everything shown is produced live from the input files. The demo answer key lives in README only, never in app runtime.
- Every claim shown to the user links to a source event and a verified exact quote.
- Verification is deterministic CODE (whitespace-normalized verbatim substring check against the cited event), never a model.
- Failed verification → flag the claim, exclude it from the timeline.
- Never invent content for events with no record; list unknowns in the gaps panel.
- Must work on judge-supplied exports, not just the built-in scenario.
- Label synthetic data as synthetic. Label any cached fallback run as cached.
- Report coverage honestly: which sources and queries were actually searched.

## Pipeline

1. Ingest: parse uploaded exports (Jira JSON, email .mbox/.eml, Slack export) into a unified event store.
   - Normalize timestamps: Jira UTC, email offsets, Slack unix epoch → UTC ISO.
   - Resolve identities across tools (alias map + LLM-suggested merges) and link cross-source references (e.g. an email mentioning SUP-2231).
2. Issue Analyst: reads the escalation, writes a short investigation plan.
3. Investigators run in PARALLEL, split by QUESTION not by person. Each reads the whole event store:
   - Root cause: what went wrong technically, when it first appeared, failed fixes
   - Commitments: promises and whether they were kept
   - Decisions & ownership: who decided/owned what, handoffs, escalations
4. Skeptic (runs after the others): finds contradictions, unsupported claims, suspicious silences, unanswered questions, and sources or angles that were never searched. Feeds the "could not determine" list.
5. Verifier is CODE, not a model: every claim carries exact quote + event_id; verifier checks (whitespace-normalized) that the quote appears verbatim in that event. Failed claims are flagged and excluded from the timeline. If key questions remain unanswered, allow one retry pass (max 2 iterations total).
6. Assemble: timeline, commitments ledger, gaps, and stats (claims verified/total).

## Schemas

Event: `{id, source, ts (UTC ISO), actor, channel, text, url}`

Claim (all agents): `{type, text (one sentence), actor, quote (exact substring), event_id, ts, status (kept|broken|unclear|n/a), confidence}`

Source tools (agents call these): `search_jira(jql_or_text)`, `get_issue(key)`,
`search_slack(query, channel?, date range?)`, `get_slack_thread(channel, ts)`,
`search_email(query, from?, date range?)`, `get_email_thread(id)`.
Registry tools: `verify_quote(item_id, quote)`, `submit_claim(...)`.
Each source tool sits behind the Source interface (live + export-upload fallback).

## UI (three screens)

1. Upload + live progress: each pipeline stage ticks through; tool-call log visible.
2. Timeline: chronological, filterable by person/channel/commitment; clicking an entry shows the original message with the cited quote highlighted.
3. Commitments + gaps: promised-vs-delivered table; "what we couldn't determine" panel; verification stats.

## Demo scenario (synthetic, labeled as such in the app)

Northwind Logistics vs Meridian Billing: invoice totals wrong after a timezone
change in release 4.12. Fix promised for Sep 24 release, never shipped; engineer
on leave with no handoff; ticket marked Resolved after QA failed; client chased
for 4 days with no reply. ~45 events across Jira, email, Slack, with planted
traps the pipeline must handle: mismatched identities, mixed timestamp formats,
a 13-day Jira silence, a premature "Resolved" contradicting Slack, an
undocumented client call, ~30% noise. The answer key is kept OUT of app
runtime (README only). Demo exports ship as real files in `demo/` (Jira JSON,
.mbox/.eml, Slack export) generated by a script labeled synthetic.

## Tech decisions

Product owner's calls:
- App runtime LLM: DeepSeek API via its OpenAI-compatible endpoint with tool calling (product owner supplies a DeepSeek API key, not Anthropic). Client is env-configurable: `DEEPSEEK_API_KEY` (key only in env vars), `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`), `DEEPSEEK_MODEL` (default `deepseek-chat`). Keep the LLM client behind a thin provider interface so an Anthropic adapter could be added later.
- Store: Postgres for events/claims (product owner chose Postgres over in-memory). Local dev via Docker Compose; deployed demo runs on a hosted Postgres via `DATABASE_URL` in env.
- Demo target: DEPLOYED to Vercel (not local). Design within Hobby-plan limits: ≤60s maxDuration per stage function, uploads capped ≤ ~4MB (event text truncated defensively at ingest), progress via polling, not long-lived streams.
- Judge exports: assume canonical shapes (Jira cloud search/issue JSON incl. changelog; standard mbox + raw .eml with HTML bodies; unzipped Slack export folder) with tolerant, graceful-degrading parsing.
- Escalation input: optional textarea on screen 1; if empty, the Issue Analyst infers the problem from the records.
- Identity resolution: auto-merge on strong signals only (same email, exact name match); weaker LLM suggestions stay separate, are noted in the gaps/identity panel; all merges visible in the UI.

Builder's calls (settled, veto-able):
- Next.js (App Router, TypeScript) on Vercel; npm as package manager; Tailwind CSS v4 for styling; no component library (hand-rolled, keep deps light).
- Vitest for unit tests (ingestion parsing, timestamp normalization, identity resolution, whitespace-normalized verifier).
- Single Next.js app at repo root; `docker-compose.yml` for local Postgres; schema via plain SQL migration applied by a small migrate script.
- Pipeline stages run as separate server calls (Vercel function timeout constraint): ingest → plan → (3 investigators in parallel) → skeptic → verify+assemble, with the client polling stage status.
- Dataset cap: keep to a few hundred events per investigation.
- Budget per investigation: target ≤ ~5 minutes wall clock; investigators capped at ~8 tool-call rounds each; stage functions sized to finish inside 60s.
- Retry policy: after skeptic+verify, assemble DETERMINISTICALLY checks whether any core question (root cause / commitments / decisions-ownership) has zero kept claims; if so, re-run only the deficient investigators once with the queries already tried. ONE retry pass (max 2 iterations total), then finish with the gaps listed.
- Coverage: the tool layer records which sources were available (items in the registry), which were actually searched, and the queries run (from investigator tool calls). Assemble exposes coverage; the skeptic receives the never-searched list; the results UI shows it. Never claim a source was searched when it was not.
- Skeptic semantics: the skeptic emits issue records — it may flag another agent's claim (claim stays visible, marked "flagged") and/or write a gaps entry. Verification failure remains the only reason a claim is fully excluded from the timeline. `status` applies to commitments (kept/broken/unclear/n/a); `confidence` is 0–1 from the claiming agent, displayed as High/Med/Low.
- Timeline composition: ALL ingested events form the chronological timeline (filterable by person/channel/source); claims annotate it and the commitments ledger is separate. Noise events stay visible so nothing is hidden.
- Cached fallback: each completed run is cached in Postgres keyed by upload content hash; re-uploading identical files offers the cached result, clearly labeled "cached". No canned/hardcoded answers ever.
- Coding subagents in this repo are configured (`.opencode/agents/`) to run on `opencode-go/deepseek-v4.1-flash`.

## Constraints recap

- Vercel function timeouts: split stages into separate calls, stream progress.
- Model name from an env var; API key in env vars only.
- Postgres or in-memory for MVP events/claims (owner chose Postgres).
