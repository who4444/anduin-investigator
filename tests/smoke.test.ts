import { describe, expect, it } from "vitest";

import { GET } from "../app/api/health/route";

describe("GET /api/health", () => {
  it("returns { ok: true } as JSON", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
