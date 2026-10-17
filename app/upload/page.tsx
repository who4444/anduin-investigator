"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

/* A dropped folder surfaces as a single File with no children; read the
   real entries recursively so a Slack export folder keeps its channel paths
   (the zip and folder-picker paths never had this problem). */
async function readDropped(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items ?? [])
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter((entry): entry is FileSystemEntry => entry !== null);
  if (entries.length === 0) return Array.from(dataTransfer.files);

  const out: File[] = [];
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    if (entry.isFile) {
      const file = await new Promise<File | null>((resolve) =>
        (entry as FileSystemFileEntry).file(resolve, () => resolve(null)),
      );
      if (file) {
        const name = prefix ? `${prefix}/${file.name}` : file.name;
        out.push(new File([file], name, { type: file.type }));
      }
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    const children: FileSystemEntry[] = [];
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) =>
        reader.readEntries(resolve, () => resolve([])),
      );
      if (batch.length === 0) break;
      children.push(...batch);
    }
    const next = prefix ? `${prefix}/${entry.name}` : entry.name;
    for (const child of children) await walk(child, next);
  };
  for (const entry of entries) await walk(entry, "");
  return out.length > 0 ? out : Array.from(dataTransfer.files);
}

export default function UploadPage() {
  const router = useRouter();
  const directoryInput = useRef<HTMLInputElement | null>(null);
  const [escalation, setEscalation] = useState("");
  const [client, setClient] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  async function ingest(uploadFiles: File[], flag: string) {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      for (const file of uploadFiles) {
        form.append("files", file, file.webkitRelativePath || file.name);
      }
      form.append("escalation", escalation);
      form.append("client", client);

      const response = await fetch("/api/investigations", { method: "POST", body: form });
      const payload = (await response.json().catch(() => ({}))) as {
        investigationId?: string;
        cached?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.investigationId) {
        throw new Error(payload.error ?? "Upload failed.");
      }

      const suffix = payload.cached ? `${flag}&cached=1` : flag;
      router.push(`/investigations/${payload.investigationId}/progress?${suffix}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  async function loadScenario() {
    setBusy(true);
    setError(null);
    try {
      const manifestResponse = await fetch("/demo/manifest.json");
      if (!manifestResponse.ok) throw new Error("The built-in scenario files are unavailable.");
      const manifest = (await manifestResponse.json()) as { files: string[] };
      const loaded = await Promise.all(
        manifest.files.map(async (name) => {
          const response = await fetch(`/demo/${name}`);
          if (!response.ok) throw new Error(`Missing scenario file: ${name}`);
          const blob = await response.blob();
          return new File([blob], name, { type: blob.type });
        }),
      );
      await ingest(loaded, "synthetic=1");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <div className="shell shell-sm stack">
      <div className="row">
        <Link href="/">← Back to sources</Link>
      </div>
      <h1>Upload exports instead</h1>
      <p className="small muted">
        Use this when a source is not connected. The same pipeline runs over whatever files you provide.
      </p>

      <section className="panel stack">
        <label className="field">
          <span className="field-label">The client&apos;s escalation (optional)</span>
          <textarea
            className="input"
            value={escalation}
            onChange={(event) => setEscalation(event.target.value)}
            placeholder="Paste the escalation message here."
          />
        </label>

        <label className="field">
          <span className="field-label">Client (if known)</span>
          <input
            className="input"
            value={client}
            onChange={(event) => setClient(event.target.value)}
            placeholder="e.g. Northwind Logistics — keeps the client's own records in scope."
          />
        </label>

        <div
          className={dragging ? "dropzone is-dragging" : "dropzone"}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void readDropped(event.dataTransfer).then((dropped) => {
              if (dropped.length > 0) setFiles(dropped);
            });
          }}
        >
          <div className="row">
            <label className="btn">
              Choose files
              <input
                type="file"
                multiple
                hidden
                onChange={(event) => setFiles(event.target.files ? Array.from(event.target.files) : [])}
                disabled={busy}
              />
            </label>
            <label className="btn">
              Choose Slack folder
              <input
                ref={directoryInput}
                type="file"
                multiple
                hidden
                onChange={(event) => setFiles(event.target.files ? Array.from(event.target.files) : [])}
                disabled={busy}
              />
            </label>
            {files.length > 0 && (
              <button type="button" className="btn btn-quiet" onClick={() => setFiles([])} disabled={busy}>
                Clear
              </button>
            )}
          </div>
          <p className="small muted mt-2">
            Jira JSON · email .mbox/.eml · a Slack export folder or a .zip of it. Up to 8 MB.
          </p>
          {files.length > 0 && (
            <p className="row mt-2">
              {files.map((file) => (
                <span className="chip" key={`${file.webkitRelativePath || file.name}-${file.size}`}>
                  {file.webkitRelativePath || file.name}
                </span>
              ))}
            </p>
          )}
        </div>

        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || files.length === 0}
            onClick={() => ingest(files, "uploads=1")}
          >
            {busy ? "Reading…" : "Investigate these exports"}
          </button>
          <button type="button" className="btn" onClick={loadScenario} disabled={busy}>
            Load Northwind scenario
          </button>
          <span className="chip chip-broken">synthetic data</span>
        </div>
        {error && <p className="alert alert-error">{error}</p>}
      </section>
    </div>
  );
}
