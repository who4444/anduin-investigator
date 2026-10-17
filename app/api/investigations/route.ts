import { createHash } from "node:crypto";

import type { NextRequest } from "next/server";

import type { IngestFile } from "@/lib/ingest/detect";
import { ingestFiles } from "@/lib/ingest/run";
import { findInvestigationByHash, getStages } from "@/lib/store";

export const maxDuration = 60;

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;
const ESCALATION_TEXT_LIMIT = 4000;
const UNDEFINED_TABLE = "42P01";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function contentHash(files: IngestFile[], escalation: string, declaredClient: string): string {
  const hash = createHash("sha1");
  hash.update(escalation);
  hash.update("\0");
  hash.update(declaredClient);
  hash.update("\0");
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
  const declaredClient = String(form.get("client") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const hash = contentHash(uploads, escalation, declaredClient);

  try {
    const existing = await findInvestigationByHash(hash);
    if (existing) {
      const stages = await getStages(existing.id);
      if (stages.some((stage) => stage.stage === "assemble" && stage.status === "done")) {
        return json({ investigationId: existing.id, eventCount: 0, cached: true, warnings: [] });
      }
    }

    const result = await ingestFiles({
      files: uploads,
      escalation,
      title: String(form.get("title") ?? ""),
      contentHash: hash,
      declaredClient,
    });

    if (!result.ok) {
      return json({ error: result.error, warnings: result.warnings }, result.status);
    }

    return json(
      {
        investigationId: result.investigationId,
        eventCount: result.eventCount,
        cached: false,
        warnings: result.warnings,
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
