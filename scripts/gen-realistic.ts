import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/* Realistic scattered-data workspace: one evidence set shared by several
   client engagements, where the escalation's facts only exist as fragments
   across Jira, Slack and a mixed mailbox. Deterministic: rebuilding produces
   byte-identical files. The answer key lives in README.md only — never here,
   and never in anything the browser can fetch.

   Target engagement: Bright Market vs Lumen Ledger (tickets LUM-*), with
   distractor tenants Acme Corp (KST-*), Halcyon Retail (VEG-*) and Vertex
   Systems (RAV-*). */

export interface RealisticFile {
  name: string;
  content: string;
}

function epochSeconds(date: string, time: string): number {
  return Math.floor(Date.parse(`${date}T${time}:00.000Z`) / 1000);
}

function slackTs(date: string, time: string, index = 0): string {
  return `${epochSeconds(date, time) + index}`;
}

interface SlackMessage {
  ts: string;
  user?: string;
  username?: string;
  text: string;
  thread_ts?: string;
}

function jiraComment(created: string, author: string, body: string) {
  return { created, author: { displayName: author }, body };
}

function jiraHistory(created: string, author: string, items: { field: string; fromString: string; toString: string }[]) {
  return { created, author: { displayName: author }, items };
}

const LUMEN_STAFF = {
  nadia: "Nadia Chen",
  ravi: "Ravi Menon",
  weinstein: "Alex Weinstein",
  qa: "Sam Rivera",
  priya: "Priya Nair",
};

function lumenJira(): string {
  return JSON.stringify(
    {
      issues: [
        {
          key: "LUM-811",
          self: "https://lumen.atlassian.net/rest/api/2/issue/LUM-811",
          fields: {
            summary: "VAT invoice exports show blank totals",
            created: "2024-09-02T08:40:00.000+0000",
            reporter: { displayName: "Dana Okafor" },
            comment: {
              comments: [
                jiraComment("2024-09-02T09:10:00.000+0000", "Priya Nair", "<p>Received via finance call. Exports to the VAT format produce empty Total columns since the 5.3.0 upgrade.</p>"),
                jiraComment("2024-09-18T11:20:00.000+0000", LUMEN_STAFF.ravi, "<p>Fix is scheduled for the Sep 20 release. Please confirm which finance sandbox the export came from.</p>"),
                jiraComment("2024-09-21T10:05:00.000+0000", LUMEN_STAFF.priya, "<p>Resolved with the 5.3.3 rollout; exports verified on our side. Flagging as done.</p>"),
                jiraComment("2024-09-26T14:32:00.000+0000", LUMEN_STAFF.nadia, "<p>Reopened after re-checking the finance sandbox: totals still blank on VAT layouts.</p>"),
                jiraComment("2024-09-28T09:45:00.000+0000", LUMEN_STAFF.nadia, "<p>Fixed in 5.3.4. VAT rounding path corrected; exports verified with finance.</p>"),
              ],
            },
          },
          changelog: {
            histories: [
              jiraHistory("2024-09-18T11:15:00.000+0000", LUMEN_STAFF.ravi, [{ field: "status", fromString: "Open", toString: "In Progress" }]),
              jiraHistory("2024-09-21T10:00:00.000+0000", LUMEN_STAFF.priya, [{ field: "status", fromString: "In Progress", toString: "Resolved" }]),
              jiraHistory("2024-09-22T09:30:00.000+0000", "Nadia Chen", [{ field: "assignee", fromString: "Alex Weinstein", toString: "Ravi Menon" }]),
              jiraHistory("2024-09-26T14:30:00.000+0000", LUMEN_STAFF.nadia, [{ field: "status", fromString: "Resolved", toString: "In Progress" }]),
              jiraHistory("2024-09-28T09:40:00.000+0000", LUMEN_STAFF.nadia, [{ field: "status", fromString: "In Progress", toString: "Resolved" }]),
            ],
          },
        },
        {
          key: "LUM-804",
          self: "https://lumen.atlassian.net/rest/api/2/issue/LUM-804",
          fields: {
            summary: "KESTREL refactor: billing-v2 module",
            created: "2024-09-10T09:00:00.000+0000",
            reporter: { displayName: "Alex Weinstein" },
            comment: {
              comments: [
                jiraComment("2024-09-22T16:20:00.000+0000", LUMEN_STAFF.nadia, "<p>Follow-up while triaging LUM-811: the KESTREL refactor (billing-v2) moved VAT rounding to integer math in 5.3.0, which drops fractional cents and blanks the totals on export. That change is still unreviewed.</p>"),
              ],
            },
          },
        },
      ],
    },
    null,
    2,
  ) + "\n";
}

