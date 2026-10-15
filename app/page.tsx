"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { runPipeline, type StageUpdate } from "@/lib/orchestrator";

const STAGE_ROWS: { key: string; label: string }[] = [
  { key: "plan", label: "Analyst writes the investigation plan" },
  { key: "root_cause", label: "Investigator · root cause" },
  { key: "commitments", label: "Investigator · commitments" },
  { key: "ownership", label: "Investigator · decisions & ownership" },
  { key: "skeptic", label: "Skeptic challenges the findings" },
  { key: "verify", label: "Code verifier checks every quote" },
  { key: "assemble", label: "Assemble timeline, ledger and gaps" },
];

type StageState = { status: string; error?: string | null; pass: number };

interface ServerStage {
  stage: string;
  pass: number;
  status: string;
  error?: string | null;
  log: unknown[];
}

interface UploadResult {
  investigationId: string;
  eventCount: number;
  cached: boolean;
  warnings: string[];
}

interface SourceInfo {
  id: string;
  label: string;
  envKeys: string[];
  configured: boolean;
  missingEnv: string[];
}

interface SourceTargetInfo {
  id: string;
  label: string;
}

const LOG_POLL_MS = 3000;

export default function Home() {
  const router = useRouter();
  const directoryInput = useRef<HTMLInputElement | null>(null);
  const [escalation, setEscalation] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [synthetic, setSynthetic] = useState(false);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [serverLogs, setServerLogs] = useState<Record<string, unknown[]>>({});
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [run, setRun] = useState<{ id: string; synthetic: boolean; live?: boolean } | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [targets, setTargets] = useState<Record<string, SourceTargetInfo[]>>({});
  const [selectedTargets, setSelectedTargets] = useState<Record<string, string[]>>({});
  const [sourceQuery, setSourceQuery] = useState<Record<string, string>>({});
  const [sourceError, setSourceError] = useState<Record<string, string>>({});

  useEffect(() => {
    directoryInput.current?.setAttribute("webkitdirectory", "");
    directoryInput.current?.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    fetch("/api/sources")
      .then((response) => (response.ok ? response.json() : { sources: [] }))
      .then((body: { sources?: SourceInfo[] }) => setSources(body.sources ?? []))
      .catch(() => setSources([]));
  }, []);

  const loadTargets = useCallback(async (sourceId: string) => {
    setSourceError((current) => ({ ...current, [sourceId]: "" }));
    try {
      const response = await fetch(`/api/sources?targets=${encodeURIComponent(sourceId)}`);
      const body = (await response.json().catch(() => ({}))) as {
        targets?: SourceTargetInfo[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Could not load targets.");
      setTargets((current) => ({ ...current, [sourceId]: body.targets ?? [] }));
      if (sourceId === "gmail" && !(body.targets ?? []).some((target) => target.id === "search")) {
        setSelectedTargets((current) => ({ ...current, [sourceId]: ["search"] }));
      }
    } catch (caught) {
      setSourceError((current) => ({
        ...current,
        [sourceId]: caught instanceof Error ? caught.message : String(caught),
      }));
    }
  }, []);

  const toggleTarget = (sourceId: string, targetId: string) => {
    setSelectedTargets((current) => {
      const selected = current[sourceId] ?? [];
      const next = selected.includes(targetId)
        ? selected.filter((id) => id !== targetId)
        : [...selected, targetId];
      return { ...current, [sourceId]: next };
    });
  };

  const applyStage = useCallback((update: StageUpdate) => {
    setStages((current) => ({
      ...current,
      [update.stage]: { status: update.status, error: update.error ?? null, pass: update.pass },
    }));
  }, []);

  const resultsHref = (id: string, flags: { synthetic: boolean; cached: boolean; live?: boolean }) => {
    const query = new URLSearchParams();
    if (flags.synthetic) query.set("synthetic", "1");
    if (flags.cached) query.set("cached", "1");
    if (flags.live) query.set("live", "1");
    const suffix = query.toString();
    return `/investigations/${id}${suffix ? `?${suffix}` : ""}`;
  };

  const collectLogs = (stages: ServerStage[]): Record<string, unknown[]> => {
    const logs: Record<string, unknown[]> = {};
    for (const stage of stages) {
      if (stage.log.length > 0) logs[stage.stage] = stage.log;
    }
    return logs;
  };

  async function drivePipeline(investigationId: string, flags: { synthetic: boolean; live?: boolean }) {
    let poller: ReturnType<typeof setInterval> | null = null;
    try {
      poller = setInterval(async () => {
        try {
          const response = await fetch(`/api/investigations/${investigationId}/status`);
          const body = (await response.json().catch(() => ({}))) as { stages?: ServerStage[] };
          setServerLogs(collectLogs(body.stages ?? []));
        } catch {
          // Polling is best-effort; the pipeline result is authoritative.
        }
      }, LOG_POLL_MS);

      const outcome = await runPipeline(investigationId, { onStage: applyStage });
      if (!outcome.ok) {
        throw new Error(`${outcome.stage} stage failed: ${outcome.error}`);
      }

      try {
        const status = await fetch(`/api/investigations/${investigationId}/status`);
        const payload = (await status.json().catch(() => ({}))) as { stages?: ServerStage[] };
        setServerLogs(collectLogs(payload.stages ?? []));
      } catch {
        // Cosmetic refresh only.
      }

      router.push(resultsHref(investigationId, { ...flags, cached: false }));
    } finally {
      if (poller) clearInterval(poller);
    }
  }

  async function pullFromSource(sourceId: string) {
    const selected = selectedTargets[sourceId] ?? [];
    const query = sourceQuery[sourceId]?.trim() ?? "";

    setBusy(true);
    setError(null);
    setStages({});
    setServerLogs({});
    setWarnings([]);
    setEventCount(null);
    setSynthetic(false);
    setRun(null);
    setSourceError((current) => ({ ...current, [sourceId]: "" }));

    try {
      const response = await fetch("/api/sources/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: sourceId,
          targets: selected,
          query: query || undefined,
          escalation,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as Partial<UploadResult> & {
        error?: string;
      };
      if (!response.ok || !payload.investigationId) {
        throw new Error(payload.error ?? "Pull failed.");
      }

      setEventCount(payload.eventCount ?? 0);
      setWarnings(payload.warnings ?? []);
      setRun({ id: payload.investigationId, synthetic: false, live: true });

      await drivePipeline(payload.investigationId, { synthetic: false, live: true });
    } catch (caught) {
      setSourceError((current) => ({
        ...current,
        [sourceId]: caught instanceof Error ? caught.message : String(caught),
      }));
    } finally {
      setBusy(false);
    }
  }

  async function upload(uploadFiles: File[], isSynthetic: boolean) {
    setBusy(true);
    setError(null);
    setStages({});
    setServerLogs({});
    setWarnings([]);
    setEventCount(null);
    setSynthetic(isSynthetic);
    setRun(null);

    try {
      const form = new FormData();
      for (const file of uploadFiles) {
        form.append("files", file, file.webkitRelativePath || file.name);
      }
      form.append("escalation", escalation);

      const response = await fetch("/api/investigations", { method: "POST", body: form });
      const payload = (await response.json().catch(() => ({}))) as Partial<UploadResult> & {
        error?: string;
      };
      if (!response.ok || !payload.investigationId) {
        throw new Error(payload.error ?? "Upload failed.");
      }

      setEventCount(payload.eventCount ?? 0);
      setWarnings(payload.warnings ?? []);
      setRun({ id: payload.investigationId, synthetic: isSynthetic });

      if (payload.cached) {
        setStages({ assemble: { status: "done", pass: 1 } });
        router.push(resultsHref(payload.investigationId, { synthetic: isSynthetic, cached: true }));
        return;
      }

      await drivePipeline(payload.investigationId, { synthetic: isSynthetic });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!run) return;
    setBusy(true);
    setError(null);
    setStages({});
    try {
      await drivePipeline(run.id, { synthetic: run.synthetic, live: run.live });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadDemo() {
    setBusy(true);
    setError(null);
    try {
      const manifestResponse = await fetch("/demo/manifest.json");
      if (!manifestResponse.ok) throw new Error("Built-in demo exports are unavailable.");
      const manifest = (await manifestResponse.json()) as { files: string[] };

      const loaded = await Promise.all(
        manifest.files.map(async (name) => {
          const response = await fetch(`/demo/${name}`);
          if (!response.ok) throw new Error(`Missing demo file: ${name}`);
          const blob = await response.blob();
          // Keep the manifest path so Slack's per-channel folders survive ingest.
          return new File([blob], name, { type: blob.type });
        }),
      );
      await upload(loaded, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  const onDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (busy) return;
    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length > 0) setFiles(dropped);
  };

  const doneCount = STAGE_ROWS.filter((row) => stages[row.key]?.status === "done").length;
  const started = Object.keys(stages).length > 0;
  const progress = Math.round((doneCount / STAGE_ROWS.length) * 100);

  return (
    <div className="shell flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Reconstruct what actually happened
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Drop in a project&apos;s Jira, email and Slack exports. The tool builds one event store,
          runs investigators over it, verifies every claim against its source quote, and gives you a
          timeline, a commitments ledger and the gaps in the record.
        </p>
      </section>

      <section className="card flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label className="field-label" htmlFor="escalation">
            Escalation <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea
            id="escalation"
            className="input min-h-24"
            placeholder="Paste the client escalation. Leave blank and the analyst will infer it from the records."
            value={escalation}
            onChange={(event) => setEscalation(event.target.value)}
            disabled={busy}
          />
        </div>

        <div
          className={`flex flex-col gap-3 rounded-xl border-2 border-dashed p-4 transition-colors ${
            dragging ? "border-accent bg-surface-2" : "border-line"
          }`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p className="text-sm font-medium">
            Exports <span className="font-normal text-muted">— drag files here, or choose them</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn btn-secondary cursor-pointer">
              Choose files
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(event) =>
                  setFiles(event.target.files ? Array.from(event.target.files) : [])
                }
                disabled={busy}
              />
            </label>
            <label className="btn btn-secondary cursor-pointer">
              Choose Slack folder
              <input
                ref={directoryInput}
                type="file"
                multiple
                className="sr-only"
                onChange={(event) =>
                  setFiles(event.target.files ? Array.from(event.target.files) : [])
                }
                disabled={busy}
              />
            </label>
            {files.length > 0 && (
              <button type="button" className="btn btn-ghost" onClick={() => setFiles([])} disabled={busy}>
                clear
              </button>
            )}
          </div>
          <p className="hint">
            Jira JSON · <span className="font-mono">.mbox</span>/{" "}
            <span className="font-mono">.eml</span> email · a Slack export folder or a{" "}
            <span className="font-mono">.zip</span> of it. Up to 8&nbsp;MB.
          </p>
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((file) => (
                <li key={`${file.webkitRelativePath || file.name}-${file.size}`} className="pill pill-neutral font-mono">
                  {file.webkitRelativePath || file.name}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || files.length === 0}
            onClick={() => upload(files, false)}
          >
            {busy ? "Running…" : "Run investigation"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={loadDemo}>
            Load built-in demo exports
          </button>
        </div>

        {synthetic && (
          <p className="callout callout-warn">
            <span aria-hidden>◆</span>
            Synthetic demo data (Northwind / Meridian) — generated exports, not a real project.
          </p>
        )}
        {eventCount !== null && !busy && (
          <p className="hint">{eventCount} events ingested.</p>
        )}
        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {warnings.map((warning) => (
              <li key={warning} className="callout callout-info">
                <span aria-hidden>•</span>
                {warning}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <div className="callout callout-bad">
            <span aria-hidden>✗</span>
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              {run && (
                <div className="flex gap-2">
                  <button type="button" className="btn btn-secondary" onClick={retry} disabled={busy}>
                    Retry run
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      setError(null);
                      setStages({});
                      setRun(null);
                    }}
                  >
                    Start over
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="card flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Pull from live sources</h2>
          <span className="hint">read-only · credentials stay server-side</span>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {sources.map((source) => {
            const sourceTargets = targets[source.id] ?? [];
            const selected = selectedTargets[source.id] ?? [];
            const isGmail = source.id === "gmail";
            return (
              <div key={source.id} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{source.label}</span>
                  {source.configured ? (
                    <span className="pill pill-ok">configured</span>
                  ) : (
                    <span className="pill pill-warn">off</span>
                  )}
                </div>

                {!source.configured && (
                  <p className="hint">
                    Missing env: <span className="font-mono">{source.missingEnv.join(", ")}</span>
                  </p>
                )}

                {source.configured && (
                  <>
                    <button
                      type="button"
                      className="btn btn-secondary self-start"
                      disabled={busy || (sourceTargets.length > 0 && !isGmail)}
                      onClick={() => loadTargets(source.id)}
                    >
                      {sourceTargets.length > 0 ? "reload targets" : "load targets"}
                    </button>

                    {sourceTargets.length > 0 && !isGmail && (
                      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                        {sourceTargets.map((target) => (
                          <li key={target.id}>
                            <label className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={selected.includes(target.id)}
                                onChange={() => toggleTarget(source.id, target.id)}
                                disabled={busy}
                              />
                              {target.label}
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}

                    {(isGmail || source.id === "jira") && (
                      <input
                        className="input"
                        placeholder={
                          source.id === "jira"
                            ? "JQL (optional): project = MER ORDER BY created ASC"
                            : "Gmail query: label:meridian newer_than:90d"
                        }
                        value={sourceQuery[source.id] ?? ""}
                        onChange={(event) =>
                          setSourceQuery((current) => ({ ...current, [source.id]: event.target.value }))
                        }
                        disabled={busy}
                      />
                    )}

                    <button
                      type="button"
                      className="btn btn-primary self-start"
                      disabled={busy || (!isGmail && selected.length === 0)}
                      onClick={() => pullFromSource(source.id)}
                    >
                      Pull {isGmail ? "messages" : sourceTargets.length > 0 ? `${selected.length} selected` : ""}
                    </button>

                    {sourceError[source.id] && (
                      <p className="callout callout-bad">{sourceError[source.id]}</p>
                    )}
                  </>
                )}
              </div>
            );
          })}
          {sources.length === 0 && (
            <p className="hint md:col-span-3">
              No live sources are configured. Add JIRA_*/SLACK_TOKEN/GMAIL_* env vars and restart.
            </p>
          )}
        </div>
      </section>

      <section className="card flex flex-col gap-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Progress</h2>
          <span className="hint">
            {doneCount}/{STAGE_ROWS.length} stages
          </span>
        </div>

        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${started ? progress : 0}%` }}
          />
        </div>

        <ul className="flex flex-col gap-2">
          {STAGE_ROWS.map((row) => {
            const state = stages[row.key];
            const status = state?.status ?? "pending";
            const logs = serverLogs[row.key];
            return (
              <li key={row.key} className="flex flex-col gap-1">
                <div className="flex items-start gap-2 text-sm">
                  <StageIcon status={status} />
                  <span className={status === "pending" ? "text-muted" : "text-ink"}>{row.label}</span>
                  {state?.pass && state.pass > 1 && (
                    <span className="pill pill-info">retry pass {state.pass}</span>
                  )}
                  {state?.error && <span className="text-xs text-bad-fg">{state.error}</span>}
                </div>
                {logs && logs.length > 0 && (
                  <details className="ml-6 text-xs text-muted">
                    <summary className="cursor-pointer hover:text-ink">
                      tool log ({logs.length} entries)
                    </summary>
                    <pre className="mt-1 max-h-40 overflow-auto rounded-lg border border-line bg-surface-2 p-2">
                      {logs.map((entry) => JSON.stringify(entry)).join("\n")}
                    </pre>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}

function StageIcon({ status }: { status: string }) {
  if (status === "done") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ok-bg text-[11px] text-ok-fg" aria-label="done">
        ✓
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center" aria-label="running">
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-line border-t-accent" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-bad-bg text-[11px] text-bad-fg" aria-label="failed">
        ✗
      </span>
    );
  }
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-line text-[10px] text-muted" aria-label="pending">
      ○
    </span>
  );
}
