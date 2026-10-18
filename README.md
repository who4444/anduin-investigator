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
text — it also checks that the claim's author and timestamp match the cited
item. On top of that, one isolated model call per surviving claim sees only the
claim and the quote and judges whether the quote supports it. Findings land in
three states: **verified** (all checks pass), **supported** (the quote is
verbatim but a softer check did not fully pass — shown wearing a "check before
repeating" label), and **rejected** (quote not found or item missing — kept
visible, never used). A model can only ever downgrade a finding, never reject
it. Trust never depends on what an agent claims it saw.

## How it works

```
intake (escalation + sources)
       ─► ingest (parse + normalise + identity resolution into the registry)
       ─► analyst (investigation plan naming sources and search angles)
       ─► investigators in parallel, split by QUESTION
            · root cause   · commitments   · decisions & ownership
       ─► skeptic (contradictions, weak support, silences, angles never searched)
       ─► verifier (CODE: verbatim quote + author/time; then one isolated
                   model call per claim: does the quote support the claim?)
       ─► assemble (timeline, commitments ledger, gaps, coverage, stats)
       ─► one retry pass when a question group has no verified or supported claim (max 2 iterations)
```

Non-negotiables enforced in code:

- Everything shown is produced live from the retrieved items. The answer key
  below exists only in this README and is never imported by the app.
- Every claim links to a stored item and an exact quote; the quote against the
  stored text and the claim's author and timestamp against the cited item are
  checked deterministically, never by an agent. One isolated model call per
  claim may downgrade a finding to "supported" for review, but only the
  deterministic checks can reject one.
- A claim whose quote fails verification is flagged and excluded from the
  timeline and ledger; a claim that passes the quote check but fails a softer
  check stays visible with a "check before repeating" label.
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
3. Load targets, tick channels, pull. Users are resolved to real names, and
   thread replies are fetched explicitly (`conversations.replies`) and linked
   to their parent message.

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

