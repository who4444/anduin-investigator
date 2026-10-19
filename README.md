# Anduin Investigator

A client escalates a problem; the answer is scattered across Jira, email and
Slack. Anduin Investigator consolidates that history and produces a clear,
ordered, source-backed account of what happened — so a manager can answer the
escalation in minutes instead of days.

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

The report itself is computed, not narrated: the headline, counts, current
state, promises, contradictions, silence, open questions, actions and reply
eligibility all come from one deterministic decision layer over the stored
records. The only model-written client-facing text is the draft reply, and every
sentence is validated against verified, client-safe claims before it is stored.

## What the report answers

1. **Who did what** — actors resolved across tools, with the record that names
   them.
2. **When** — one ordered timeline across every searched source, with the
   silent periods drawn once.
3. **What was promised** — a promise-only ledger: who promised whom, by when,
   and whether it was kept, broken or unclear.
4. **What went wrong** — root cause plus process failures: missed handoffs,
   unannounced releases, premature closures, unanswered messages.
5. **What we could not determine** — explicit gaps and unsearched sources;
   never a guess.

## How it works

```
intake (escalation + client + optional source limits)
       ─► ingest (parse, normalise to UTC, identity resolution, Evidence Registry)
       ─► analyst (structured plan, scope proposals, 1–3 independent issues)
       ─► scope review (CODE keeps only registry-verified anchors; always shown
                       as "I'll search: …" — partial scopes are flagged)
       ─► issue review (multi-issue runs pause for an editable split)
       ─► investigators in parallel, split by QUESTION
            · root cause   · commitments   · decisions & ownership
       ─► skeptic (contradictions, weak support, silences, angles never searched)
       ─► verifier (CODE: verbatim quote + author/time; then one isolated
                   model call per claim: does the quote support the claim?)
       ─► assemble (decision layer: answer-first story, counts, timeline,
                   promise ledger, gaps, coverage, frozen report version)
       ─► targeted retry for question groups with no visible finding (max 2 iterations)
```

- **Plan.** The analyst writes hypotheses (each with a test and a falsification
  criterion), a per-source search plan, seed terms, people and a focus window.
  It plans against a deterministic vocabulary digest of the in-scope records
  (ticket keys, build-like versions, channels, domains, frequent terms), so
  internal code names and releases are considered even when the escalation
  never mentions them.
- **Scope.** The declared client, escalation evidence, model proposals and
  previously learned identifiers are treated as anchors; **CODE keeps only
  identifiers that exist in the registry**. More than two convergent anchors
  means `scoped`; one or two means `partial` (the report warns and names the
  linking evidence); zero means unscoped, and the report says every stored
  record was searched. Confirmed scopes are learned per client and offered back
  as prior anchors on the next run. Excluded records and claims are counted and
  disclosed.
- **Issues.** The analyst decides whether the escalation contains one, two or
  three **independent** issues. Facets of one incident — a failed fix, a
  premature closure, unanswered chases, an SLA consequence — stay one issue.
  With more than one issue the run pauses before any investigator starts so the
  manager can rename, edit, remove, merge or add issues (max three).
- **Skeptic.** A deterministic checklist gates the soft pass; the skeptic looks
  for contradictions, weak support, suspicious silences and sources or angles
  that were never searched.
- **Retry.** A gap-driven pass retries only what is missing — an unsearched but
  available source, an answerable open question, a question group with no
  visible finding, or an empty promise ledger behind investigated promises.

Non-negotiables enforced in code:

- Everything shown is produced live from the retrieved items. The answer key
  below exists only in this README and is never imported by the app.
- Every finding links to a stored item and an exact quote; the quote against
  the stored text and the claim's author and timestamp against the cited item
  are checked deterministically, never by an agent. One isolated model call per
  claim may downgrade a finding to "supported" for review, but only the
  deterministic checks can reject one.
- A claim whose quote fails verification is excluded from the timeline and
  ledger; a claim that passes the quote check but fails a softer check stays
  visible with a "check before repeating" label.
- Nothing is invented for events with no record — unknowns land in the gaps
  panel, and "source not in the export", "searched, no matches", "excluded" and
  "call failed" are reported as different things.
- Scope is evidence-backed. Client-authored records survive the split by
  construction; if any client record is still excluded the report blocks the
  draft and says why.
- A promise is never a status assertion, a decision or a completed-fix report.
  The commitments ledger is promise-only and is the same list read by the
  metric, the section, the bottom line and the briefing.
- Judge-supplied exports work too, not just the built-in scenarios.
- Synthetic data is labelled synthetic; live pulls are labelled live; cached
  runs are labelled cached and keyed by model + pipeline version.
- The report's top answer is frozen in `report_versions`; drafting or
  redrafting a reply never replaces it.
- A client reply is draftable only when the client and project are resolved,
  no client evidence was excluded, at least one verified client-safe finding
  exists, and the run is not a cross-tenant conflict. Every sentence is linked
  to its evidence; copying is gated on explicit approval, and nothing is ever
  sent from the app.

## Setup (local)