function distractorJira(
  tickets: { key: string; summary: string; reporter: string; comment: string; created: string }[],
): string {
  return JSON.stringify(
    {
      issues: tickets.map((ticket) => ({
        key: ticket.key,
        self: `https://workspace.atlassian.net/rest/api/2/issue/${ticket.key}`,
        fields: {
          summary: ticket.summary,
          created: ticket.created,
          reporter: { displayName: ticket.reporter },
          comment: { comments: [jiraComment(ticket.created, ticket.reporter, ticket.comment)] },
        },
      })),
    },
    null,
    2,
  ) + "\n";
}

const NOISE_TEMPLATES = [
  "Quick sync later about the migration notes.",
  "Ran the nightly checks; nothing new to flag.",
  "Stats from the last deploy look stable.",
  "Please review the packet before Thursday's call.",
  "Ticket triage done for the week.",
  "Customer pinged about historical records; routed to standard flow.",
];

function noiseMessages(
  count: number,
  users: string[],
  startEpoch: number,
  stepSeconds: number,
  channel: string,
  extra: SlackMessage[] = [],
): SlackMessage[] {
  const messages: SlackMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    const text = NOISE_TEMPLATES[index % NOISE_TEMPLATES.length];
    const stamp = startEpoch + index * stepSeconds;
    messages.push({ ts: `${stamp}`, user: users[index % users.length], text });
  }
  void channel;
  return [...messages, ...extra];
}

function lumenGeneral(): string {
  const base = epochSeconds("2024-09-04", "09:00");
  const extras: SlackMessage[] = [
    {
      ts: slackTs("2024-09-08", "10:30"),
      user: "U2",
      text: "For the Bright Market escalation (LUM-811): we will ship the export fix in the Sep 20 release.",
      thread_ts: slackTs("2024-09-08", "10:25"),
    },
    {
      ts: slackTs("2024-09-20", "16:02"),
      username: "releasebot",
      text: "Release 5.3.3 is live: includes billing-v2 fixes across tenants.",
    },
    {
      ts: slackTs("2024-09-21", "09:15"),
      user: "U5",
      text: "Re-ran finance sandbox: VAT exports are still blank. 5.3.3 did not fix it; reopening soon.",
      thread_ts: slackTs("2024-09-08", "10:25"),
    },
    {
      ts: slackTs("2024-09-09", "08:50"),
      user: "U1",
      text: "Nadia Chen here: on leave until the 25th; Ravi Menon took over the KESTREL coverage.",
    },
  ];
  return JSON.stringify(noiseMessages(18, ["U4", "U6", "U7"], base, 36_000, "lumen-general", extras), null, 2) + "\n";
}

function generalRoom(): string {
  const base = epochSeconds("2024-09-15", "09:00");
  const chases: SlackMessage[] = [
    { ts: slackTs("2024-09-22", "10:00"), user: "U30", text: "Dana Okafor here (Bright Market) — still nothing on the VAT totals fix?" },
    { ts: slackTs("2024-09-22", "17:40"), user: "U30", text: "Second chase on the VAT invoice exports. Day six." },
    { ts: slackTs("2024-09-23", "09:05"), user: "U30", text: "Third chase. We escalate to procurement Monday if nothing moves." },
  ];
  void base;
  return JSON.stringify(noiseMessages(9, ["U31", "U32"], epochSeconds("2024-09-12", "09:00"), 50_000, "general", chases), null, 2) + "\n";
}

