# AGENTS.md

## Project
Anduin Investigator: ingests a project's scattered history (Jira JSON, email .mbox/.eml, Slack export), builds one unified event store, and produces a source-backed timeline, commitments ledger, and gaps list so a manager can answer a client escalation in minutes instead of days.

Status: greenfield — not scaffolded yet. Once tooling exists, replace this note with exact build/test/lint commands and directory layout.

## Non-negotiables
- No hardcoded outputs: everything shown must come live from the input files. The demo answer key lives in README only, never in app runtime.
- Every claim shown links to an event_id and an exact quote; verification is deterministic code (whitespace-normalized verbatim substring check), never a model.
- Failed verification → flag the claim and exclude it from the timeline.
- Never invent content for events with no record; unknowns go in the gaps panel.
- Must work on judge-supplied exports, not just the built-in scenario.
- Label synthetic data as synthetic; label any cached fallback run as cached.

## Pipeline & schemas
- ingest → issue analyst (writes investigation plan) → investigators in parallel split by QUESTION (root cause / commitments / decisions & ownership), each reading the whole event store → skeptic (contradictions, unsupported claims, suspicious silences) → code verifier → assemble (timeline, commitments, gaps, stats).
- If key questions remain unanswered after verification, allow 1–2 retry passes max.
- Event schema: `{id, source, ts (UTC ISO), actor, channel, text, url}`. Normalize Jira UTC / email offsets / Slack epoch; resolve cross-tool identities (alias map + LLM-suggested merges) and cross-source references (e.g. an email mentioning SUP-2231).
- Claim schema (all agents): `{type, text (one sentence), actor, quote, event_id, ts, status (kept|broken|unclear|n/a), confidence}`.
- Agent tools: search_events, get_event, get_thread, list_events, verify_quote, submit_claim.

## Stack constraints
- Next.js App Router on Vercel (demo deployed on Hobby plan: ≤60s per stage function, uploads ≤ ~4MB); runtime LLM is DeepSeek via its OpenAI-compatible endpoint — env-configurable `DEEPSEEK_BASE_URL` (default https://api.deepseek.com), `DEEPSEEK_MODEL` (default deepseek-chat), key in env vars only.
- Postgres for events/claims (Docker Compose locally, hosted `DATABASE_URL` on Vercel).

## Out of scope
Continuous sync, real-time ingestion, multi-project management, auth, client-safe vs internal views. Optional only if time remains: live Jira/Slack pull behind a Source interface, client-reply draft grounded only in verified claims, time scrubber.

## Demo scenario (synthetic)
Northwind Logistics vs Meridian Billing: ~45 events across Jira/email/Slack with planted traps the pipeline must handle — mismatched identities, mixed timestamp formats, a 13-day Jira silence, a premature "Resolved" contradicting Slack, an undocumented client call, ~30% noise.
