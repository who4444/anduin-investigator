import type { NextRequest } from "next/server";

import { readId, readInvestigationOrDefault } from "@/lib/api/pipeline";
import { getStages } from "@/lib/store";

export const maxDuration = 60;

const POLL_MS = 900;
const STREAM_LIFETIME_MS = 55_000;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const id = await readId(context.params);
  const found = await readInvestigationOrDefault(id);
  if ("response" in found) return found.response;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let last = "";
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const tick = async () => {
        try {
          const stages = await getStages(id);
          const fingerprint = JSON.stringify(stages);
          if (fingerprint !== last) {
            last = fingerprint;
            send("stages", stages);
          }
        } catch {
          // Transient database errors just skip this tick.
        }
      };

      const interval = setInterval(() => void tick(), POLL_MS);
      const lifetime = setTimeout(() => {
        clearInterval(interval);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      }, STREAM_LIFETIME_MS);

      request.signal.addEventListener("abort", () => {
        clearInterval(interval);
        clearTimeout(lifetime);
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            // Already closed.
          }
        }
      });

      send("hello", { investigationId: id });
      void tick();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
