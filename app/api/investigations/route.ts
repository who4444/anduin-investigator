import { createHash } from "node:crypto";

import type { NextRequest } from "next/server";

import { detectFile, expandArchives, type IngestFile } from "@/lib/ingest/detect";
import { parseEml, parseMbox } from "@/lib/ingest/email";
import { resolveIdentities } from "@/lib/ingest/identity";
import { parseJira } from "@/lib/ingest/jira";
import { capText, dedupeEvents, eventId, toUtcIso } from "@/lib/ingest/normalize";
import { extractTicketRefs } from "@/lib/ingest/refs";
import { parseSlackFiles, type SlackFile } from "@/lib/ingest/slack";
import { getLlmClient } from "@/lib/llm";
import {
  createInvestigation,
  deleteInvestigation,
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

function withRefs(event: EventInput): EventInput {
  const refs = new Set([...(event.refs ?? []), ...extractTicketRefs(event.text)]);
  return refs.size > 0 ? { ...event, refs: [...refs] } : event;
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

async function collectEvents(
  files: IngestFile[],
  warnings: string[],
): Promise<EventInput[]> {
  const events: EventInput[] = [];
  const slackFiles: SlackFile[] = [];
  const emails: { name: string; bytes: Uint8Array; eml: boolean }[] = [];
  const kinds = new Map<string, number>();

  for (const file of files) {
    const { kind, json } = detectFile(file);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    switch (kind) {
      case "jira": {
        const { events: jiraEvents } = parseJira(json);
        if (jiraEvents.length === 0) warnings.push(`No events parsed from ${file.name}`);
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
    if (slackEvents.length === 0 && (kinds.get("slack-messages") ?? 0) > 0) {
      warnings.push("No Slack messages parsed from the uploaded export.");
    }
    events.push(...slackEvents);
  }

  const normalized: EventInput[] = [];
  let invalidTs = 0;
  for (const event of events) {
    const ts = toUtcIso(event.ts);
    if (!ts) {
      invalidTs += 1;
      continue;
    }
    normalized.push(withRefs({ ...event, ts, text: capText(event.text) }));
  }
  if (invalidTs > 0) {
    warnings.push(`${invalidTs} event(s) had unusable timestamps and were skipped.`);
  }

  return normalized;
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
    const expanded = expandArchives(uploads, { warnings });
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

    const dedupedUpload = dedupeEvents(collected);

    const investigationId = await createInvestigation({
      title: resolveTitle(form, dedupedUpload, escalation),
      escalationText: escalation,
      contentHash: hash,
    });

    let storedCount: number;
    try {
      const resolved = await resolveIdentities(dedupedUpload, getLlmClient(), {
        upsertIdentity: (row) => upsertIdentity(investigationId, row),
      });

      const finalEvents = dedupeEvents(resolved);
      const withIds = finalEvents.map((event) => ({
        ...event,
        id: eventId(event.source, event.ts, event.actor, event.channel, event.text),
      }));

      if (withIds.length > MAX_EVENT_COUNT) {
        warnings.push(
          `Parsed ${withIds.length} events; only the first ${MAX_EVENT_COUNT} are stored.`,
        );
      }

      storedCount = Math.min(withIds.length, MAX_EVENT_COUNT);
      await insertEvents(investigationId, withIds.slice(0, MAX_EVENT_COUNT));
      await upsertStage(investigationId, "ingest", 1, "done");
    } catch (error) {
      await deleteInvestigation(investigationId).catch(() => {
        // Best-effort cleanup; the original failure is reported below.
      });
      throw error;
    }

    return json(
      {
        investigationId,
        eventCount: storedCount,
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
