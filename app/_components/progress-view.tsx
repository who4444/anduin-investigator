"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { runPipeline, type StageUpdate } from "@/lib/orchestrator";
import type { CoverageReport } from "@/lib/pipeline/coverage";
import type { Stage } from "@/lib/types";

interface ProgressViewProps {
  investigationId: string;
  flags: { synthetic: boolean; cached: boolean; live: boolean };
  reviewOnly: boolean;
}

interface ToolCallEntry {
  round?: number;
  name?: string;
  args?: Record<string, string>;
  resultCount?: number;
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

function formatElapsed(stage: Stage | undefined): string {
  if (!stage?.startedAt) return "";
  const end = stage.finishedAt ? Date.parse(stage.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(stage.startedAt)) / 1000));
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

export function ProgressView({ investigationId, flags, reviewOnly }: ProgressViewProps) {
  const router = useRouter();
  const [stages, setStages] = useState<Stage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<CoverageReport | null>(null);
  const [summary, setSummary] = useState<{ events: number; channels: number } | null>(null);
  const [showActivity, setShowActivity] = useState(false);
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
    };
    if (payload.coverage) setCoverage(payload.coverage);
    if (payload.events) {
      setSummary({
        events: payload.events.length,
        channels: new Set(payload.events.filter((event) => event.source === "slack").map((event) => event.channel)).size,
      });
    }
  }, [investigationId]);

  useEffect(() => {
    const initial = setTimeout(() => void loadCoverage(), 0);
    const poll = setInterval(() => void loadCoverage(), 2500);
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
      if (assembleDone || reviewOnly) {
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
      started.current = true;

      const outcome = await runPipeline(investigationId, {
        onStage: (update: StageUpdate) => {
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
    };

    void boot();
    return () => {
      cancelled = true;
      source?.close();
    };
  }, [finish, investigationId, loadStages, reviewOnly]);

  const activity = useMemo(() => {
    const entries: { agent: string; name: string; detail: string; count?: number }[] = [];
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
        <h1 style={{ fontSize: 20 }}>Investigation in progress</h1>
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

      <section className="panel">
        <h2 style={{ marginBottom: 8 }}>Summary</h2>
        {summary ? (
          <div className="stack" style={{ gap: 8 }}>
            <p className="row small" style={{ gap: 12 }}>
              <span className="tabular">{summary.events} items stored</span>
              {summary.channels > 0 && <span className="tabular">{summary.channels} Slack channels searched</span>}
            </p>
            {coverage && (
              <ul className="stack" style={{ gap: 6 }}>
                {coverage.sources.map((entry) => (
                  <li key={entry.source} className="row small">
                    <span className={`source-label source-${entry.source}`}>{entry.source}</span>
                    <span className="tabular">{entry.available} items</span>
                    <span className={entry.searched ? "muted" : "activity-result"}>
                      {entry.searched ? `${entry.queries.length} queries` : entry.available > 0 ? "never searched" : "no data"}
                    </span>
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
