"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { runPipeline, type StageUpdate } from "@/lib/orchestrator";
import type { CoverageReport } from "@/lib/pipeline/coverage";
import { coverageLabel, coverageState } from "@/lib/pipeline/coverage";
import type { ReportScope } from "@/lib/pipeline/scope";
import type { Issue, Stage } from "@/lib/types";

interface ProgressViewProps {
  investigationId: string;
  flags: { synthetic: boolean; cached: boolean; live: boolean };
  reviewOnly: boolean;
  /** G-01 review: re-run the investigation over records the manager added back. */
  rerun: boolean;
}

interface ToolCallEntry {
  round?: number;
  name?: string;
  args?: Record<string, string>;
  resultCount?: number;
}

interface ReviewIssue {
  id?: string;
  title: string;
  ask: string;
  summary: string;
  confidence: number;
}

const STAGE_ROWS: { key: string; label: string; internal?: string[] }[] = [
  { key: "plan", label: "Plan" },
  { key: "retrieve", label: "Retrieve and investigate", internal: ["root_cause", "commitments", "ownership"] },
  { key: "skeptic", label: "Skeptic review" },
  { key: "verify", label: "Verify" },
  { key: "assemble", label: "Assemble" },
];

const AGENT_LABEL: Record<string, string> = {
  root_cause: "Root cause agent",
  commitments: "Commitments agent",
  ownership: "Ownership agent",
};

function reportHref(id: string, flags: ProgressViewProps["flags"]) {
  const query = new URLSearchParams();
  if (flags.synthetic) query.set("synthetic", "1");
  if (flags.cached) query.set("cached", "1");
  if (flags.live) query.set("live", "1");
  const suffix = query.toString();
  return `/investigations/${id}${suffix ? `?${suffix}` : ""}`;
}

function asReviewIssues(issues: Issue[]): ReviewIssue[] {
  return issues.map((issue) => ({
    id: issue.id,
    title: issue.title,
    ask: issue.ask,
    summary: issue.summary,
    confidence: issue.confidence,
  }));
}

