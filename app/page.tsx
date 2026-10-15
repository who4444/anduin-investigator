"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { runPipeline, type StageUpdate } from "@/lib/orchestrator";

const STAGE_LABELS: Record<string, string> = {
  plan: "Analyst writes the investigation plan",
  root_cause: "Investigator · root cause",
  commitments: "Investigator · commitments",
  ownership: "Investigator · decisions & ownership",
  skeptic: "Skeptic challenges the findings",
  verify: "Code verifier checks every quote",
  assemble: "Assemble timeline, ledger and gaps",
};

type StageState = { status: string; error?: string | null; pass: number };

interface UploadResult {
  investigationId: string;
  eventCount: number;
  cached: boolean;
  warnings: string[];
}

export default function Home() {
  const router = useRouter();
  const [escalation, setEscalation] = useState("");
  const [files, setFiles] = useState<FileList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [synthetic, setSynthetic] = useState(false);
  const [stages, setStages] = useState<Record<string, StageState>>({});
  const [eventCount, setEventCount] = useState<number | null>(null);

  const applyStage = (update: StageUpdate) => {
    setStages((current) => ({
      ...current,
      [update.stage]: { status: update.status, error: update.error ?? null, pass: update.pass },
    }));
  };

  async function submit(uploadFiles: File[], isSynthetic: boolean) {
    setBusy(true);
    setError(null);
    setStages({});
    setWarnings([]);
    setEventCount(null);
    setSynthetic(isSynthetic);

    try {
      const form = new FormData();
      for (const file of uploadFiles) form.append("files", file);
      form.append("escalation", escalation);

      const response = await fetch("/api/investigations", { method: "POST", body: form });
      const payload = (await response.json().catch(() => ({}))) as Partial<UploadResult> & { error?: string };
      if (!response.ok || !payload.investigationId) {
        throw new Error(payload.error ?? "Upload failed.");
      }

      setEventCount(payload.eventCount ?? 0);
      setWarnings(payload.warnings ?? []);

      if (payload.cached) {
        setStages({ assemble: { status: "done", pass: 1 } });
        router.push(`/investigations/${payload.investigationId}`);
        return;
      }

      const outcome = await runPipeline(payload.investigationId, { onStage: applyStage });
      if (!outcome.ok) {
        throw new Error(`${outcome.stage} stage failed: ${outcome.error}`);
      }

      router.push(`/investigations/${payload.investigationId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function loadDemo() {
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
          return new File([blob], name.split("/").pop() ?? name, { type: blob.type });
        }),
      );
      await submit(loaded, true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Anduin Investigator</h1>
        <p className="text-sm text-neutral-600">
          Upload a project&apos;s Jira, email and Slack exports. The tool builds one event store and
          produces a source-backed timeline, commitments ledger and gaps list.
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-lg border border-neutral-200 p-5">
        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Escalation (optional)</span>
          <textarea
            className="min-h-24 rounded border border-neutral-300 p-2 text-sm"
            placeholder="Paste the client escalation. Leave blank and the analyst will infer it from the records."
            value={escalation}
            onChange={(event) => setEscalation(event.target.value)}
            disabled={busy}
          />
        </label>

        <label className="flex flex-col gap-2">
          <span className="text-sm font-medium">Exports</span>
          <input
            type="file"
            multiple
            className="text-sm"
            onChange={(event) => setFiles(event.target.files)}
            disabled={busy}
          />
          <span className="text-xs text-neutral-500">
            Jira JSON, .mbox/.eml email, a Slack export folder (or a .zip of it). Up to 8 MB.
          </span>
        </label>

        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            disabled={busy || !files || files.length === 0}
            onClick={() => files && submit(Array.from(files), false)}
          >
            Run investigation
          </button>
          <button
            type="button"
            className="rounded border border-neutral-300 px-4 py-2 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={loadDemo}
          >
            Load built-in demo exports
          </button>
        </div>

        {synthetic && (
          <p className="text-xs font-medium text-amber-700">Synthetic demo data (Northwind / Meridian).</p>
        )}
        {eventCount !== null && (
          <p className="text-xs text-neutral-500">{eventCount} events ingested.</p>
        )}
        {warnings.length > 0 && (
          <ul className="list-disc pl-5 text-xs text-neutral-500">
            {warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">Progress</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {Object.entries(STAGE_LABELS).map(([stage, label]) => {
            const state = stages[stage];
            const status = state?.status ?? "pending";
            const icon = status === "done" ? "✓" : status === "running" ? "…" : status === "error" ? "✗" : "•";
            return (
              <li key={stage} className="flex items-start gap-2">
                <span className="w-4 text-center">{icon}</span>
                <span className="flex-1">{label}</span>
                {state?.pass && state.pass > 1 && (
                  <span className="text-xs text-neutral-500">retry pass {state.pass}</span>
                )}
                {state?.error && <span className="text-xs text-red-600">{state.error}</span>}
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
