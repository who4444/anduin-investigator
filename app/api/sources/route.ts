import type { NextRequest } from "next/server";

import { getSource, getSources } from "@/lib/sources";

export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function GET(request: NextRequest): Promise<Response> {
  const targetSource = request.nextUrl.searchParams.get("targets");

  if (!targetSource) {
    return json({
      sources: getSources().map((source) => ({
        id: source.id,
        label: source.label,
        envKeys: source.envKeys,
        configured: source.isConfigured(),
        missingEnv: source.missingEnv(),
      })),
    });
  }

  const source = getSource(targetSource);
  if (!source) return json({ error: `Unknown source: ${targetSource}.` }, 404);
  if (!source.isConfigured()) {
    return json(
      { error: `${source.label} is not configured. Missing env: ${source.missingEnv().join(", ")}.`, missingEnv: source.missingEnv() },
      409,
    );
  }

  const query = request.nextUrl.searchParams.get("query") ?? undefined;

  try {
    const targets = await source.listTargets(query);
    return json({ targets });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ error: message }, 502);
  }
}