function workspaceMbox(): string {
  const messages: string[] = [];
  const push = (seq: number, from: string, subject: string, date: string, body: string, refs = "") =>
    messages.push(
      [
        `From ${from} Mon Sep 30 09:0${seq % 10}:00 2024`,
        `From: ${from}`,
        `Subject: ${subject}`,
        `Date: ${date}`,
        `Message-ID: <rw-${seq}@brightmarket.example>`,
        ...(refs ? [`References: ${refs}`] : []),
        "",
        body,
        "",
      ].join("\n"),
    );

  push(1, "Dana Okafor <billing@brightmarket.example>", "VAT invoice exports blank (LUM-811)", "Mon, 02 Sep 2024 09:00:00 +0800", "Since the 5.3.0 upgrade our VAT export totals are blank. Finance is blocked.");
  push(2, "Ravi Menon <ravi.menon@lumen.example>", "Re: VAT invoice exports blank (LUM-811)", "Mon, 02 Sep 2024 12:30:00 +0800", "We have scheduled a fix for the Sep 20 release. Keeping LUM-811 updated.", "<rw-1@brightmarket.example>");
  push(3, "Priya Nair <priya.nair@lumen.example>", "Re: VAT invoice exports blank (LUM-811)", "Wed, 04 Sep 2024 10:00:00 +0800", "Also tracking in 5.3.3; the billing-v2 piece is separate. Confirm receipt.", "<rw-1@brightmarket.example>");
  push(4, "Dana Okafor <billing@brightmarket.example>", "Chasing: VAT invoice exports (5 of 12 days)", "Mon, 23 Sep 2024 09:00:00 +0800", "Fourth follow-up since Sep 2. No confirmation on Sep 20.", "<rw-2@brightmarket.example>");
  push(5, "Nadia Chen <nadia.chen@lumen.example>", "Re: VAT invoice exports blank (LUM-811)", "Thu, 26 Sep 2024 18:20:00 +0800", "Correct root found: the VAT rounding change in 5.3.0. Fixed properly in 5.3.4 tomorrow.", "<rw-2@brightmarket.example>");
  push(6, "Dana Okafor <billing@brightmarket.example>", "Confirmed: VAT totals fixed in 5.3.4", "Sat, 28 Sep 2024 10:00:00 +0800", "Imports verified. Thank you — this took longer than it should have.", "<rw-5@brightmarket.example>");

  push(7, "Ravi Patel <ops@acme.example>", "KST-301 closed: rate-limit bump", "Tue, 03 Sep 2024 09:00:00 +0800", "Acme's rate limits raised to the contracted level.");
  push(8, "Sam Rivera <sam@racm.example>", "Re: KST-301 quarterly usage", "Wed, 04 Sep 2024 11:00:00 +0800", "Usage graphs attached for the quarter.", "<rw-7@brightmarket.example>");
  push(9, "Noor Haddad <ops@halcyon.example>", "VEG-401 webhook queue drained", "Thu, 05 Sep 2024 09:00:00 +0800", "Halcyon's payment webhook backlog cleared.");
  push(10, "Tiberiu Stan <support@vertex.example>", "RAV-501 go-live prep", "Fri, 06 Sep 2024 09:00:00 +0800", "Vertex go-live checklist attached.");
  push(11, "Sam Rivera <sam.rivera@vertex.example>", "Re: RAV-501 billing roles", "Fri, 06 Sep 2024 15:00:00 +0800", "Adding the finance role mapping today.", "<rw-10@brightmarket.example>");

  // Canned support twins across two tenants: near-identical templates.
  const twinBody = "Thank you for reaching out to our support team. We reviewed your case and confirmed the item you referenced. Please reply if anything differs.";
  push(12, "Ravi Patel <ops@acme.example>", "Your recent support request", "Tue, 10 Sep 2024 09:00:00 +0800", twinBody);
  push(13, "Tiberiu Stan <support@vertex.example>", "Your recent support request", "Tue, 10 Sep 2024 09:05:00 +0800", twinBody);

  // DST-shifted header in the mailbox of a different engagement.
  push(14, "Noor Haddad <ops@halcyon.example>", "VEG-402 churn poll", "Sun, 27 Oct 2024 02:40:00 +0200", "VAT totals recheck this morning after the clock change.");

  for (let index = 15; index <= 26; index += 1) {
    push(index, index % 2 === 0 ? "Ravi Patel <ops@acme.example>" : "Noor Haddad <ops@halcyon.example>",
      index % 2 === 0 ? `KST-30${(index % 9) + 1} routine update` : `VEG-40${(index % 9) + 1} routine update`,
      `Wed, 0${(index % 8) + 1} Oct 2024 09:00:00 +0800`,
      index % 2 === 0 ? "Weekly status unchanged; nothing to escalate." : "Churn figures steady; webhook retries nominal.");
  }

  return messages.join("\n");
}

function escalationEml(): string {
  return [
    "From: Dana Okafor <billing@brightmarket.example>",
    "To: Lumen Ledger support <support@lumen.example>",
    "Date: Sat, 28 Sep 2024 11:15:00 +0800",
    "Subject: Escalation: Bright Market (LUM-811) — invoice VAT totals and a four-week run-around",
    "Message-ID: <rw-escalation@brightmarket.example>",
    "",
    "This is Bright Market's formal escalation on LUM-811 (VAT invoice exports show blank totals).",
    "",
    "The totals have been blank since your 5.3.0 upgrade four weeks ago. We were told the fix",
    "would ship in the Sep 20 release; instead your bot announced 5.3.3 fixes and the ticket was",
    "closed while our finance sandbox still showed blank exports. Our chases on the 22nd and 23rd",
    "went unanswered.",
    "",
    "Please explain what happened and when this was actually fixed.",
    "",
    "Dana Okafor, Finance Lead, Bright Market",
    "",
  ].join("\n");
}

