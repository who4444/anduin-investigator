import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface DemoFile {
  name: string;
  content: string;
}

const jira = {
  issues: [
    {
      key: "MER-87",
      self: "https://northwind.atlassian.net/rest/api/2/issue/MER-87",
      fields: {
        summary: "Switch invoice date handling to UTC",
        created: "2024-09-05T09:00:00.000+0000",
        reporter: { displayName: "Marcus Webb" },
      },
      changelog: {
        histories: [
          {
            author: { displayName: "Marcus Webb" },
            created: "2024-09-10T03:00:00.000+0000",
            items: [{ field: "status", fromString: "Open", toString: "In Progress" }],
          },
          {
            author: { displayName: "Marcus Webb" },
            created: "2024-09-10T08:00:00.000+0000",
            items: [{ field: "status", fromString: "In Progress", toString: "Resolved" }],
          },
        ],
      },
      comment: {
        comments: [
          {
            author: { displayName: "Lin Chen" },
            created: "2024-09-10T03:00:00.000+0000",
            body: "<p>Merged to release branch 4.12; invoices now use a UTC conversion.</p>",
          },
        ],
      },
    },
    {
      key: "MER-101",
      self: "https://northwind.atlassian.net/rest/api/2/issue/MER-101",
      fields: {
        summary: "Invoice totals wrong for Meridian after 4.12",
        created: "2024-09-10T12:00:00.000+0000",
        reporter: { displayName: "Priya Nair" },
      },
      changelog: {
        histories: [
          {
            author: { displayName: "Marcus Webb" },
            created: "2024-09-23T04:00:00.000+0000",
            items: [{ field: "status", fromString: "Open", toString: "In Progress" }],
          },
          {
            author: { displayName: "Marcus Webb" },
            created: "2024-09-26T02:00:00.000+0000",
            items: [{ field: "status", fromString: "In Progress", toString: "Resolved" }],
          },
        ],
      },
      comment: {
        comments: [
          {
            author: { displayName: "Priya Nair" },
            created: "2024-09-10T12:30:00.000+0000",
            body: "<p>Meridian reports invoice totals are wrong since the 4.12 deploy; timelines are off by a day.</p>",
          },
          {
            author: { displayName: "Marcus Webb" },
            created: "2024-09-23T04:05:00.000+0000",
            body: "<p>Root cause looks like the MER-87 timezone change. Fix scheduled for the Sep 24 release.</p>",
          },
        ],
      },
    },
    {
      key: "MER-102",
      self: "https://northwind.atlassian.net/rest/api/2/issue/MER-102",
      fields: {
        summary: "Bump PDF renderer dependency",
        created: "2024-09-06T06:00:00.000+0000",
        reporter: { displayName: "Dana Okoro" },
      },
      comment: {
        comments: [
          {
            author: { displayName: "Dana Okoro" },
            created: "2024-09-06T06:30:00.000+0000",
            body: "<p>Routine dependency bump, no customer impact.</p>",
          },
        ],
      },
    },
    {
      key: "MER-104",
      self: "https://northwind.atlassian.net/rest/api/2/issue/MER-104",
      fields: {
        summary: "Add retry to nightly export",
        created: "2024-09-07T07:00:00.000+0000",
        reporter: { displayName: "Dana Okoro" },
      },
      comment: {
        comments: [
          {
            author: { displayName: "Dana Okoro" },
            created: "2024-09-07T07:20:00.000+0000",
            body: "<p>Nightly export retries twice now.</p>",
          },
        ],
      },
    },
  ],
};

interface MailSpec {
  from: string;
  to: string;
  date: string;
  subject: string;
  body: string;
  messageId: string;
  inReplyTo?: string;
}

