"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import {
  CheckIcon,
  CircleIcon,
  InfoIcon,
  SpinnerIcon,
  WarnIcon,
  XIcon,
} from "@/app/_components/icons";
import { runPipeline, type StageUpdate } from "@/lib/orchestrator";

const STAGE_ROWS: { key: string; label: string }[] = [
  { key: "plan", label: "Reading the records and drafting an investigation plan" },
  { key: "root_cause", label: "Tracing what went wrong" },
  { key: "commitments", label: "Checking what was promised" },
  { key: "ownership", label: "Checking who owned what, and where handoffs failed" },
  { key: "skeptic", label: "Testing the findings for contradictions" },
  { key: "verify", label: "Verifying every quote against its source" },
  { key: "assemble", label: "Building your timeline, promises and gaps" },
];

type StageState = { status: string; error?: string | null; pass: number };

interface UploadResult {
  investigationId: string;
  eventCount: number;
  cached: boolean;
  warnings: string[];
}

interface SourceInfo {
  id: string;
  label: string;
  configured: boolean;
  missingEnv: string[];
}

interface SourceTargetInfo {
  id: string;
  label: string;
}

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
      if (!response.ok) throw new Error(body.error ?? "Could not load the list.");
      setTargets((current) => ({ ...current, [sourceId]: body.targets ?? [] }));
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

  function resetRunState() {
    setError(null);
    setStages({});
    setWarnings([]);
    setEventCount(null);
    setRun(null);
  }

  async function drivePipeline(investigationId: string, flags: { synthetic: boolean; live?: boolean }) {
    const outcome = await runPipeline(investigationId, { onStage: applyStage });
    if (!outcome.ok) {
      throw new Error(`${outcome.stage} stage failed: ${outcome.error}`);
    }
    router.push(resultsHref(investigationId, { ...flags, cached: false }));
  }

  async function upload(uploadFiles: File[], isSynthetic: boolean) {
    setBusy(true);
    resetRunState();
    setSynthetic(isSynthetic);

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

  async function pullFromSource(sourceId: string) {
    const selected = selectedTargets[sourceId] ?? [];
    const query = sourceQuery[sourceId]?.trim() ?? "";

    setBusy(true);
    resetRunState();
    setSynthetic(false);
    setSourceError((current) => ({ ...current, [sourceId]: "" }));

    try {
      const response = await fetch("/api/sources/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: sourceId, targets: selected, query: query || undefined, escalation }),
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
      if (!manifestResponse.ok) throw new Error("The built-in demo exports are unavailable.");
      const manifest = (await manifestResponse.json()) as { files: string[] };

      const loaded = await Promise.all(
        manifest.files.map(async (name) => {
          const response = await fetch(`/demo/${name}`);
          if (!response.ok) throw new Error(`Missing demo file: ${name}`);
          const blob = await response.blob();
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

  const configuredSources = sources.filter((source) => source.configured);
  const doneCount = STAGE_ROWS.filter((row) => stages[row.key]?.status === "done").length;
  const started = Object.keys(stages).length > 0;
  const progress = Math.round((doneCount / STAGE_ROWS.length) * 100);

  return (
    <div className="shell flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          Answer the client in minutes
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted">
          Drop in the project&apos;s Jira, email and Slack exports. You get one ordered timeline of
          what happened, every promise that was made and whether it was kept, and an explicit list
          of what the records cannot tell you. Every finding links back to the original message.
        </p>
      </section>

      <section className="card flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <label className="field-label" htmlFor="escalation">
            What is the client asking? <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea
            id="escalation"
            className="input min-h-24"
            placeholder="Paste the escalation. Leave blank and it will be inferred from the records."
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
            Project history{" "}
            <span className="font-normal text-muted">— drag files here, or choose them</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="btn btn-secondary cursor-pointer">
              Choose files
              <input
                type="file"
                multiple
                className="sr-only"
                onChange={(event) => setFiles(event.target.files ? Array.from(event.target.files) : [])}
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
                onChange={(event) => setFiles(event.target.files ? Array.from(event.target.files) : [])}
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
            Jira JSON · email <span className="font-mono">.mbox</span>/
            <span className="font-mono">.eml</span> · a Slack export folder or a{" "}
            <span className="font-mono">.zip</span> of it. Up to 8&nbsp;MB.
          </p>
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((file) => (
                <li
                  key={`${file.webkitRelativePath || file.name}-${file.size}`}
                  className="pill pill-neutral font-mono"
                >
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
            {busy ? "Working…" : "Reconstruct what happened"}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={loadDemo}>
            Try the built-in demo
          </button>
        </div>

        {synthetic && (
          <p className="callout callout-warn">
            <WarnIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Synthetic demo data (Northwind / Meridian) — generated exports, not a real project.
          </p>
        )}
        {eventCount !== null && !busy && <p className="hint">{eventCount} events read.</p>}
        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1">
            {warnings.map((warning) => (
              <li key={warning} className="callout callout-info">
                <InfoIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {warning}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <div className="callout callout-bad">
            <XIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="flex flex-col gap-2">
              <span>{error}</span>
              {run && (
                <div className="flex gap-2">
                  <button type="button" className="btn btn-secondary" onClick={retry} disabled={busy}>
                    Try again
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => {
                      resetRunState();
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

      {configuredSources.length > 0 && (
        <section className="card flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="section-title">Connected sources</h2>
            <span className="hint">read-only access</span>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            {configuredSources.map((source) => {
              const sourceTargets = targets[source.id] ?? [];
              const selected = selectedTargets[source.id] ?? [];
              const isGmail = source.id === "gmail";
              return (
                <div key={source.id} className="flex flex-col gap-2 rounded-xl border border-line p-3">
                  <span className="text-sm font-medium">{source.label}</span>

                  {!isGmail && (
                    <button
                      type="button"
                      className="btn btn-secondary self-start"
                      disabled={busy || sourceTargets.length > 0}
                      onClick={() => loadTargets(source.id)}
                    >
                      {sourceTargets.length > 0 ? "reload" : "choose what to pull"}
                    </button>
                  )}

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
                          ? "Which issues? (optional, defaults to the whole project)"
                          : "Which emails? e.g. label:meridian newer_than:90d"
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
                    Pull into a new investigation
                  </button>

                  {sourceError[source.id] && (
                    <p className="callout callout-bad">
                      <XIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {sourceError[source.id]}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="card flex flex-col gap-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <h2 className="section-title">Progress</h2>
          <span className="hint">
            {doneCount}/{STAGE_ROWS.length}
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
            return (
              <li key={row.key} className="flex items-start gap-2 text-sm">
                <StageIcon status={status} />
                <span className={status === "pending" ? "text-muted" : "text-ink"}>{row.label}</span>
                {state?.pass && state.pass > 1 && <span className="pill pill-info">pass {state.pass}</span>}
                {state?.error && <span className="text-xs text-bad-fg">{state.error}</span>}
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
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-ok-bg text-ok-fg">
        <CheckIcon className="h-3 w-3" />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center text-accent">
        <SpinnerIcon className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full bg-bad-bg text-bad-fg">
        <XIcon className="h-3 w-3" />
      </span>
    );
  }
  return (
    <span className="mt-0.5 grid h-4 w-4 shrink-0 place-items-center text-muted">
      <CircleIcon className="h-3 w-3" />
    </span>
  );
}
