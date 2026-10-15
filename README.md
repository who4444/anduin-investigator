# Anduin Investigator

A client escalates a billing problem; the answer is scattered across Jira, email
and Slack. Anduin Investigator investigates that scattered history and produces a
clear, ordered, source-backed account of what happened — so a manager can answer
the escalation in minutes instead of days.

The architecture is **agents retrieve, code verifies**: agents call source tools
to find and read items; the tool layer, not the agent, is the system of record
(every retrieved item is normalised into the Evidence Registry with source, item
id, UTC timestamp, author, full text and URL); agents cite an item id plus an
exact quote; and a deterministic verifier checks that quote against the stored
text. Trust never depends on what an agent claims it saw.

## How it works

```
intake (escalation + sources)
       ─► ingest (parse + normalise + identity resolution into the registry)
       ─► analyst (investigation plan naming sources and search angles)
       ─► investigators in parallel, split by QUESTION
            · root cause   · commitments   · decisions & ownership
       ─► skeptic (contradictions, weak support, silences, angles never searched)
       ─► verifier (CODE: whitespace-normalised verbatim quote check)
       ─► assemble (timeline, commitments ledger, gaps, coverage, stats)
       ─► one retry pass when a question group has no verified claim (max 2 iterations)
```

Non-negotiables enforced in code:

- Everything shown is produced live from the retrieved items. The answer key
  below exists only in this README and is never imported by the app.
- Every claim links to a stored item and an exact quote; verification is
  deterministic (whitespace-normalised substring check), never a model.
- A claim whose quote fails verification is flagged and excluded from the
  timeline and ledger.
- Nothing is invented for events with no record — unknowns land in the gaps
  panel.
- Judge-supplied exports work too, not just the built-in scenario.
- Synthetic data is labelled synthetic; cached runs are labelled cached.
- Coverage is reported honestly: which sources and queries were actually
  searched (and which available sources never were).

## Setup (local)

```bash
npm install
docker compose up -d          # Postgres 16 on localhost:5432 (anduin/anduin)
cp .env.example .env.local    # then set DEEPSEEK_API_KEY
npm run db:migrate
npm run dev
```

Environment variables (all server-side; none are committed):

| Variable            | Default                     | Purpose                          |
| ------------------- | --------------------------- | -------------------------------- |
| `DATABASE_URL`      | `postgres://anduin:anduin@localhost:5432/anduin` | Postgres connection |
| `DEEPSEEK_API_KEY`  | — (required at runtime)     | DeepSeek API key                 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com`  | OpenAI-compatible endpoint       |
| `DEEPSEEK_MODEL`    | `deepseek-chat`             | Model used by every agent        |
| `JIRA_SITE`         | —                           | Jira Cloud host (`yoursite` or `yoursite.atlassian.net`) |
| `JIRA_EMAIL`        | —                           | Atlassian account email for API auth |
| `JIRA_API_TOKEN`    | —                           | Atlassian API token (id.atlassian.com) |
| `SLACK_TOKEN`       | —                           | Slack user token (`xoxp-…`) with read scopes |
| `GMAIL_CLIENT_ID`   | —                           | Google OAuth client id           |
| `GMAIL_CLIENT_SECRET` | —                         | Google OAuth client secret       |
| `GMAIL_REFRESH_TOKEN` | —                         | Refresh token with `gmail.readonly` |
| `GMAIL_QUERY`       | —                           | Default Gmail search (e.g. `label:meridian newer_than:90d`) |
| `GMAIL_MAX_MESSAGES` | `200`                      | Per-pull message cap             |

## Live pulls (optional)

The tool always works on uploaded exports. If you add the env vars above, the
upload screen also gains a **Pull from live sources** panel that fetches
read-only from the services and runs the exact same ingest pipeline (the runs
are labelled **live pull**).

**Jira Cloud**
1. Create an API token: id.atlassian.com → Security → API tokens.
2. Set `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, restart.
3. In the panel, load targets (your projects), tick the relevant ones, optionally
   fine-tune the JQL, pull. Issues are fetched with `expand=changelog` so status
   transitions are captured.

**Slack**
1. api.slack.com/apps → Create app → OAuth & Permissions → User Token Scopes:
   `channels:history`, `groups:history`, `im:history`, `mpim:history`,
   `channels:read`, `groups:read`, `users:read`.
2. Install to your workspace and copy the `xoxp-…` token to `SLACK_TOKEN`.
3. Load targets, tick channels, pull. Users are resolved to real names; thread
   replies inside the fetched window are linked.

**Gmail**
1. Google Cloud console → new project → enable the **Gmail API** → OAuth consent
   screen (External, testing; add yourself as a test user) → Credentials →
   OAuth client ID (Desktop app).
2. Open the OAuth 2.0 Playground (developers.google.com/oauthplayground) →
   gear icon → use your own client id/secret → authorize
   `https://www.googleapis.com/auth/gmail.readonly` with your account → exchange
   the code → copy the **refresh token**.
3. Set `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` (and
   optionally `GMAIL_QUERY`), restart, then pull with a query like
   `label:meridian newer_than:90d`.