const mails: MailSpec[] = [
  {
    from: "L. Chen <l.chen@northwind.example>",
    to: "Priya Nair <priya.nair@northwind.example>",
    date: "Fri, 20 Sep 2024 10:00:00 +0500",
    subject: "Re: Invoice totals after 4.12",
    body: "We will ship the fix in the Sep 24 release. I am on leave from today until Oct 2.",
    messageId: "<m1@meridian-software.example>",
  },
  {
    from: "Priya Nair <priya.nair@northwind.example>",
    to: "Marcus Webb <marcus.webb@meridian-software.example>",
    date: "Tue, 24 Sep 2024 09:15:00 +0500",
    subject: "Re: Invoice totals after 4.12",
    body: "Checking in - is the Sep 24 release out? We still see wrong totals.",
    messageId: "<m2@northwind.example>",
    inReplyTo: "<m1@meridian-software.example>",
  },
  {
    from: "Marcus Webb <marcus.webb@meridian-software.example>",
    to: "Priya Nair <priya.nair@northwind.example>",
    date: "Tue, 24 Sep 2024 18:40:00 -0400",
    subject: "Re: Invoice totals after 4.12",
    body: "Build is going out tonight; the invoice fix is included.",
    messageId: "<m3@meridian-software.example>",
    inReplyTo: "<m2@northwind.example>",
  },
  {
    from: "Priya Nair <priya.nair@northwind.example>",
    to: "Marcus Webb <marcus.webb@meridian-software.example>",
    date: "Fri, 27 Sep 2024 08:05:00 +0500",
    subject: "Re: Invoice totals after 4.12",
    body: "Totals are still wrong this morning. Please confirm what went out.",
    messageId: "<m4@northwind.example>",
    inReplyTo: "<m3@meridian-software.example>",
  },
  {
    from: "Priya Nair <priya.nair@northwind.example>",
    to: "Marcus Webb <marcus.webb@meridian-software.example>",
    date: "Sat, 28 Sep 2024 08:10:00 +0500",
    subject: "Re: Invoice totals after 4.12",
    body: "Following up again - our finance team is blocked on this.",
    messageId: "<m5@northwind.example>",
    inReplyTo: "<m3@meridian-software.example>",
  },
  {
    from: "Priya Nair <priya.nair@northwind.example>",
    to: "Marcus Webb <marcus.webb@meridian-software.example>",
    date: "Sun, 29 Sep 2024 09:00:00 +0500",
    subject: "Re: Invoice totals after 4.12",
    body: "Third message with no reply. We need a date for the fix.",
    messageId: "<m6@northwind.example>",
    inReplyTo: "<m3@meridian-software.example>",
  },
  {
    from: "Priya Nair <priya.nair@northwind.example>",
    to: "Marcus Webb <marcus.webb@meridian-software.example>",
    date: "Mon, 30 Sep 2024 07:45:00 +0500",
    subject: "Re: Invoice totals after 4.12",
    body: "Still nothing. Escalating this on our side today.",
    messageId: "<m7@northwind.example>",
    inReplyTo: "<m3@meridian-software.example>",
  },
  {
    from: "Dana Okoro <dana.okoro@meridian-software.example>",
    to: "all@meridian-software.example",
    date: "Mon, 16 Sep 2024 12:00:00 -0400",
    subject: "Reminder: timesheet deadline",
    body: "Please submit timesheets by Friday.",
    messageId: "<m8@meridian-software.example>",
  },
  {
    from: "news@payments-weekly.example",
    to: "Priya Nair <priya.nair@northwind.example>",
    date: "Wed, 18 Sep 2024 06:00:00 +0500",
    subject: "Webinar: billing automation",
    body: "Join our webinar on billing automation.",
    messageId: "<m9@payments-weekly.example>",
  },
  {
    from: "Priya Nair <priya.nair@northwind.example>",
    to: "Marcus Webb <marcus.webb@meridian-software.example>",
    date: "Wed, 18 Sep 2024 11:20:00 +0500",
    subject: "Unrelated: SUP-2231 renewal paperwork",
    body: "Separately, can you confirm the SUP-2231 renewal paperwork status?",
    messageId: "<m10@northwind.example>",
  },
];

const escalationEml = [
  "From: Priya Nair <priya.nair@northwind.example>",
  "To: Marcus Webb <marcus.webb@meridian-software.example>",
  "Date: Tue, 01 Oct 2024 08:30:00 +0500",
  "Subject: Escalation: invoice totals still wrong after 4.12",
  "Message-ID: <m11@northwind.example>",
  "In-Reply-To: <m7@northwind.example>",
  "",
  "As discussed on our call, Meridian carries a contractual SLA on invoice accuracy.",
  "",
  "Totals are still wrong five days after the promised Sep 24 fix, and we have had no reply to four messages.",
  "",
].join("\n");

const slackUsers = {
  U1: { name: "linchen", profile: { real_name: "Lin Chen" } },
  U2: { name: "marcus.webb", profile: { real_name: "Marcus Webb" } },
  U3: { name: "dana.okoro", profile: { real_name: "Dana Okoro" } },
};

const slackChannels = [
  { id: "C1", name: "meridian-billing" },
  { id: "C2", name: "general" },
];

interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  thread_ts?: string;
}

const toEpoch = (iso: string): string => (Date.parse(iso) / 1000).toFixed(6);

