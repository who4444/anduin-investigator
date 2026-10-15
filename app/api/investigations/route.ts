import { createHash } from "node:crypto";

import type { NextRequest } from "next/server";

import { detectFile, expandArchives, type IngestFile } from "@/lib/ingest/detect";
import { parseEml, parseMbox } from "@/lib/ingest/email";
import { resolveIdentities } from "@/lib/ingest/identity";
import { parseJira } from "@/lib/ingest/jira";
import { capText, dedupeEvents, eventId } from "@/lib/ingest/normalize";
import { extractTicketRefs } from "@/lib/ingest/refs";
import { parseSlackFiles, type SlackFile } from "@/lib/ingest/slack";
import { getLlmClient } from "@/lib/llm";
import {
  createInvestigation,
  findInvestigationByHash,
  getStages,
  insertEvents,
  upsertIdentity,
  upsertStage,
} from "@/lib/store";
import type { EventInput } from "@/lib/types";

export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const MAX_EVENT_COUNT = 600;
const ESCALATION_TEXT_LIMIT = 4000;
const TITLE_LIMIT = 200;
const UNDEFINED_TABLE = "42P01";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function toUtcIso(ts: string): string {
  const parsed = new Date(ts);
  return Number.isNaN(parsed.getTime()) ? ts : parsed.toISOString();
}

function withRefs(event: EventInput): EventInput {
  const refs = new Set([...(event.refs ?? []), ...extractTicketRefs(event.text)]);
  return refs.size > 0 ? { ...event, refs: [...refs] } : event;
}

function normalizeEvent(event: EventInput): EventInput {
  return withRefs({ ...event, ts: toUtcIso(event.ts), text: capText(event.text) });
}

function contentHash(files: IngestFile[]): string {
  const hash = createHash("sha1");
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    hash.update(file.name);
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function readFiles(form: FormData): Promise<IngestFile[]> {
  const entries = form.getAll("files").filter((value): value is File => value instanceof File);
  return Promise.all(
    entries.map(async (file) => ({
      name: file.name,
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
}

async function collectEvents(files: IngestFile[], warnings: string[]): Promise<EventInput[]> {
  const events: EventInput[] = [];
  const slackFiles: SlackFile[] = [];
  const emails: { name: string; bytes: Uint8Array; eml: boolean }[] = [];

  for (const file of files) {
    const { kind, json } = detectFile(file);
    switch (kind) {
      case "jira": {
        const { events: jiraEvents } = parseJira(json);
        events.push(...jiraEvents);
        break;
      }
      case "email-mbox":
      case "email-eml":
        emails.push({ name: file.name, bytes: file.bytes, eml: kind === "email-eml" });
        break;
      case "slack-users":
      case "slack-channels":
      case "slack-messages":
        slackFiles.push({ name: file.name, json });
        break;
      default:
        warnings.push(`Ignored unrecognised file: ${file.name}`);
    }
  }

  for (const email of emails) {
    const parsed = email.eml ? await parseEml(email.bytes) : await parseMbox(email.bytes);
    if (parsed.events.length === 0) warnings.push(`No messages parsed from ${email.name}`);
    events.push(...parsed.events);
  }

  if (slackFiles.length > 0) {
    const { events: slackEvents } = parseSlackFiles(slackFiles);
    events.push(...slackEvents);
  }

  return events.map(normalizeEvent);
}

function resolveTitle(form: FormData, events: EventInput[], escalation: string): string {
  const provided = String(form.get("title") ?? "").trim();
  if (provided) return provided.slice(0, TITLE_LIMIT);

  const jiraSummary = events.find((event) => event.source === "jira" && event.text.length > 0);
  if (jiraSummary && jiraSummary.channel) return `${jiraSummary.channel}: ${jiraSummary.text.slice(0, 120)}`;

  const firstLine = escalation.split("\n")[0].trim();
  if (firstLine) return firstLine.slice(0, TITLE_LIMIT);

  return `Investigation ${new Date().toISOString().slice(0, 10)}`;
}

export async function POST(request: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json({ error: "Expected a multipart form upload." }, 400);
  }

  const uploads = await readFiles(form);
  if (uploads.length === 0) {
    return json({ error: "No files uploaded. Attach Jira JSON, an mbox/eml, or a Slack export." }, 400);
  }

  const totalBytes = uploads.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  if (totalBytes > MAX_UPLOAD_BYTES) {
    return json({ error: `Upload too large (${totalBytes} bytes). Keep it under 8 MB.` }, 400);
  }

  const escalation = String(form.get("escalation") ?? "").slice(0, ESCALATION_TEXT_LIMIT);
  const hash = contentHash(uploads);

  try {
    const existing = await findInvestigationByHash(hash);
    if (existing) {
      const stages = await getStages(existing.id);
      if (stages.some((stage) => stage.stage === "assemble" && stage.status === "done")) {
        return json({ investigationId: existing.id, eventCount: 0, cached: true, warnings: [] });
      }
    }

    const warnings: string[] = [];
    const expanded = expandArchives(uploads);
    if (expanded.length === 0) {
      return json({ error: "Archive contained no readable files." }, 400);
    }

    const collected = await collectEvents(expanded, warnings);
    if (collected.length === 0) {
      return json(
        { error: "No events could be parsed from the uploaded files.", warnings },
        400,
      );
    }

    const investigationId = await createInvestigation({
      title: resolveTitle(form, collected, escalation),
      escalationText: escalation,
      contentHash: hash,
    });

    const resolved = await resolveIdentities(collected, getLlmClient(), {
      upsertIdentity: (row) => upsertIdentity(investigationId, row),
    });

    const perInvestigationDedupe = dedupeEvents(resolved);
    const withIds = perInvestigationDedupe.map((event) => ({
      ...event,
      id: eventId(event.source, event.ts, event.actor, event.channel, event.text),
    }));

    if (withIds.length > MAX_EVENT_COUNT) {
      warnings.push(
        `Parsed ${withIds.length} events; only the first ${MAX_EVENT_COUNT} are stored.`,
      );
    }

    await insertEvents(investigationId, withIds.slice(0, MAX_EVENT_COUNT));
    await upsertStage(investigationId, "ingest", 1, "done");

    return json(
      {
        investigationId,
        eventCount: Math.min(withIds.length, MAX_EVENT_COUNT),
        cached: false,
        warnings,
      },
      201,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(UNDEFINED_TABLE) || /relation .* does not exist/i.test(message)) {
      return json({ error: "Database not initialised. Run `npm run db:migrate` first." }, 500);
    }
    return json({ error: `Ingest failed: ${message}` }, 500);
  }
}