function slackUsers(): string {
  return JSON.stringify([
    { id: "U1", profile: { real_name: LUMEN_STAFF.nadia } },
    { id: "U2", profile: { real_name: LUMEN_STAFF.ravi } },
    { id: "U3", profile: { real_name: LUMEN_STAFF.priya } },
    { id: "U4", profile: { real_name: "Dana Okafor" } },
    { id: "U5", profile: { real_name: LUMEN_STAFF.qa } },
    { id: "U6", profile: { real_name: "Marcus Hale" } },
    { id: "U7", profile: { real_name: "Iris Bloom" } },
    { id: "U8", profile: { real_name: "Ravi Patel" } },
    { id: "U9", profile: { real_name: "Noor Haddad" } },
    { id: "U10", profile: { real_name: "Tiberiu Stan" } },
    { id: "U11", profile: { real_name: "Jonas Petrov" } },
    { id: "U12", profile: { real_name: "Kara Ellison" } },
    { id: "U30", profile: { real_name: "Dana Okafor" } },
  ], null, 2) + "\n";
}

function slackChannels(): string {
  return JSON.stringify([
    { id: "C1", name: "lumen-general" },
    { id: "C2", name: "kst-rotas" },
    { id: "C3", name: "vega-payments" },
    { id: "C4", name: "rav-core" },
    { id: "C5", name: "vertex-billing" },
    { id: "C6", name: "general" },
  ], null, 2) + "\n";
}

export function buildRealisticFiles(): RealisticFile[] {
  const kstUsers = ["U8", "U11"];
  const vegUsers = ["U9", "U12"];
  const ravUsers = ["U10", "U12"];

  return [
    { name: "jira-lumen.json", content: lumenJira() },
    {
      name: "jira-kst.json",
      content: distractorJira([
        { key: "KST-301", summary: "Acme rate-limit increase", reporter: "Ravi Patel", created: "2024-09-03T08:00:00.000+0000", comment: "Raised to the contracted level; monitoring latency." },
        { key: "KST-302", summary: "Acme onboarding cohort sync", reporter: "Sam Rivera", created: "2024-09-08T08:00:00.000+0000", comment: "Cohort import scheduled for the weekend." },
      ]),
    },
    {
      name: "jira-veg.json",
      content: distractorJira([
        { key: "VEG-401", summary: "Halcyon webhook backlog", reporter: "Noor Haddad", created: "2024-09-05T09:00:00.000+0000", comment: "Queue drained; Halcyon confirmed payments fine." },
        { key: "VEG-402", summary: "Halcyon churn poll automation", reporter: "Noor Haddad", created: "2024-09-12T09:00:00.000+0000", comment: "Poll cron moved to Sunday." },
      ]),
    },
    {
      name: "jira-rav.json",
      content: distractorJira([
        { key: "RAV-501", summary: "Vertex go-live prep", reporter: "Tiberiu Stan", created: "2024-09-06T09:00:00.000+0000", comment: "Checklist circulating for review." },
        { key: "RAV-502", summary: "Vertex billing roles sheet", reporter: "Sam Rivera", created: "2024-09-09T09:00:00.000+0000", comment: "Finance role mapping added by Sam Rivera." },
      ]),
    },
    { name: "workspace-mailbox.mbox", content: workspaceMbox() },
    { name: "escalation.eml", content: escalationEml() },
    { name: "slack/users.json", content: slackUsers() },
    { name: "slack/channels.json", content: slackChannels() },
    { name: "slack/lumen-general/messages.json", content: lumenGeneral() },
    {
      name: "slack/kst-rotas/messages.json",
      content: JSON.stringify(noiseMessages(58, kstUsers, epochSeconds("2024-09-03", "09:00"), 21_000, "kst-rotas"), null, 2) + "\n",
    },
    {
      name: "slack/vega-payments/messages.json",
      content: JSON.stringify(noiseMessages(42, vegUsers, epochSeconds("2024-09-04", "10:00"), 24_000, "vega-payments"), null, 2) + "\n",
    },
    {
      name: "slack/rav-core/messages.json",
      content: JSON.stringify(noiseMessages(66, ravUsers, epochSeconds("2024-09-05", "11:00"), 18_000, "rav-core"), null, 2) + "\n",
    },
    {
      name: "slack/vertex-billing/messages.json",
      content: JSON.stringify(noiseMessages(28, ravUsers, epochSeconds("2024-09-06", "12:00"), 27_000, "vertex-billing"), null, 2) + "\n",
    },
    { name: "slack/general/messages.json", content: generalRoom() },
  ];
}

async function main(): Promise<void> {
  const outDir = path.join(process.cwd(), "public", "realistic");
  mkdirSync(outDir, { recursive: true });
  const files = buildRealisticFiles();
  const manifest = { files: files.map((file) => file.name) };
  for (const file of files) {
    const target = path.join(outDir, file.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`realistic workspace written to public/realistic (${manifest.files.length} files)`);
}

if (process.argv[1]?.endsWith("gen-realistic.ts")) {
  void main();
}