```bash
npm install
npm run db:up                 # Postgres 16 on localhost:5432 (anduin/anduin)
cp .env.example .env.local    # then set DEEPSEEK_API_KEY
npm run db:migrate            # apply migrations/*.sql (currently 019)
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
| `JIRA_HIDDEN_PROJECTS` | —                        | Comma-separated project keys hidden from the default target list |
| `SLACK_HIDDEN_CHANNELS` | —                       | Comma-separated channel names hidden from the default target list |

Optional infrastructure tuning: `DATABASE_POOL_MAX` (default 5) and
`DATABASE_PREPARE=true` only against a direct (non-pooled) endpoint.

## Live pulls (optional)

The tool always works on uploaded exports. If you add the env vars above, the
start screen searches every connected source by default and runs the same
ingest pipeline as an upload (the run is labelled **live pull**).

Open **Advanced: limit sources** to narrow the pull to specific Jira projects,
Slack channels or a Gmail mailbox filter. Leaving everything empty means
"everything these credentials can access": the source expands its own
non-hidden set, and the expanded selection is stored with the investigation so
the pre-run scope review can show human labels ("I'll search: Meridian Billing,
#meridian-support, mail: …"). Hidden projects and channels stay discoverable
through the target search box.

**Jira Cloud**
1. Create an API token: id.atlassian.com → Security → API tokens.
2. Set `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, restart.
3. If needed, restrict with a JQL refinement. Issues are fetched with
   `expand=changelog` so status transitions and assignee changes are captured.

**Slack**
1. api.slack.com/apps → Create app → OAuth & Permissions → User Token Scopes:
   `channels:history`, `groups:history`, `im:history`, `mpim:history`,
   `channels:read`, `groups:read`, `users:read`.