1. **Hosted Postgres — Neon (recommended).** Install it from the Vercel Marketplace:
   `vercel install neon --plan free` (works on Hobby; $0). Vercel injects
   `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct) into the project.
   Neon's free plan (100 CU-hours/project, 1 GB storage, scale-to-zero with
   automatic wake) is far more than this app needs, and it resumes on its own —
   unlike Supabase Free, which pauses after a week idle and needs a manual resume.
   Supabase also works: use its pooler connection string (port 6543) as
   `DATABASE_URL`; the Postgres client already disables prepared statements,
   which transaction-mode poolers require.
2. **Migrations.** Run once against the *direct* URL (poolers are fine for the
   app, not for DDL):
   `DATABASE_URL="$DATABASE_URL_UNPOOLED" npm run db:migrate`
3. **Env vars** — `DATABASE_URL`, `DEEPSEEK_API_KEY` (+ optional `DEEPSEEK_BASE_URL`,
   `DEEPSEEK_MODEL`), and any live-source credentials (`JIRA_*`, `SLACK_TOKEN`,
   `GMAIL_*`). Optional tuning: `DATABASE_POOL_MAX` (default 5) and
   `DATABASE_PREPARE=true` only against a direct (non-pooled) endpoint.
4. `vercel deploy`. Each pipeline stage is its own request and the client drives
   them in order, so no single function runs the whole pipeline.
5. Keep uploads under ~4 MB — the Vercel Hobby request-body limit. The built-in
   demo bundle is well under that.

## Using it

1. **Start** — paste the client's escalation and pick the project's sources
   (Jira project, Slack channels, mailbox filter). Connected sources are pulled
   read-only; credentials stay server-side. "Load Northwind scenario" fills the
   escalation with the synthetic dataset instead.
2. **Progress** — the stages tick through (Plan, Retrieve and investigate,
   Skeptic review, Verify, Assemble) with a live log of each agent's tool calls
   and the records they returned, plus coverage as it stands. Errors say what
   failed and what to do next.
3. **Report** — one scrolling internal briefing rendered from a single
   server-built `ReportModel` (actors, deduplicated findings, state, counts,
   headline, open questions, actions and the one silence). The first screen is
   a **2–3 sentence story** with finding citations and a muted stats line,
   followed by four counts (findings, verified, needs check, open questions),
   the current-state cards, and **Do now** actions that name their trigger.
   **What happened** renders each finding once; promises, failures and the
   told-vs-other-records audit link back compactly instead of repeating it.
   The **timeline board** sits directly after the story and draws the silent
   period once, only on lanes with activity. **Open questions** are grouped by
   theme with a next step (top five expanded, the rest behind Show all).
   **Draft reply** is built only from safe verified findings, every sentence
   linked to its evidence and never sent from the app. If the client or project
   cannot be identified, a prominent notice offers a roster-backed **Confirm
   client** action and role-dependent cards say so instead of guessing. Every
   marker, card and row opens the shared evidence drawer with the stored
   original message and the cited quote highlighted. "How this was produced"
   reopens the full activity log and coverage.
   Uploaded exports remain available as the fallback path ("Use uploaded
   exports instead"): Jira JSON, `.mbox`/`.eml`, a Slack export folder or zip.

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

## Realistic scattered-data scenario — answer key

`npm run realistic:gen` builds `public/realistic/`: **276 records** across four
tenant engagements in one evidence set. Bright Market / Lumen Ledger (`LUM-*`)
is the target; Acme (`KST-*`), Halcyon (`VEG-*`) and Vertex (`RAV-*`) are
distractors (~85% of records unrelated). All facts below exist only as
cross-source fragments — check the report against this list.

**The story (Bright Market vs Lumen Ledger, "LUM-811"):**

1. **Root cause** — VAT invoice exports show blank totals since release 5.3.0.
   The cause is ONLY stated in a comment on the linked ticket **LUM-804**
   ("KESTREL refactor: billing-v2"): the refactor moved VAT rounding to
   integer math in 5.3.0 and drops fractional cents on export. The escalation
   and LUM-811 never mention KESTREL.
2. **The promise** — Sep 2 (email, Ravi Menon) and Sep 18 (Slack
   `lumen-general` + Jira): *"fix scheduled for the Sep 20 release"* — status
   **broken**.
3. **The premature resolution** — after releasebot announces "5.3.3 is live:
   includes billing-v2 fixes" (a *contradicting claim*), Priya Nair marks
   LUM-811 RESOLVED on Sep 21 ("exports verified on our side") while Sam
   Rivera's QA re-run in `lumen-general` shows VAT exports still blank.
4. **The real fix** — Sep 26: reopened, correct cause identified; Sep 28:
   fixed in **5.3.4** and confirmed by Bright Market by email.
5. **The silence** — Sep 9 → Sep 17: no records at all (an 8-day gap).
6. **The handoff** — Nadia Chen's leave is stated only in Slack
   (`lumen-general`, Sep 9); the handoff itself (assignee Alex Weinstein →
   **Ravi Menon**) is recorded only in the LUM-811 assignee changelog (Sep 22).
7. **The unanswered chases** — Bright Market (Dana Okafor) chases three times
   (Sep 22 ×2, Sep 23) in the vendor's **shared `general` room**, plus the
   Sep 23 email — no reply until Sep 26.

**Expected system behavior:**

- Variants: named + declared → `scoped`; named only → `partial`; vague
  ("your billing thing broke") + declared → `partial` with caution; vague +
  nothing → unsolved/unscoped honest line. The distractor channel
  `vertex-billing` and the twin canned-support emails exist to test that a
  vague escalation is never confidently anchored to a wrong client.
- Scope should exclude ~230+ records; every visible claim must cite in-scope
  records only; bottom-line cells all determined; zero cross-tenant mentions.
- Live checks of this protocol (real LLM) are manual, per the demo protocol.

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
- `lib/pipeline/*` — claim verification (deterministic quote + author/time
  checks, then the isolated model support call; three states), coverage
  (sources/queries actually searched) and assembly (including the retry
  decision).
- `lib/store.ts` + `migrations/` — the Postgres Evidence Registry (events,
  claims, skeptic notes, gaps, stage runs, identity resolutions).
- `app/api/investigations/**` — one route per pipeline stage; `app/api/sources/**`
  serves live-pull configuration and pulls; the client orchestrates everything
  (`lib/orchestrator.ts`) and shows progress on screen 1.
