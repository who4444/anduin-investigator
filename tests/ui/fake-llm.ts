import { createServer, type Server } from "node:http";

/* Deterministic OpenAI-compatible LLM stub. Every agent call in the app goes
   through DEEPSEEK_BASE_URL/chat/completions, so pointing the server here runs
   the whole pipeline without a real model. Routing is keyed on each stage's
   system prompt; investigator turns read the tool results in the transcript
   and cite real item ids and real substrings, so verification passes. */

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
}

interface Item {
  id: string;
  source?: string;
  actor?: string;
  text?: string;
}

const PLAN = [
  "The escalation claims invoice totals broke after release 4.12 and went unanswered.",
  "",
  "- Root cause: identify the change that altered invoice date handling and when it shipped.",
  "- Commitments: find every promised fix date and whether it shipped.",
  "- Ownership: trace who owned the release, the leave handoff, and the unanswered chasers.",
].join("\n");

function content(value: unknown) {
  return {
    role: "assistant",
    content: typeof value === "string" ? value : JSON.stringify(value),
  };
}

function toolCalls(calls: { name: string; args: Record<string, unknown> }[]) {
  return {
    role: "assistant",
    content: null,
    tool_calls: calls.map((call, index) => ({
      id: `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: JSON.stringify(call.args) },
    })),
  };
}

function investigatorTurn(
  kind: "root_cause" | "commitments" | "ownership",
  messages: ChatMessage[],
) {
  const toolMessages = messages.filter((message) => message.role === "tool");
  if (toolMessages.length === 0) {
    return toolCalls([
      { name: "search_jira", args: { query: "" } },
      { name: "search_slack", args: { query: "" } },
      { name: "search_email", args: { query: "" } },
    ]);
  }

  const submitted = toolMessages.some((message) => String(message.content ?? "").includes("claimId"));
  if (submitted) {
    return content({
      claims: [],
      notes: ["The record does not show who approved the release decision."],
    });
  }

  const items = toolMessages.flatMap((message) => {
    try {
      const parsed = JSON.parse(String(message.content ?? "")) as { items?: Item[] };
      return Array.isArray(parsed.items) ? parsed.items : [];
    } catch {
      return [];
    }
  });
  const usable = items.filter((item) => typeof item.text === "string" && item.text.length > 20);
  const preferred = kind === "root_cause" ? "jira" : kind === "commitments" ? "email" : "slack";
  const pick = usable.find((item) => item.source === preferred) ?? usable[0];
  if (!pick || !pick.text) return content({ claims: [], notes: [] });

  const quote = pick.text.slice(0, Math.min(60, pick.text.length));
  const type =
    kind === "root_cause" ? "root_cause" : kind === "commitments" ? "commitment" : "process_failure";
  const status = kind === "commitments" ? "broken" : "n/a";
  const label =
    kind === "root_cause" ? "Root cause" : kind === "commitments" ? "Commitment" : "Ownership";
  return toolCalls([
    {
      name: "submit_claim",
      args: {
        type,
        text: `${label} finding: ${quote}`,
        quote,
        item_id: pick.id,
        actor: pick.actor,
        status,
        confidence: 0.9,
      },
    },
  ]);
}

function replyTurn(messages: ChatMessage[]) {
  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => String(message.content ?? ""))
    .join("\n");
  const ids = [
    ...new Set(
      userText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [],
    ),
  ];
  const first = ids[0] ?? "";
  const second = ids[1] ?? first;
  return content({
    verdict: "Confirmed: the 4.12 UTC change broke invoice totals and the promised fix never shipped.",
    sentences: [
      {
        text: "Our records confirm invoice totals were affected by the UTC change in release 4.12.",
        claimIds: first ? [first] : [],
      },
      {
        text: "A dated remediation plan will be sent by Friday.",
        claimIds: second ? [second] : [],
      },
    ],
  });
}

function decide(system: string, messages: ChatMessage[]) {
  if (system.includes("resolve identities")) return content({ merges: [] });
  if (system.includes("identify which client and project")) {
    return content({
      client: "Northwind Logistics",
      project: "Meridian Billing",
      ticketPrefixes: ["MER"],
      channels: ["meridian-billing"],
      senderDomains: ["northwind.example"],
    });
  }
  if (system.includes("check one claim against one quote")) return content({ supports: "yes" });
  if (system.includes("skeptic")) return content({ issues: [] });
  if (system.includes("issue analyst")) return content(PLAN);
  if (system.includes("drafting the client reply")) return replyTurn(messages);
  if (system.includes("investigator")) {
    const kind = system.includes("root cause")
      ? "root_cause"
      : system.includes("commitments")
        ? "commitments"
        : "ownership";
    return investigatorTurn(kind, messages);
  }
  return content("Understood.");
}

let server: Server | null = null;

export async function ensureFakeLlm(port = 9401): Promise<void> {
  if (server) return;
  server = createServer((request, response) => {
    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      let messages: ChatMessage[] = [];
      try {
        messages = (JSON.parse(body || "{}").messages ?? []) as ChatMessage[];
      } catch {
        messages = [];
      }
      const system = String(
        messages.find((message) => message.role === "system")?.content ?? "",
      );
      const payload = {
        id: "chat-fake",
        choices: [{ index: 0, finish_reason: "stop", message: decide(system, messages) }],
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(port, "127.0.0.1", resolve);
  });
}

export function stopFakeLlm(): void {
  server?.close();
  server = null;
}
