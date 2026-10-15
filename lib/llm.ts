export interface ToolFunctionSpec {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface ToolSpec {
  type: "function";
  function: ToolFunctionSpec;
}

export interface AssistantToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_calls?: AssistantToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  parseError?: string;
}

export interface LlmUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface LlmResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: LlmUsage;
}

export interface ChatOptions {
  tools?: ToolSpec[];
  temperature?: number;
  forceJson?: boolean;
}

export interface LlmClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<LlmResponse>;
}

export class LlmError extends Error {
  status?: number;
  body?: string;

  constructor(message: string, options: { status?: number; body?: string } = {}) {
    super(message);
    this.name = "LlmError";
    this.status = options.status;
    this.body = options.body;
  }
}

export interface CreateLlmClientOptions {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-chat";
const DEFAULT_TIMEOUT_MS = 60_000;

interface OpenAiToolCallRaw {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiMessageRaw {
  content?: string | null;
  tool_calls?: OpenAiToolCallRaw[];
}

interface OpenAiResponseRaw {
  choices?: { message?: OpenAiMessageRaw }[];
  usage?: LlmUsage;
}

function parseToolCall(raw: OpenAiToolCallRaw): ToolCall {
  const call: ToolCall = {
    id: raw.id ?? "",
    name: raw.function?.name ?? "",
    args: {},
  };

  const rawArgs = raw.function?.arguments;
  if (rawArgs) {
    try {
      const parsed = JSON.parse(rawArgs) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        call.args = parsed as Record<string, unknown>;
      }
    } catch (error) {
      call.parseError = error instanceof Error ? error.message : String(error);
    }
  }

  return call;
}

export function createLlmClient(opts: CreateLlmClientOptions = {}): LlmClient {
  const baseUrl = (opts.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async chat(messages: ChatMessage[], chatOpts: ChatOptions = {}): Promise<LlmResponse> {
      const apiKey = opts.apiKey ?? process.env.DEEPSEEK_API_KEY ?? "";
      if (!apiKey) {
        throw new LlmError("DEEPSEEK_API_KEY is not set");
      }

      const body: Record<string, unknown> = { model, messages };
      if (chatOpts.tools) {
        body.tools = chatOpts.tools;
      }
      if (chatOpts.forceJson) {
        body.response_format = { type: "json_object" };
      }
      if (typeof chatOpts.temperature === "number") {
        body.temperature = chatOpts.temperature;
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const text = await response.text();
      if (!response.ok) {
        throw new LlmError(`LLM request failed with status ${response.status}: ${text}`, {
          status: response.status,
          body: text,
        });
      }

      let data: OpenAiResponseRaw;
      try {
        data = JSON.parse(text) as OpenAiResponseRaw;
      } catch {
        throw new LlmError("LLM response was not valid JSON");
      }

      const message = data.choices?.[0]?.message;
      if (!message) {
        throw new LlmError("LLM response contained no choices");
      }

      const result: LlmResponse = { content: message.content ?? "" };
      const toolCalls = message.tool_calls?.map(parseToolCall);
      if (toolCalls && toolCalls.length > 0) {
        result.toolCalls = toolCalls;
      }
      if (data.usage) {
        result.usage = data.usage;
      }

      return result;
    },
  };
}

export interface ToolLoopLogEntry {
  round: number;
  name: string;
  args: Record<string, unknown>;
  resultPreview: string;
  note?: string;
}

export interface RunToolLoopOptions {
  client: LlmClient;
  system: string;
  user: string;
  tools: ToolSpec[];
  exec: (name: string, args: Record<string, unknown>) => Promise<string>;
  maxRounds?: number;
  temperature?: number;
  forceJson?: boolean;
}

export interface ToolLoopResult {
  content: string;
  log: ToolLoopLogEntry[];
}

const RESULT_PREVIEW_LENGTH = 200;

export async function runToolLoop(options: RunToolLoopOptions): Promise<ToolLoopResult> {
  const { client, system, user, tools, exec, maxRounds = 8 } = options;
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const log: ToolLoopLogEntry[] = [];
  let content = "";

  for (let round = 0; round < maxRounds; round++) {
    const chatOpts: ChatOptions = { tools };
    if (typeof options.temperature === "number") {
      chatOpts.temperature = options.temperature;
    }
    if (options.forceJson) {
      chatOpts.forceJson = true;
    }

    const response = await client.chat(messages, chatOpts);
    content = response.content;

    const toolCalls = response.toolCalls ?? [];
    if (toolCalls.length === 0) {
      return { content, log };
    }

    messages.push({
      role: "assistant",
      content: response.content,
      tool_calls: toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.args) },
      })),
    });

    for (const call of toolCalls) {
      const args = call.args ?? {};
      const result = await exec(call.name, args);
      log.push({
        round,
        name: call.name,
        args,
        resultPreview: result.slice(0, RESULT_PREVIEW_LENGTH),
        ...(call.parseError ? { note: `failed to parse tool arguments: ${call.parseError}` } : {}),
      });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name: call.name,
        content: result,
      });
    }
  }

  return { content, log };
}

let defaultClient: LlmClient | null = null;
let testClient: LlmClient | null = null;

export function getDefaultLlmClient(): LlmClient {
  if (testClient) {
    return testClient;
  }
  if (!defaultClient) {
    defaultClient = createLlmClient();
  }
  return defaultClient;
}

export function setLlmClientForTests(client: LlmClient | null): void {
  testClient = client;
}
