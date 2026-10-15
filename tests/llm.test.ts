import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LlmError,
  createLlmClient,
  getLlmClient,
  runToolLoop,
  setLlmClientForTests,
  type LlmClient,
  type ToolSpec,
} from "../lib/llm";

function jsonResponse(payload: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

const tools: ToolSpec[] = [
  {
    type: "function",
    function: {
      name: "search_events",
      description: "Search the event store",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  },
];

const toolCallMessage = (calls: { id: string; name: string; args: string }[], content = "") => ({
  choices: [
    {
      message: {
        content,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.args },
        })),
      },
    },
  ],
});

const textMessage = (content: string) => ({ choices: [{ message: { content } }] });

function bodyOf(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): Record<string, unknown> {
  const init = fetchMock.mock.calls[callIndex][1] as RequestInit;
  return JSON.parse(String(init.body));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setLlmClientForTests(null);
});

describe("createLlmClient", () => {
  it("throws a clear LlmError when the api key is not configured and makes no request", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient();

    await expect(client.chat([{ role: "user", content: "hello" }])).rejects.toThrow(/DEEPSEEK_API_KEY/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to {baseUrl}/chat/completions with a trailing slash stripped", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(textMessage("ok")));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient({ baseUrl: "https://api.example.com/", apiKey: "test-key" });
    await client.chat([{ role: "user", content: "hello" }]);

    expect(fetchMock.mock.calls[0][0]).toBe("https://api.example.com/chat/completions");
  });

  it("sends forceJson as response_format and passes temperature through", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(textMessage('{"a":1}')));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient({ baseUrl: "https://api.example.com", apiKey: "test-key" });
    await client.chat([{ role: "user", content: "hello" }], { forceJson: true, temperature: 0.2 });

    const body = bodyOf(fetchMock, 0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.temperature).toBe(0.2);
    expect(body.model).toBe("deepseek-chat");
  });

  it("throws an LlmError carrying the status on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "bad key" }, 401));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient({ baseUrl: "https://api.example.com", apiKey: "test-key" });

    await expect(client.chat([{ role: "user", content: "hello" }])).rejects.toMatchObject({
      name: "LlmError",
      status: 401,
    });
  });

  it("throws an LlmError when the response has no choices", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ usage: {} }));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient({ baseUrl: "https://api.example.com", apiKey: "test-key" });

    await expect(client.chat([{ role: "user", content: "hello" }])).rejects.toThrow(LlmError);
  });
});

describe("runToolLoop", () => {
  it("executes tool calls, logs them, and returns the final content", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          toolCallMessage([
            { id: "call_1", name: "search_events", args: '{"query":"invoice"}' },
            { id: "call_2", name: "search_events", args: '{"query":"release 4.12"}' },
          ]),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(textMessage("final answer")));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient({ baseUrl: "https://api.example.com", apiKey: "test-key" });
    const exec = vi.fn().mockResolvedValue("some event text");

    const result = await runToolLoop({
      client,
      system: "You investigate.",
      user: "What happened?",
      tools,
      exec,
    });

    expect(exec).toHaveBeenCalledWith("search_events", { query: "invoice" });
    expect(exec).toHaveBeenCalledWith("search_events", { query: "release 4.12" });
    expect(result.log).toHaveLength(2);
    expect(result.log[0]).toMatchObject({ round: 1, name: "search_events", args: { query: "invoice" } });
    expect(result.content).toBe("final answer");

    const secondRequest = bodyOf(fetchMock, 1).messages as Array<Record<string, unknown>>;
    expect(secondRequest[0]).toMatchObject({ role: "system", content: "You investigate." });
    expect(secondRequest[1]).toMatchObject({ role: "user", content: "What happened?" });
    expect(secondRequest[2]).toMatchObject({ role: "assistant" });
    const assistantCalls = (secondRequest[2] as { tool_calls: Array<Record<string, unknown>> }).tool_calls;
    expect(assistantCalls).toHaveLength(2);
    expect(assistantCalls[0]).toMatchObject({
      id: "call_1",
      type: "function",
      function: { name: "search_events" },
    });
    expect(secondRequest[3]).toMatchObject({
      role: "tool",
      tool_call_id: "call_1",
      name: "search_events",
      content: "some event text",
    });
    expect(secondRequest[4]).toMatchObject({ role: "tool", tool_call_id: "call_2" });
  });

  it("stops at maxRounds and returns the last content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(
        toolCallMessage([{ id: "call_x", name: "search_events", args: "{}" }], "still working"),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient({ baseUrl: "https://api.example.com", apiKey: "test-key" });
    const exec = vi.fn().mockResolvedValue("result");

    const result = await runToolLoop({
      client,
      system: "s",
      user: "u",
      tools,
      exec,
      maxRounds: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenCalledTimes(2);
    expect(result.log).toHaveLength(2);
    expect(result.content).toBe("still working");
  });

  it("survives a tool that throws, feeding the error back as the tool result", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(toolCallMessage([{ id: "call_1", name: "boom", args: "{}" }])),
      )
      .mockResolvedValueOnce(jsonResponse(textMessage("recovered")));
    vi.stubGlobal("fetch", fetchMock);

    const client = createLlmClient({ baseUrl: "https://api.example.com", apiKey: "test-key" });
    const exec = vi.fn().mockRejectedValue(new Error("db down"));

    const result = await runToolLoop({ client, system: "s", user: "u", tools, exec });

    expect(result.content).toBe("recovered");
    const secondRequest = bodyOf(fetchMock, 1).messages as Array<Record<string, unknown>>;
    expect(String(secondRequest[3].content)).toContain("db down");
  });
});

describe("default client accessors", () => {
  it("returns the injected test client and falls back to a constructed client", () => {
    const fake: LlmClient = { chat: vi.fn() };
    setLlmClientForTests(fake);
    expect(getLlmClient()).toBe(fake);

    setLlmClientForTests(null);
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    expect(typeof getLlmClient().chat).toBe("function");
  });
});
