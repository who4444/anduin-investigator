import type { NextRequest } from "next/server";

import type { IngestFile } from "@/lib/ingest/detect";
import { ingestFiles } from "@/lib/ingest/run";
import { getSource } from "@/lib/sources";

export const maxDuration = 60;

const ESCALATION_TEXT_LIMIT = 4000;
const TITLE_LIMIT = 200;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const sourceId = typeof body.source === "string" ? body.source : "";
  const source = getSource(sourceId);
  if (!source) return json({ error: `Unknown source: ${sourceId || "(missing)"}.` }, 404);

  if (!source.isConfigured()) {
    return json(
      {
        error: `${source.label} is not configured. Add ${source.missingEnv().join(", ")} to the environment.`,
        missingEnv: source.missingEnv(),
      },
      409,
    );
  }

  const targets = Array.isArray(body.targets)
    ? body.targets.filter((target): target is string => typeof target === "string" && target.length > 0)
    : [];
  if (targets.length === 0 && source.id !== "gmail") {
    return json({ error: "Select at least one target to pull." }, 400);
  }

  const query = typeof body.query === "string" ? body.query.slice(0, 2000) : undefined;
  const escalation = typeof body.escalation === "string" ? body.escalation.slice(0, ESCALATION_TEXT_LIMIT) : "";
  const title = typeof body.title === "string" ? body.title.slice(0, TITLE_LIMIT) : "";

  let pulled: { files: { name: string; content: string }[]; warnings: string[] };
  try {
    pulled = await source.pull(targets, query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: `${source.label} pull failed: ${message}` }, 502);
  }

  if (pulled.files.length === 0) {
    return json(
      {
        error: pulled.warnings[0] ?? `No data was returned by ${source.label}.`,
        warnings: pulled.warnings,
      },
      400,
    );
  }

  const files: IngestFile[] = pulled.files.map((file) => ({
    name: file.name,
    bytes: new TextEncoder().encode(file.content),
  }));

  const result = await ingestFiles({
    files,
    escalation,
    title: title || undefined,
    contentHash: `pull:${source.id}:${targets.join(",")}:${query ?? ""}`,
    warnings: pulled.warnings,
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
      source: source.id,
    },
    201,
  );
}