const meridianChannel: SlackMessage[] = [
  { ts: toEpoch("2024-09-10T03:10:00.000Z"), user: "U2", text: "4.12 is live on production as of this morning." },
  { ts: toEpoch("2024-09-12T05:10:00.000Z"), user: "U2", text: "Meridian flagged wrong invoice totals; looking at MER-101." },
  {
    ts: toEpoch("2024-09-20T09:00:00.000Z"),
    user: "U1",
    text: "I am on leave until Oct 2. No handoff set up yet for MER-101.",
  },
  {
    ts: toEpoch("2024-09-23T04:30:00.000Z"),
    user: "U2",
    text: "MER-87 timezone change is the cause. Fix targeted at the Sep 24 release.",
  },
  { ts: toEpoch("2024-09-24T16:00:00.000Z"), user: "U2", text: "Sep 24 release is cut; invoice fix included." },
  {
    ts: toEpoch("2024-09-25T09:00:00.000Z"),
    user: "U3",
    text: "QA is still failing on the Sep 24 build; totals are off by a day in test.",
  },
  {
    ts: toEpoch("2024-09-25T09:05:00.000Z"),
    user: "U2",
    text: "Let us keep MER-101 open until QA passes.",
    thread_ts: toEpoch("2024-09-25T09:00:00.000Z"),
  },
  { ts: toEpoch("2024-09-26T02:10:00.000Z"), user: "U2", text: "Marking MER-101 resolved; the fix is in the Sep 24 build." },
  { ts: toEpoch("2024-09-26T02:20:00.000Z"), user: "U3", text: "It is not in the build I tested, but ok." },
  { ts: toEpoch("2024-09-30T08:00:00.000Z"), user: "U2", text: "Has anyone heard back from Northwind about the totals?" },
  { ts: toEpoch("2024-09-14T15:00:00.000Z"), user: "U3", text: "Coffee machine on floor 3 is fixed." },
];

const generalChannel: SlackMessage[] = [
  { ts: toEpoch("2024-09-09T08:00:00.000Z"), user: "U3", text: "Reminder: standup moves to 9:30 this week." },
  { ts: toEpoch("2024-09-11T12:00:00.000Z"), user: "U2", text: "Lunch order closes at noon." },
  { ts: toEpoch("2024-09-13T10:00:00.000Z"), user: "U2", text: "Who has the release checklist template?" },
  { ts: toEpoch("2024-09-17T09:00:00.000Z"), user: "U3", text: "New coffee machine is great." },
  { ts: toEpoch("2024-09-19T14:00:00.000Z"), user: "U2", text: "Reminder to file expenses for the offsite." },
  { ts: toEpoch("2024-09-30T16:00:00.000Z"), user: "U3", text: "All-hands moved to Thursday." },
];

function toMbox(mails: MailSpec[]): string {
  return mails
    .map((mail) => {
      const lines = [
        `From ${mail.from} ${mail.date}`,
        `From: ${mail.from}`,
        `To: ${mail.to}`,
        `Date: ${mail.date}`,
        `Subject: ${mail.subject}`,
        `Message-ID: ${mail.messageId}`,
      ];
      if (mail.inReplyTo) lines.push(`In-Reply-To: ${mail.inReplyTo}`);
      lines.push(`Content-Type: text/plain; charset=utf-8`, "", mail.body, "");
      return lines.join("\n");
    })
    .join("\n");
}

export function buildDemoFiles(): DemoFile[] {
  const files: DemoFile[] = [
    { name: "jira-meridian.json", content: JSON.stringify(jira, null, 2) },
    { name: "northwind-emails.mbox", content: toMbox(mails) },
    { name: "escalation.eml", content: escalationEml },
    { name: "slack/users.json", content: JSON.stringify(slackUsers, null, 2) },
    { name: "slack/channels.json", content: JSON.stringify(slackChannels, null, 2) },
    {
      name: "slack/meridian-billing/messages.json",
      content: JSON.stringify(meridianChannel, null, 2),
    },
    { name: "slack/general/messages.json", content: JSON.stringify(generalChannel, null, 2) },
  ];

  files.push({
    name: "manifest.json",
    content: JSON.stringify({ files: files.map((file) => file.name) }, null, 2),
  });

  return files;
}

async function main(): Promise<void> {
  const outDir = path.resolve(process.cwd(), "public/demo");
  mkdirSync(outDir, { recursive: true });

  for (const file of buildDemoFiles()) {
    const target = path.join(outDir, file.name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content, "utf8");
  }

  console.log(`wrote ${buildDemoFiles().length} demo files to public/demo`);
}

if (process.argv[1]?.endsWith("gen-demo.ts")) {
  void main();
}
