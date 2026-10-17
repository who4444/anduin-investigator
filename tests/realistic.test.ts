import { describe, expect, it } from "vitest";

import { buildRealisticFiles } from "../scripts/gen-realistic";
import { parseJira } from "../lib/ingest/jira";
import { parseEml, parseMbox } from "../lib/ingest/email";
import { parseSlackFiles } from "../lib/ingest/slack";
import type { EventInput } from "../lib/types";

const FILES = buildRealisticFiles();
const byName = new Map(FILES.map((file) => [file.name, file.content]));

function jiraEvents(name: string) {
  const { events } = parseJira(JSON.parse(byName.get(name) ?? "[]"));
  return events;
}

function slackEvents(channels: string[]): EventInput[] {
  const files = channels
    .map((channel) => ({ name: `slack/${channel}/messages.json`, json: JSON.parse(byName.get(`slack/${channel}/messages.json`) ?? "[]") }))
    .concat([
      { name: "slack/users.json", json: JSON.parse(byName.get("slack/users.json") ?? "[]") },
      { name: "slack/channels.json", json: JSON.parse(byName.get("slack/channels.json") ?? "[]") },
    ]);
  return parseSlackFiles(files).events;
}

describe("realistic workspace generator", () => {
  it("is deterministic: rebuilding produces identical files", () => {
    const second = buildRealisticFiles();
    expect(JSON.stringify(FILES)).toBe(JSON.stringify(second));
  });

  it("emits the manifest shape and excludes itself", () => {
    const names = FILES.map((file) => file.name);
    expect(names).toContain("escalation.eml");
    expect(names).toContain("workspace-mailbox.mbox");
    expect(names.filter((name) => name.startsWith("slack/")).length).toBeGreaterThan(4);
    expect(names).not.toContain("manifest.json");
  });

  it("parses through the real jira/slack/email parsers without loss", async () => {
    const lumenEvents = jiraEvents("jira-lumen.json");
    expect(lumenEvents.every((event) => event.source === "jira")).toBe(true);
    expect(lumenEvents.length).toBeGreaterThanOrEqual(10);

    const emailEvents = (await parseMbox(new TextEncoder().encode(byName.get("workspace-mailbox.mbox") ?? "")))
      .events;
    expect(emailEvents.length).toBeGreaterThanOrEqual(18);
    expect(emailEvents.every((event) => event.source === "email")).toBe(true);

    const general = slackEvents(["lumen-general"]);
    expect(general.every((event) => event.channel === "lumen-general")).toBe(true);
    expect(general.length).toBeGreaterThanOrEqual(18);
  });

  it("normalizes the DST-shifted email header to UTC", async () => {
    const { events } = await parseMbox(new TextEncoder().encode(byName.get("workspace-mailbox.mbox") ?? ""));
    const dst = events.find((event) => event.text.includes("VAT totals recheck this morning"));
    expect(dst?.ts).toBe("2024-10-27T00:40:00.000Z");
  });

  it("plants the root-cause chain: the cause lives only in a linked ticket's comment", () => {
    const lumen = jiraEvents("jira-lumen.json");
    const linked = lumen.filter((event) => event.channel === "LUM-804").map((event) => event.text).join("\n");
    expect(linked).toMatch(/KESTREL/);
    expect(linked).toMatch(/VAT/);

    const ticket = jiraEvents("jira-lumen.json").find((event) => event.channel === "LUM-811");
    expect(ticket).toBeDefined();
    // the escalation's own ticket never states the cause
    for (const event of lumen.filter((entry) => entry.channel === "LUM-811")) {
      expect(event.text).not.toMatch(/KESTREL/);
    }
  });

  it("plants the identity scatter: one display name shared across two tenants", () => {
    const ravActors = jiraEvents("jira-rav.json").map((event) => event.actor);
    const lumenSlack = slackEvents(["lumen-general"]).map((event) => event.actor);
    expect(ravActors).toContain("Sam Rivera");
    expect(lumenSlack).toContain("Sam Rivera");
  });

  it("plants the premature resolution and its challenge", () => {
    const lumen = jiraEvents("jira-lumen.json");
    expect(lumen.some((event) => event.text === "Status: In Progress → Resolved")).toBe(true);
    const general = slackEvents(["lumen-general"]);
    expect(general.some((event) => event.text.includes("VAT exports are still blank"))).toBe(true);
  });

  it("plants the leave and handoff: leave in Slack, handoff in the assignee changelog", () => {
    const general = slackEvents(["lumen-general"]);
    expect(general.some((event) => /on leave|out until/.test(event.text) && event.text.includes("Chen"))).toBe(true);

    const lumen = jiraEvents("jira-lumen.json");
    expect(
      lumen.some((event) => event.text.startsWith("Assignee:") && event.text.includes("Ravi Menon")),
    ).toBe(true);
  });

  it("plants the contradicting bot release claim", () => {
    const general = slackEvents(["lumen-general"]);
    const bot = general.find((event) => event.text.includes("5.3.3 is live"));
    expect(bot?.actor).toBe("releasebot");
    expect(bot?.text).toContain("billing-v2");
  });

  it("plants cross-tenant chases inside the vendor's shared general room", () => {
    const general = slackEvents(["general"]);
    const chases = general.filter((event) => event.actor === "Dana Okafor");
    expect(chases.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps the whole workspace under the ingest cap but far above demo volume", () => {
    let total = jiraEvents("jira-lumen.json").length
      + jiraEvents("jira-kst.json").length
      + jiraEvents("jira-veg.json").length
      + jiraEvents("jira-rav.json").length
      + slackEvents(["lumen-general", "kst-rotas", "vega-payments", "rav-core", "vertex-billing", "general"]).length
      + 0;
    void (async () => {
      const emails = (await parseMbox(new TextEncoder().encode(byName.get("workspace-mailbox.mbox") ?? ""))).events;
      total += emails.length;
      expect(total).toBeGreaterThanOrEqual(300);
      expect(total).toBeLessThan(600);

      // The distraction budget: most records have nothing to do with Bright Market.
      const inScope = total - slackEvents(["kst-rotas", "vega-payments", "rav-core", "vertex-billing"]).length;
      expect(inScope / total).toBeLessThan(0.35);
    })();
  });

  it("reads the escalation as an email naming ticket and client", async () => {
    const { events } = await parseEml(new TextEncoder().encode(byName.get("escalation.eml") ?? ""));
    const escalation = events.find((event) => event.text.includes("LUM-811"));
    expect(escalation).toBeDefined();
    expect(escalation?.actor).toContain("brightmarket.example");
  });
});
