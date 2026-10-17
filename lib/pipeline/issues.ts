import type { Issue } from "../types";

/* G-23: one escalation can contain several independent issues. The model is
   asked to label every claim, but a missing/unknown label must not lose the
   finding: code falls back to the only issue, then to a deterministic token
   overlap. When nothing matches, the claim stays unassigned and is shown as
   cross-issue rather than forced into the wrong story. */

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "after", "before", "since",
  "issue", "problem", "client", "customer", "reported", "reports", "still", "been",
  "have", "has", "was", "were", "are", "not", "but", "our", "their", "they", "them",
  "into", "when", "what", "why", "how", "who", "all", "any", "can", "could", "would",
  "should", "about", "over", "under", "more", "less", "fixed", "fix", "release",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9@._-]+/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOP_WORDS.has(word)),
  );
}

export function inferIssueId(text: string, issues: Issue[]): string | null {
  if (issues.length === 0) return null;
  if (issues.length === 1) return issues[0].id;

  const claimTokens = tokens(text);
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const issue of issues) {
    const issueTokens = tokens(`${issue.title} ${issue.ask} ${issue.summary}`);
    let score = 0;
    for (const token of claimTokens) if (issueTokens.has(token)) score += 1;
    if (!best || score > best.score) {
      best = { id: issue.id, score };
      tie = false;
    } else if (score === best.score) {
      tie = true;
    }
  }
  if (!best || best.score === 0 || tie) return null;
  return best.id;
}

export function resolveIssueId(
  raw: unknown,
  text: string,
  issues: Issue[],
): string | null {
  if (typeof raw === "string" && raw.trim()) {
    const trimmed = raw.trim();
    if (issues.some((issue) => issue.id === trimmed)) return trimmed;
  }
  return inferIssueId(text, issues);
}

export function issuePromptBlock(issues: Issue[]): string {
  if (issues.length === 0) return "";
  return [
    `This escalation contains ${issues.length} independent issue${issues.length === 1 ? "" : "s"}. Every claim and gap MUST set issue_id to exactly one of these ids:`,
    ...issues.map(
      (issue) =>
        `- issue_id=${issue.id} — ${issue.title}${issue.ask ? ` (the client asks: ${issue.ask})` : ""}`,
    ),
    "Do not merge findings from different issues into one claim. If a finding is relevant to more than one issue, cite the issue whose root cause/owner it explains.",
  ].join("\n");
}