2. Install to your workspace and copy the `xoxp-…` token to `SLACK_TOKEN`.
3. Users are resolved to real names, and thread replies are fetched explicitly
   (`conversations.replies`) and linked to their parent message.

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
npm run dev            # Next.js dev server
npm run build          # production build
npm run lint           # eslint
npm run typecheck      # tsc --noEmit
npx vitest run         # unit + integration tests (DB tests skip without DATABASE_URL)
npm run test:ui        # Playwright UI suite; run npm run build first
npm run db:up          # docker compose up -d
npm run db:migrate     # apply migrations/*.sql
npm run demo:gen       # regenerate the synthetic exports into public/demo/
npm run realistic:gen  # regenerate the four-tenant workspace into public/realistic/
npm run real:smoke -- demo|realistic|vague|all  # real-LLM smoke against a running app
npm run clean:test     # dry-run test-created investigations; add -- --apply to delete
```

`npm run test:ui` runs the real built app on port 3100 with a deterministic fake
OpenAI-compatible LLM on port 9401, so the full pipeline runs free and offline;
it cleans up the investigations it creates. `npm run real:smoke` needs
`npm run start` on port 3000 with real credentials and costs real tokens.

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
5. Keep uploads under ~4 MB on Hobby (its request-body limit). The app itself
   accepts up to 8 MB; locally and on plans with a larger body limit that is the
   real cap. The built-in scenario bundles are well under both.

## Using it

1. **Start** — paste the client's escalation and name the external client.
   Connected sources show their status and are searched by default; use
   **Advanced: limit sources** to narrow to projects, channels or a mailbox
   filter. **Load Northwind scenario** or **Load multi-issue scenario** runs a
   labelled synthetic case instead, and **Use uploaded exports instead** opens
   the fallback path.
2. **Confirm the scope** — after the plan the run pauses on a pre-run review:
   *"I'll search: …"* lists the resolved search units, the records that will be
   searched and how many are excluded. **Edit** lets the manager remove search
   units or add excluded records back. A partial scope is flagged as
   unconfirmed until reviewed; an unscoped run says every stored record was
   searched.
3. **Confirm the issues** — a multi-issue escalation pauses for an editable
   split: rename, edit the ask/summary, remove, merge into one or add up to
   three issues. The plan warns if it detected more than three.
4. **Progress** — summary-first counts and the stages (Plan, Retrieve and
   investigate, Skeptic review, Verify, Assemble), with the live activity log
   and coverage behind a toggle. A half-finished run resumes at the first
   unfinished stage without redoing completed investigators; errors say what
   failed and what to do next.
5. **Report** — one scrolling internal briefing, answer-first:
   - the headline states what broke, why, what was promised and whether it was
     kept, what is true now, and the one open question with a next step; every
     sentence cites its source records;
   - **You can say** lists exactly the verified, client-safe, unflagged
     findings; **Not yet** lists the ones needing a human check;
   - a current-state strip reports status, owner, latest fix, next commitment,
     last client contact and last internal update — or says why a value is
     unknown;
   - **Do now** actions name their trigger; **What happened** renders each
     finding once; the timeline board draws the silent period once;
   - the promise ledger, failures/contradictions, grouped open questions and
     coverage follow;
   - **Draft reply** is built only from safe verified findings, per issue,
     every sentence linked to its evidence, and it must be explicitly approved
     before it can be copied; nothing is sent from the app;
   - every marker, card and row opens the shared evidence drawer with the
     stored original and the cited quote highlighted.
6. **Multi-issue reports** — issue tabs (plus **All issues** for the combined
   view) switch the timeline, promises, failures, open questions and reply.
   Drafts are per issue; the combined view cannot draft.
7. **How this was produced** — reopens the full activity log, scope and
   coverage. Uploaded exports remain available through the fallback path: Jira
   JSON, `.mbox`/`.eml`, or a Slack export folder/zip.

## Demo scenario (synthetic) — answer key

**Do not put this in application code.** It is the reference a judge can check
against, and it is deliberately kept out of the app bundle.

Northwind Logistics (client) reports that invoice totals are wrong after
Meridian's release 4.12. The synthetic exports live in `public/demo/` and are
generated by `scripts/gen-demo.ts`; **Load Northwind scenario** on the start
page runs them end to end.

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
- **One issue, not several** — the failed fix, the premature closure, the leave
  and the unanswered chases are facets of the same incident. The plan must not
  split Northwind into multiple issues.

## Multi-issue scenario (synthetic) — answer key

`public/multi/` is a compact Contoso / Orbit case with **two independent
issues**:

1. **Blank VAT invoice totals after 2.1.0** — its own root-cause ticket,
   promise, owner and fix version.
2. **Finance SSO failing after the identity migration** — a separate root cause,
   promise, owner and fix version.

The shared `general` room holds the client's chases. **Load multi-issue
scenario** on the start page runs it end to end (`origin=demo`, labelled
synthetic).

Expected behavior:

- The plan splits exactly these two issues — not the chases or the failed fixes
  as separate issues — and the progress page pauses for the editable review
  before any investigator runs.
- The report exposes `?issue=<id>` per issue and `?issue=all` for the combined
  view; timeline, promises, failures, open questions and drafts are per issue.
- Drafting is unavailable in the combined view and available per issue once
  that issue has a verified, client-safe finding.

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
  nothing → unscoped with an honest "every stored record was searched" line.
  The distractor channel `vertex-billing` and the twin canned-support emails
  exist to test that a vague escalation is never confidently anchored to a
  wrong client.
- Scope should exclude ~230+ records; every visible claim must cite in-scope
  records only; bottom-line cells all determined; zero cross-tenant mentions.
- Live checks of this protocol (real LLM) are manual, per the demo protocol.

## Architecture notes

- `lib/ingest/*` — parsers (never throw; malformed input degrades to fewer
  events), timestamp normalisation, ticket-ref extraction, identity resolution,
  and the shared ingest flow used by uploads and live pulls.
- `lib/sources/*` — live read-only adapters (Jira Cloud, Slack, Gmail) behind the
  Source interface; export upload is the fallback implementation. `listTargets`
  returns only browsable projects and channels the bot can access; the hidden
  lists keep workspace noise out of the default selection. An empty selection
  expands to the source's own accessible set and the expanded `{id,label}`
  selection is stored on the investigation.
- `lib/agents/*` — analyst, investigators, skeptic, summary and reply, plus the
  source tools they call (`search_jira`, `get_issue`, `search_slack`,
  `get_slack_thread`, `search_email`, `get_email_thread`), the registry tools
  (`verify_quote`, `submit_claim`, `submit_commitment`) and relevance ranking.
  Commitments are promise-only; completed-fix/QA/status objects are rejected as
  commitments.
- `lib/pipeline/*` — vocabulary digest, structured plan, scope anchors and
  learned scopes, issue decomposition, claim verification (deterministic quote +
  author/time, then the isolated model support call), coverage, assembly and the
  gap-driven retry decision.
- `lib/report/*` — the decision layer: `decision.ts` (canonical fact/promise/
  count shapes with asserted counts), `story.ts` (deterministic answer-first
  headline), `contradictions.ts` (deterministic detectors), `silence.ts` (the
  one silence computation shared by model, metric and briefing), `model.ts`
  (the single `ReportModel` the page and API render), plus report assembly and
  briefing. `lib/agents/reply.ts` enforces the reply gates and validates every
  sentence against verified, client-safe claim ids.
- `lib/store.ts` + `migrations/` — the Postgres Evidence Registry and all
  derived state: events, claims, commitments, skeptic notes, gaps, stage runs,
  identity resolutions, investigations, issues, scope reviews, learned scopes,
  claim reviews, report versions and stored replies.
- `app/api/investigations/**` — one route per pipeline stage, plus scope and
  issue review, claim review, report, reply and reply approval. `app/api/sources/**`
  serves source configuration, target lists and live pulls. The client
  orchestrates everything (`lib/orchestrator.ts`); stage updates stream over
  SSE for the progress screen.
- UI — plain CSS tokens in `app/globals.css`, no Tailwind. The start page
  collects the escalation and shows source status; the report is one scrolling
  briefing (`app/_components/briefing/*`) backed by the shared evidence drawer
  (`app/_components/evidence.tsx`). Status is never colour-alone:
  verified/needs-check/conflict always pair a tint with an icon or label.