function formatElapsed(stage: Stage | undefined): string {
  if (!stage?.startedAt) return "";
  const start = Date.parse(stage.startedAt);
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : Date.now();
  const millis = Math.max(0, end - start);
  // Sub-second phases are real (offline/cached runs); "0m 00s" reads as
  // broken, "<1s" is honest.
  if (millis < 1000) return "<1s";
  const seconds = Math.round(millis / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function stageStatus(stages: Stage[], key: string): "pending" | "running" | "done" | "error" {
  if (key === "retrieve") {
    const relevant = stages.filter((stage) => ["root_cause", "commitments", "ownership"].includes(stage.stage));
    if (relevant.some((stage) => stage.status === "error")) return "error";
    if (relevant.length === 0) return "pending";
    if (relevant.every((stage) => stage.status === "done")) return "done";
    return "running";
  }
  const stage = stages.find((entry) => entry.stage === key);
  if (!stage) return "pending";
  if (stage.status === "error") return "error";
  if (stage.status === "done") return "done";
  return "running";
}

const MARK: Record<string, { glyph: string; className: string }> = {
  done: { glyph: "✓", className: "stage-mark stage-mark-done" },
  running: { glyph: "◌", className: "stage-mark stage-mark-running" },
  error: { glyph: "✗", className: "stage-mark stage-mark-error" },
  pending: { glyph: "·", className: "stage-mark stage-mark-pending" },
};

export function ProgressView({ investigationId, flags, reviewOnly, rerun }: ProgressViewProps) {
  const router = useRouter();
  const [stages, setStages] = useState<Stage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [scope, setScope] = useState<ReportScope | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ events: number; channels: number } | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const [reviewIssues, setReviewIssues] = useState<ReviewIssue[] | null>(null);
  const [overflow, setOverflow] = useState(0);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const started = useRef(false);
  const done = useRef(false);

  const loadStages = useCallback(async () => {
    const response = await fetch(`/api/investigations/${investigationId}/status`);
    if (!response.ok) return null;
    const payload = (await response.json()) as { stages?: Stage[] };
    setStages(payload.stages ?? []);
    return payload.stages ?? [];
  }, [investigationId]);

  const loadCoverage = useCallback(async () => {
    const response = await fetch(`/api/investigations/${investigationId}/report`);
    if (!response.ok) return;
    const payload = (await response.json()) as {
      coverage?: CoverageReport;
      events?: { source: string; channel: string }[];
      scope?: ReportScope | null;
      investigation?: { ingestWarnings?: string[] };
    };
    if (payload.coverage) setCoverage(payload.coverage);
    if (payload.scope !== undefined) setScope(payload.scope);
    if (payload.investigation?.ingestWarnings) setWarnings(payload.investigation.ingestWarnings);
    if (payload.events) {
      setSummary({
        events: payload.events.length,
        channels: new Set(payload.events.filter((event) => event.source === "slack").map((event) => event.channel)).size,
      });
    }
  }, [investigationId]);

  const loadIssues = useCallback(async (): Promise<{ issues: Issue[]; overflow: number }> => {
    try {
      const response = await fetch(`/api/investigations/${investigationId}/issues`);
      if (!response.ok) return { issues: [], overflow: 0 };
      const payload = (await response.json()) as { issues?: Issue[]; overflow?: number };
      const issues = Array.isArray(payload.issues) ? payload.issues : [];
      setOverflow(payload.overflow ?? 0);
      return { issues, overflow: payload.overflow ?? 0 };
    } catch {
      return { issues: [], overflow: 0 };
    }
  }, [investigationId]);

  useEffect(() => {
    const initial = setTimeout(() => void loadCoverage(), 0);    const poll = setInterval(() => void loadCoverage(), 2500);
    return () => {
      clearTimeout(initial);
      clearInterval(poll);
    };
  }, [loadCoverage]);

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    if (reviewOnly) {
      void loadCoverage();
      return;
    }
    void loadCoverage();
    window.setTimeout(() => router.replace(reportHref(investigationId, flags)), 900);
  }, [flags, investigationId, loadCoverage, reviewOnly, router]);

  useEffect(() => {
    let source: EventSource | null = null;
    let cancelled = false;

    const boot = async () => {
      const current = await loadStages();
      if (cancelled || !current) return;

      const assembleDone = current.some(
        (stage) => stage.stage === "assemble" && stage.status === "done",
      );
      // A re-run deliberately redoes investigate → verify → assemble over the
      // enlarged scope, so the finished state must not short-circuit it.
      if (!rerun && (assembleDone || reviewOnly)) {
        finish();
        return;
      }

      source = new EventSource(`/api/investigations/${investigationId}/events`);
      source.addEventListener("stages", (event) => {
        const payload = JSON.parse((event as MessageEvent).data) as Stage[];
        setStages(payload);
      });
      source.addEventListener("error", () => {
        // EventSource reconnects on its own.
      });

      if (started.current) return;

      const planDone = current.some(
        (stage) => stage.stage === "plan" && stage.status === "done",
      );

      const onStage = (update: StageUpdate) => {
        if (update.status === "error" && update.error) {
          setError(`${update.stage.replace(/_/g, " ")} failed: ${update.error}`);
        }
      };

      const handleOutcome = async (outcome: Awaited<ReturnType<typeof runPipeline>>) => {
        if (!outcome.ok) {
          setError(`${outcome.stage.replace(/_/g, " ")} failed: ${outcome.error}`);
          return;
        }
        if ("paused" in outcome && outcome.paused) {
          const info = await loadIssues();
          setReviewIssues(
            asReviewIssues(info.issues.length > 0 ? info.issues : outcome.issues),
          );
          return;
        }
        setError(null);
        finish();
      };

      if (planDone) {
        // A reload while the issue review is open must show the review again,
        // not run the plan a second time or skip the manager's confirmation.
        const info = await loadIssues();
        if (info.issues.length > 1 && info.issues.some((issue) => !issue.confirmed)) {
          setReviewIssues(asReviewIssues(info.issues));
          return;
        }
        started.current = true;
        const outcome = await runPipeline(investigationId, {
          startAt: "investigate",
          onStage,
        });
        await handleOutcome(outcome);
        return;
      }

      started.current = true;
      const outcome = await runPipeline(investigationId, {
        stopForIssueReview: true,
        onStage,
      });
      await handleOutcome(outcome);
    };

    void boot();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [finish, investigationId, loadIssues, loadStages, reviewOnly, rerun]);

  const updateReviewIssue = (index: number, patch: Partial<ReviewIssue>) => {
    setReviewIssues((current) =>
      current ? current.map((issue, i) => (i === index ? { ...issue, ...patch } : issue)) : current,
    );
  };

  const addReviewIssue = () => {
    setReviewIssues((current) =>
      current && current.length < 3
        ? [...current, { title: "", ask: "", summary: "", confidence: 0.5 }]
        : current,
    );
  };

  const removeReviewIssue = (index: number) => {
    setReviewIssues((current) =>
      current && current.length > 1 ? current.filter((_, i) => i !== index) : current,
    );
  };

  const mergeReviewIssues = () => {
    setReviewIssues((current) => {
      if (!current || current.length < 2) return current;
      return [
        {
          ...current[0],
          title: current[0].title || "Combined issue",
          ask: current
            .map((issue) => issue.ask.trim())
            .filter(Boolean)
            .join("\n\n"),
          summary: current
            .map((issue) => issue.summary.trim())
            .filter(Boolean)
            .join(" "),
        },
      ];
    });
  };

  const confirmReview = async () => {
    if (!reviewIssues || reviewIssues.length === 0) return;
    if (reviewIssues.some((issue) => !issue.title.trim())) {
      setReviewError("Give every issue a title before investigating.");
      return;
    }
    setReviewBusy(true);
    setReviewError(null);
    try {
      const response = await fetch(`/api/investigations/${investigationId}/issues`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          issues: reviewIssues.map((issue) => ({
            id: issue.id,
            title: issue.title.trim(),
            ask: issue.ask.trim(),
            summary: issue.summary.trim(),
            confidence: issue.confidence,
          })),
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save the issues.");
      setReviewIssues(null);
      started.current = true;
      const outcome = await runPipeline(investigationId, {
        startAt: "investigate",
        onStage: (update) => {
          if (update.status === "error" && update.error) {
            setError(`${update.stage.replace(/_/g, " ")} failed: ${update.error}`);
          }
        },
      });
      if (!outcome.ok) {
        setError(`${outcome.stage.replace(/_/g, " ")} failed: ${outcome.error}`);
      } else {
        setError(null);
        finish();
      }
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewBusy(false);
    }
  };

  const activity = useMemo(() => {    const entries: { agent: string; name: string; detail: string; count?: number }[] = [];
    for (const stage of stages) {
      if (!["root_cause", "commitments", "ownership"].includes(stage.stage)) continue;
      for (const raw of stage.log) {
        if (typeof raw !== "object" || raw === null) continue;
        const logEntry = raw as { toolCalls?: unknown[] };
        if (!Array.isArray(logEntry.toolCalls)) continue;
        for (const call of logEntry.toolCalls) {
          if (typeof call !== "object" || call === null) continue;
          const tool = call as ToolCallEntry;
          if (typeof tool.name !== "string") continue;
          const args = tool.args ?? {};
          const argText = Object.entries(args)
            .filter(([, value]) => value && value !== "all")
            .map(([key, value]) => `${key} ${JSON.stringify(value)}`)
            .join(", ");
          entries.push({
            agent: AGENT_LABEL[stage.stage] ?? stage.stage,
            name: tool.name,
            detail: argText,
            count: typeof tool.resultCount === "number" ? tool.resultCount : undefined,
          });
        }
      }
    }
    return entries;
  }, [stages]);

  const failed = error !== null;

  return (
    <div className="shell stack">
      <div className="spread">
        <span className="row">
          <h1>Investigation in progress</h1>
          {rerun && <span className="chip">re-run with reviewed records</span>}
        </span>
        <a href={reviewOnly ? reportHref(investigationId, flags) : reportHref(investigationId, flags)}>
          Open the report
        </a>
      </div>

      <section className="panel">
        <ol className="stage-list">
          {STAGE_ROWS.map((row) => {
            const status = stageStatus(stages, row.key);
            const mark = MARK[status];
            const relevant =
              row.key === "retrieve"
                ? stages.filter((stage) => row.internal?.includes(stage.stage))
                : stages.filter((stage) => stage.stage === row.key);
            const elapsed = relevant.map(formatElapsed).filter(Boolean);
            return (
              <li className="stage" key={row.key}>
                <span className={mark.className} aria-hidden>
                  {mark.glyph}
                </span>
                <span className="stage-name">{row.label}</span>
                {row.internal && (
                  <span className="small muted">
                    {row.internal
                      .map((kind) => {
                        const stage = stages.find((entry) => entry.stage === kind);
                        return `${AGENT_LABEL[kind].replace(" agent", "")} ${stage ? stage.status : "pending"}`;
                      })
                      .join(" · ")}
                  </span>
                )}
                <span className="small muted tabular">{elapsed[elapsed.length - 1] ?? ""}</span>
              </li>
            );
          })}
        </ol>
      </section>

      {failed && (
        <p className="alert alert-error">
          {error} — fix the cause (for example an API key or a source connection) and reload this page to try again.
        </p>
      )}

      {reviewIssues && (
        <section className="panel issue-review" aria-labelledby="issue-review-title">
          <div className="spread">
            <div>
              <h2 id="issue-review-title">Confirm the issues before I investigate</h2>
              <p className="small muted">
                The plan found {reviewIssues.length} independent issue
                {reviewIssues.length === 1 ? "" : "s"} in this escalation. Edit a title or ask,
                merge them, or remove one — this split decides how the timeline, promises and
                draft reply are separated. Max 3.
              </p>
              {reviewIssues.length > 1 && (
                <p className="small muted">
                  If one fix would resolve all of these, merge them. A failed fix, a premature
                  closure, unanswered chases, or an SLA consequence is usually a facet of the
                  same issue, not a separate one.
                </p>
              )}
            </div>
            <span className="chip">{reviewIssues.length} of 3</span>
          </div>

          {overflow > 0 && (
            <p className="alert alert-warn">
              The plan also detected {overflow} more independent issue{overflow === 1 ? "" : "s"}.
              This investigation covers the {reviewIssues.length} shown; split the rest into a
              separate escalation.
            </p>
          )}

          <div className="stack">
            {reviewIssues.map((issue, index) => (
              <div className="issue-edit-card" key={issue.id ?? `new-${index}`}>
                <div className="spread">
                  <span className="small muted">Issue {index + 1}</span>
                  {reviewIssues.length > 1 && (
                    <button
                      type="button"
                      className="btn btn-quiet"
                      onClick={() => removeReviewIssue(index)}
                    >
                      Remove
                    </button>
                  )}
                </div>
                <label className="field">
                  <span className="field-label">Title</span>
                  <input
                    className="input"
                    value={issue.title}
                    maxLength={120}
                    onChange={(event) => updateReviewIssue(index, { title: event.target.value })}
                    placeholder="e.g. Blank VAT totals after 5.3.0"
                  />
                </label>
                <label className="field">
                  <span className="field-label">What the client asks on this issue</span>
                  <textarea
                    className="input"
                    rows={2}
                    value={issue.ask}
                    maxLength={600}
                    onChange={(event) => updateReviewIssue(index, { ask: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Short description (optional)</span>
                  <textarea
                    className="input"
                    rows={2}
                    value={issue.summary}
                    maxLength={600}
                    onChange={(event) => updateReviewIssue(index, { summary: event.target.value })}
                  />
                </label>
              </div>
            ))}
          </div>

          <div className="row">
            <button
              type="button"
              className="btn btn-quiet"
              onClick={addReviewIssue}
              disabled={reviewIssues.length >= 3}
            >
              Add issue
            </button>
            <button
              type="button"
              className="btn btn-quiet"
              onClick={mergeReviewIssues}
              disabled={reviewIssues.length < 2}
            >
              Merge into one issue
            </button>
          </div>

          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void confirmReview()}
              disabled={reviewBusy}
            >
              {reviewBusy
                ? "Saving…"
                : `Confirm ${reviewIssues.length} issue${reviewIssues.length === 1 ? "" : "s"} and investigate`}
            </button>
            <span className="small muted">
              The same evidence is searched once; findings and promises stay separated per issue.
            </span>
          </div>
          {reviewError && <p className="alert alert-error">{reviewError}</p>}
        </section>
      )}

      <section className="panel">
        <h2>Summary</h2>
        {summary ? (
          <div className="stack stack-sm">
            <p className="row small">
              <span className="tabular">{summary.events} items stored</span>
              {summary.channels > 0 && <span className="tabular">{summary.channels} Slack channels searched</span>}
            </p>
            {warnings.length > 0 && (
              <p className="small muted">Evidence-set notes: {warnings.join(" · ")}</p>
            )}
            {scope && (
              <p className={`scope-line small tone-${scope.confidence}`}>
                {scope.confidence === "none"
                  ? `No scope could be confirmed${scope.client ? ` for ${scope.client}` : ""} — every stored record was searched.`
                  : `${scope.confidence === "partial" ? "Unconfirmed scope: " : "Scope: "}${[scope.client, scope.project]
                      .filter(Boolean)
                      .join(" · ")}${
                      scope.excludedRecords > 0 ? ` · ${scope.excludedRecords} out-of-scope records excluded` : ""
                    }`}
              </p>
            )}
            {coverage && (
              <ul className="stack stack-sm">
                {coverage.sources.map((entry) => (
                  <li key={entry.source} className="row small">
                    <span className={`source-label source-${entry.source}`}>{entry.source}</span>
                    <span className="tabular">{entry.available} items</span>
                    <span className={coverageState(entry) === "searched" ? "muted" : "activity-result"}>
                      {coverageLabel(entry)}
                    </span>
                    {entry.failedQueries.length > 0 && (
                      <span className="activity-result">
                        {entry.failedQueries.length} failed quer
                        {entry.failedQueries.length === 1 ? "y" : "ies"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <p className="small muted">Counts appear as the sources are read.</p>
        )}
      </section>

      <section className="panel stack">
        <div className="spread">
          <h2>Activity</h2>
          <button
            type="button"
            className="btn btn-quiet"
            aria-expanded={showActivity}
            onClick={() => setShowActivity((current) => !current)}
          >
            {showActivity ? "Hide activity" : `Show activity (${activity.length} tool calls)`}
          </button>
        </div>
        {showActivity &&
          (activity.length === 0 ? (
            <p className="empty">Agent tool calls will appear here as they happen, with the records they stored.</p>
          ) : (
            <ol className="activity-log">
              {activity.map((entry, index) => (
                <li className="activity-entry" key={`${entry.agent}-${entry.name}-${index}`}>
                  <span className="activity-agent">{entry.agent.split(" ")[0]}</span>
                  <span>
                    <span className="activity-tool">{entry.name}</span>
                    {entry.detail && <span className="activity-result"> {entry.detail}</span>}
                    {typeof entry.count === "number" && (
                      <span className="activity-result">
                        {" "}
                        — {entry.count} record{entry.count === 1 ? "" : "s"} returned
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          ))}
      </section>
    </div>
  );
}
