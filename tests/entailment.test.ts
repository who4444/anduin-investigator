import { describe, expect, it, vi } from "vitest";

import type { ChatMessage, LlmClient } from "../lib/llm";
import {
  judgeEntailment,
  parseEntailment,
  runEntailmentLayer,
} from "../lib/pipeline/entailment";

function fakeClient(respond: (messages: ChatMessage[]) => string): LlmClient {
  return {
    chat: async (messages) => ({ content: respond(messages) }),
  };
}

describe("parseEntailment", () => {
  it("parses a yes", () => {
    expect(parseEntailment('{"supports":"yes"}')).toBe("supports");
  });

  it("parses a no case-insensitively", () => {
    expect(parseEntailment('{"supports":"NO"}')).toBe("refutes");
  });

  it("parses a partial", () => {
    expect(parseEntailment('{"supports":"partial"}')).toBe("partial");
  });

  it("parses a fenced json block", () => {
    expect(parseEntailment('```json\n{"supports":"yes"}\n```')).toBe("supports");
  });

  it("parses a boolean supports flag", () => {
    expect(parseEntailment('{"supports":true}')).toBe("supports");
    expect(parseEntailment('{"supports":false}')).toBe("refutes");
  });

  it("returns null for unparseable content", () => {
    expect(parseEntailment("I think it probably does")).toBeNull();
    expect(parseEntailment("")).toBeNull();
    expect(parseEntailment('{"supports":"maybe"}')).toBeNull();
  });
});

describe("judgeEntailment", () => {
  it("sends only the claim text and the quote", async () => {
    let userContent = "";
    const client = fakeClient((messages) => {
      userContent = messages[1]?.content ?? "";
      return '{"supports":"yes"}';
    });

    const verdict = await judgeEntailment(
      client,
      { text: "Ravi promised the fix for the September release.", quote: "fix would ship in September" },
    );

    expect(verdict.verdict).toBe("supports");
    expect(userContent).toContain("Ravi promised the fix for the September release.");
    expect(userContent).toContain("fix would ship in September");
    expect(userContent).not.toMatch(/claimId|event_?id|confidence|0\.\d/);
  });

  it("returns unavailable with the error when the client throws", async () => {
    const client: LlmClient = {
      chat: async () => {
        throw new Error("api down");
      },
    };
    const verdict = await judgeEntailment(client, { text: "a", quote: "b" });
    expect(verdict).toEqual({ verdict: "unavailable", error: "error" });
  });

  it("returns unavailable with timeout when the call hangs", async () => {
    vi.useFakeTimers();
    const client: LlmClient = {
      chat: () => new Promise(() => {}),
    };
    const pending = judgeEntailment(client, { text: "a", quote: "b" }, { timeoutMs: 50 });
    await vi.advanceTimersByTimeAsync(60);
    const verdict = await pending;
    vi.useRealTimers();
    expect(verdict).toEqual({ verdict: "unavailable", error: "timeout" });
  });

  it("returns unavailable with unparsable when the answer is junk", async () => {
    const client = fakeClient(() => "probably?");
    const verdict = await judgeEntailment(client, { text: "a", quote: "b" });
    expect(verdict).toEqual({ verdict: "unavailable", error: "unparsable" });
  });
});

describe("runEntailmentLayer", () => {
  const items = Array.from({ length: 5 }, (_, index) => ({
    claimId: `c_${index}`,
    text: `claim ${index}`,
    quote: `quote ${index}`,
  }));

  it("judges every claim and reports reviewed counts", async () => {
    const client = fakeClient((messages) =>
      (messages[1]?.content ?? "").includes("claim 3") ? '{"supports":"no"}' : '{"supports":"yes"}',
    );

    const outcome = await runEntailmentLayer(items, {
      client,
      concurrency: 2,
      perCallTimeoutMs: 1000,
      totalBudgetMs: 10_000,
    });

    expect(outcome.reviewed).toBe(5);
    expect(outcome.unavailable).toBe(0);
    expect(outcome.results.get("c_3")).toEqual({ verdict: "refutes" });
    expect(outcome.results.get("c_0")).toEqual({ verdict: "supports" });
  });

  it("stops calling the model once the total budget is exhausted", async () => {
    const chat = vi.fn(async () => ({ content: '{"supports":"yes"}' }));
    const outcome = await runEntailmentLayer(items, {
      client: { chat },
      concurrency: 1,
      perCallTimeoutMs: 1000,
      totalBudgetMs: -1,
    });

    expect(chat).not.toHaveBeenCalled();
    expect(outcome.reviewed).toBe(0);
    expect(outcome.unavailable).toBe(5);
    expect(outcome.results.get("c_0")).toEqual({
      verdict: "unavailable",
      error: "budget_exhausted",
    });
  });
});
