export const maxDuration = 60;

export async function GET(): Promise<Response> {
  return Response.json({ ok: true });
}
