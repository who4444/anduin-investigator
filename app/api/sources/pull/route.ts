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

interface PullRequest {
  source: string;
  targets: string[];
  query?: string;
}

function readRequests(body: Record<string, unknown>): PullRequest[] | { error: string } {
  if (Array.isArray(body.sources)) {
    const requests: PullRequest[] = [];
    for (const raw of body.sources) {
      if (typeof raw !== "object" || raw === null) continue;
      const entry = raw as Record<string, unknown>;
      if (typeof entry.source !== "string") continue;
      requests.push({
        source: entry.source,
        targets: Array.isArray(entry.targets)
          ? entry.targets.filter((target): target is string => typeof target === "string")
          : [],
        query: typeof entry.query === "string" && entry.query.trim().length > 0 ? entry.query : undefined,
      });
    }
    if (requests.length === 0) return { error: "Select at least one source to pull." };
    return requests;
  }

  if (typeof body.source === "string") {
    return [
      {
        source: body.source,
        targets: Array.isArray(body.targets)
          ? body.targets.filter((target): target is string => typeof target === "string")
          : [],
        query: typeof body.query === "string" && body.query.trim().length > 0 ? body.query : undefined,
      },
    ];
  }

  return { error: "Expected { sources: [...] }." };
}

export async function POST(request: NextRequest): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Expected a JSON body." }, 400);
  }

  const requests = readRequests(body);
  if ("error" in requests) return json({ error: requests.error }, 400);

  const escalation = typeof body.escalation === "string" ? body.escalation.slice(0, ESCALATION_TEXT_LIMIT) : "";
  const title = typeof body.title === "string" ? body.title.slice(0, TITLE_LIMIT) : "";
  const declaredClient =
    typeof body.client === "string" ? body.client.replace(/\s+/g, " ").trim().slice(0, 200) : "";

  const files: IngestFile[] = [];
  const warnings: string[] = [];
  const hashParts: string[] = [];

  for (const pullRequest of requests) {
    const source = getSource(pullRequest.source);
    if (!source) return json({ error: `Unknown source: ${pullRequest.source}.` }, 404);
    if (!source.isConfigured()) {
      return json(
        {
          error: `${source.label} is not configured. Add ${source.missingEnv().join(", ")} to the environment.`,
          missingEnv: source.missingEnv(),
        },
        409,
      );
    }
    if (pullRequest.targets.length === 0 && source.id !== "gmail") {
      return json({ error: `Select at least one ${source.label} scope to pull.` }, 400);
    }

    let pulled: { files: { name: string; content: string }[]; warnings: string[] };
    try {
      pulled = await source.pull(pullRequest.targets, pullRequest.query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: `${source.label} pull failed: ${message}` }, 502);
    }

    for (const file of pulled.files) {
      files.push({ name: file.name, bytes: new TextEncoder().encode(file.content) });
    }
    warnings.push(...pulled.warnings);
    hashParts.push(`${source.id}:${pullRequest.targets.join(",")}:${pullRequest.query ?? ""}`);
  }

  if (files.length === 0) {
    return json(
      { error: warnings[0] ?? "No data was returned by the selected sources.", warnings },
      400,
    );
  }

  const result = await ingestFiles({
    files,
    escalation,
    title: title || undefined,
    contentHash: `pull:${[declaredClient, ...hashParts].filter(Boolean).join("|")}`,
    warnings,
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
      source: requests.length === 1 ? requests[0].source : "multiple",
    },
    201,
  );
}