Credentials are read server-side only, never stored in Postgres, never sent to
the browser, and redacted from the stage logs. Each pull fetches within the
60-second function budget (Jira ≤ 4 pages per project, Slack ≤ 10 channels /
600 messages each, Gmail ≤ `GMAIL_MAX_MESSAGES`), warning when it truncates.

## Commands

```bash
npm run dev          # Next.js dev server
npm run build        # production build
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npx vitest run       # unit + integration tests (DB tests skip without DATABASE_URL)
npm run db:up        # docker compose up -d
npm run db:migrate   # apply migrations/*.sql
npm run demo:gen     # regenerate the synthetic exports into public/demo/
```

## Deploying to Vercel

The demo is built for the Vercel Hobby plan (≤60s per function, small uploads).

1. Create a hosted Postgres (Neon/Supabase/etc.) and set `DATABASE_URL`.
2. Set `DEEPSEEK_API_KEY` (plus `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` if you
   point at a different OpenAI-compatible endpoint) in the project's env vars.
3. Run the migration against the hosted database once (`npm run db:migrate` with
   `DATABASE_URL` exported).
4. `vercel deploy`. Each pipeline stage is its own request, and the client
   drives them in order, so no single function runs the whole pipeline.
5. Keep uploads under ~4 MB — the Vercel Hobby request-body limit. The built-in
   demo bundle is well under that.

## Using it

1. Paste the escalation (optional) and attach exports: Jira JSON (search
   response or a single issue), an `.mbox`/`.eml` email file, or a Slack export
   folder (either pick the folder or upload a `.zip` of it).
2. Or press **Load built-in demo exports** to run the synthetic Northwind /
   Meridian scenario through the same ingest path.
3. Watch the stage checklist, then read the timeline (click an event to see the
   original message with cited quotes highlighted), the commitments ledger and
   the gaps panel.

## Demo scenario (synthetic) — answer key

**Do not put this in application code.** It is the reference a judge can check
against, and it is deliberately kept out of the app bundle.

Northwind Logistics (client) reports that invoice totals are wrong after
Meridian's release 4.12. The synthetic exports live in `public/demo/` and are
generated by `scripts/gen-demo.ts`.

Expected picture:

- **Root cause** — `MER-87` switched invoice date handling to UTC and shipped in
  release 4.12 (deployed 2024-09-10). `MER-101` documents that Meridian's totals
  have been wrong since then; Marcus Webb names `MER-87` as the cause.
- **Commitments** — "the fix will ship in the Sep 24 release" (L. Chen, email,
  2024-09-20). The Sep 24 build was cut, but `MER-101` was marked **Resolved** on
  2024-09-26 while Slack shows QA still failing on that build — so the promise
  was **broken**, not kept.
- **Process failures** —
  - No handoff: Lin Chen went on leave until Oct 2 with no coverage (Slack, 2024-09-20).
  - Premature resolution: `MER-101` status → Resolved (2024-09-26) contradicting Slack QA (2024-09-25).
  - Unanswered client: four chase emails 2024-09-27 → 2024-09-30, with no reply anywhere in the records.
- **Silence** — the Jira record is quiet for roughly 13 days (2024-09-10 → 2024-09-23).
- **Gaps the tool should report, not invent** —
  - The client email of 2024-10-01 says "as discussed on our call", but no call,
    meeting note or transcript exists in any source (undocumented client call).
  - No event shows the Sep 24 release actually reaching production.
- **Identity traps** — the same engineer appears as `L. Chen <l.chen@northwind.example>`
  (email) and `Lin Chen` (Slack) and should resolve to one person; weaker
  suggestions are recorded but not silently applied.
- **Cross-source reference** — an email mentions `SUP-2231` (a different
  project's ticket) and `MER-101`; refs are extracted onto the events.
- **Noise** — roughly 30% of the events (unrelated tickets, chatter, marketing
  mail) carry no signal and should stay in the timeline without generating claims.

## Architecture notes

- `lib/ingest/*` — parsers (never throw; malformed input degrades to fewer
  events), timestamp normalisation, ticket-ref extraction, identity resolution,
  and the shared ingest flow used by uploads and live pulls.
- `lib/sources/*` — live read-only adapters (Jira Cloud, Slack, Gmail) behind the
  Source interface; export upload is the fallback implementation.
- `lib/agents/*` — analyst, investigators, skeptic, plus the source tools they
  call (`search_jira`, `get_issue`, `search_slack`, `get_slack_thread`,
  `search_email`, `get_email_thread`) and the registry tools
  (`verify_quote`, `submit_claim`).
- `lib/pipeline/*` — deterministic claim verification, coverage (sources/queries
  actually searched) and assembly (including the retry decision).
- `lib/store.ts` + `migrations/` — the Postgres Evidence Registry (events,
  claims, skeptic notes, gaps, stage runs, identity resolutions).
- `app/api/investigations/**` — one route per pipeline stage; `app/api/sources/**`
  serves live-pull configuration and pulls; the client orchestrates everything
  (`lib/orchestrator.ts`) and shows progress on screen 1.
