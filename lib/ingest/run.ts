import { detectFile, expandArchives, type IngestFile } from "./detect";
import { parseEml, parseMbox } from "./email";
import { resolveIdentities } from "./identity";
import { parseJira } from "./jira";
import { capText, dedupeEvents, eventId, toUtcIso } from "./normalize";
import { extractTicketRefs } from "./refs";
import { parseSlackFiles, type SlackFile } from "./slack";
import { getLlmClient } from "../llm";
import {
  createInvestigation,
  deleteInvestigation,
  insertEvents,
  setIngestWarnings,
  upsertIdentity,
  upsertStage,
} from "../store";
import type { EventInput } from "../types";

export const MAX_EVENT_COUNT = 600;
const TITLE_LIMIT = 200;

export interface IngestFilesInput {
  files: IngestFile[];
  escalation: string;
  title?: string;
  contentHash?: string;
  warnings?: string[];
  declaredClient?: string | null;
  origin?: "upload" | "pull" | "demo";
}

export type IngestFilesResult =
  | { ok: true; investigationId: string; eventCount: number; warnings: string[] }
  | { ok: false; status: number; error: string; warnings: string[] };

function withRefs(event: EventInput): EventInput {
  const refs = new Set([...(event.refs ?? []), ...extractTicketRefs(event.text)]);
  return refs.size > 0 ? { ...event, refs: [...refs] } : event;
}

async function collectEvents(files: IngestFile[], warnings: string[]): Promise<EventInput[]> {
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
      warnings.push("No Slack messages parsed from the supplied data.");
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

function resolveTitle(provided: string | undefined, events: EventInput[], escalation: string): string {
  const explicit = provided?.trim();
  if (explicit) return explicit.slice(0, TITLE_LIMIT);

  const jiraSummary = events.find((event) => event.source === "jira" && event.text.length > 0);
  if (jiraSummary && jiraSummary.channel) {
    return `${jiraSummary.channel}: ${jiraSummary.text.slice(0, 120)}`;
  }

  const firstLine = escalation.split("\n")[0].trim();
  if (firstLine) return firstLine.slice(0, TITLE_LIMIT);

  return `Investigation ${new Date().toISOString().slice(0, 10)}`;
}

export async function ingestFiles(input: IngestFilesInput): Promise<IngestFilesResult> {
  const warnings = [...(input.warnings ?? [])];

  let expanded: IngestFile[];
  try {
    expanded = expandArchives(input.files, { warnings });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, error: `Could not read the supplied files: ${message}`, warnings };
  }

  if (expanded.length === 0) {
    return { ok: false, status: 400, error: "Archive contained no readable files.", warnings };
  }

  let collected: EventInput[];
  try {
    collected = await collectEvents(expanded, warnings);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, error: `Parsing failed: ${message}`, warnings };
  }

  if (collected.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "No events could be parsed from the supplied data.",
      warnings,
    };
  }

  const dedupedUpload = dedupeEvents(collected);

  let investigationId: string;
  try {
    investigationId = await createInvestigation({
      title: resolveTitle(input.title, dedupedUpload, input.escalation),
      escalationText: input.escalation,
      contentHash: input.contentHash ?? "",
      declaredClient: input.declaredClient ?? null,
      origin: input.origin,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, error: `Could not create the investigation: ${message}`, warnings };
  }

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
      warnings.push(`Parsed ${withIds.length} events; only the first ${MAX_EVENT_COUNT} are stored.`);
    }

    await insertEvents(investigationId, withIds.slice(0, MAX_EVENT_COUNT));
    // Persist the ingest disclosures so no report outlives a silently
    // truncated evidence set.
    await setIngestWarnings(investigationId, warnings);
    await upsertStage(investigationId, "ingest", 1, "done");

    return {
      ok: true,
      investigationId,
      eventCount: Math.min(withIds.length, MAX_EVENT_COUNT),
      warnings,
    };
  } catch (error) {
    await deleteInvestigation(investigationId).catch(() => {
      // Best-effort cleanup; the original failure is reported below.
    });
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 500, error: message, warnings };
  }
}
