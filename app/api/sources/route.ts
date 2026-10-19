import type { NextRequest } from "next/server";

import { getSource, getSources } from "@/lib/sources";
import { cleanQuery } from "@/lib/sources/types";

export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/** The landing page's connection line: what each source will search by default. */
function sourceDetail(source: { id: string; isConfigured(): boolean }): string {
  if (!source.isConfigured()) return "not connected";
  if (source.id === "gmail") {
    const query = cleanQuery(process.env.GMAIL_QUERY);
    return query ? `mail: ${query}` : "connected — add a mailbox filter under Advanced";
  }
  return "searching everything you have access to";
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
        detail: sourceDetail(source),
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
