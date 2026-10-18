"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { cleanReportTitle } from "@/lib/report/model";

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

interface ScopeState {
  targets: string[];
  query: string;
}

const SCENARIO_ESCALATION =
  "Northwind reports that our Meridian Billing vendor's invoice totals have been wrong since release 4.12, our finance team is blocked, and we have not had a reply to four messages. Please explain what happened and when this will be fixed.";

const MULTI_ESCALATION =
  "Contoso has two independent issues. First, VAT invoice totals have been blank since the 2.1.0 upgrade; the fix was promised for the Sep 20 release and the ticket was closed while the totals were still blank. Second, finance users cannot sign in since the identity migration; the SSO fix was promised for the Sep 26 release and still fails. Our chases on 22 and 23 September went unanswered. Explain what happened on each issue and when each will actually be fixed.";

interface RecentInvestigation {
  id: string;
  title: string;
  createdAt: string;
  origin: string;
  complete: boolean;
}

export default function StartPage() {
  const router = useRouter();
  const [escalation, setEscalation] = useState("");
  const [client, setClient] = useState("");
  const [synthetic, setSynthetic] = useState(false);
  const [scenario, setScenario] = useState<"northwind" | "multi">("northwind");
  const [recent, setRecent] = useState<RecentInvestigation[]>([]);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [targets, setTargets] = useState<Record<string, SourceTargetInfo[]>>({});
  const [scopes, setScopes] = useState<Record<string, ScopeState>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/sources")
      .then((response) => (response.ok ? response.json() : { sources: [] }))
      .then((body: { sources?: SourceInfo[] }) => {
        setSources(body.sources ?? []);
        for (const source of body.sources ?? []) {
          if (!source.configured) continue;
          fetch(`/api/sources?targets=${encodeURIComponent(source.id)}`)
            .then((response) => (response.ok ? response.json() : { targets: [] }))
            .then((targetBody: { targets?: SourceTargetInfo[] }) =>
              setTargets((current) => ({ ...current, [source.id]: targetBody.targets ?? [] })),
            )
            .catch(() => undefined);
        }
      })
      .catch(() => setSources([]));

    fetch("/api/investigations")
      .then((response) => (response.ok ? response.json() : { investigations: [] }))
      .then((body: { investigations?: RecentInvestigation[] }) => setRecent(body.investigations ?? []))
      .catch(() => undefined);
  }, []);

  const setScope = (sourceId: string, patch: Partial<ScopeState>) => {
    setScopes((current) => ({
      ...current,
      [sourceId]: { ...{ targets: [], query: "" }, ...current[sourceId], ...patch },
    }));
  };

  const toggleTarget = (sourceId: string, targetId: string) => {
    const scope = scopes[sourceId] ?? { targets: [], query: "" };
    setScope(sourceId, {
      targets: scope.targets.includes(targetId)
        ? scope.targets.filter((id) => id !== targetId)
        : [...scope.targets, targetId],
    });
  };

  const connected = sources.filter((source) => source.configured);
  const anyScope = connected.some(
    (source) =>
      source.id === "gmail"
        ? (scopes.gmail?.query ?? "").trim().length > 0
        : (scopes[source.id]?.targets.length ?? 0) > 0,
  );
  const canInvestigate = !busy && (synthetic || anyScope);

  function loadScenario() {
    setEscalation(SCENARIO_ESCALATION);
    setClient("Northwind Logistics");
    setSynthetic(true);
    setScenario("northwind");
  }

  function loadMultiScenario() {
    setEscalation(MULTI_ESCALATION);
    setClient("Contoso");
    setSynthetic(true);
    setScenario("multi");
  }

  async function startSynthetic() {
    const base = scenario === "multi" ? "/multi" : "/demo";
    const title =
      scenario === "multi"
        ? "Contoso — two independent issues after 2.1.0"
        : "Northwind Logistics — invoice totals after release 4.12";
    const manifestResponse = await fetch(`${base}/manifest.json`);
    if (!manifestResponse.ok) throw new Error("The built-in scenario files are unavailable.");
    const manifest = (await manifestResponse.json()) as { files: string[] };

    const form = new FormData();
    for (const name of manifest.files) {
      const response = await fetch(`${base}/${name}`);
      if (!response.ok) throw new Error(`Missing scenario file: ${name}`);
      const blob = await response.blob();
      form.append("files", new File([blob], name, { type: blob.type }));
    }
    form.append("escalation", escalation);
    form.append("client", client);
    form.append("origin", "demo");
    form.append("title", title);

    const response = await fetch("/api/investigations", { method: "POST", body: form });
    const payload = (await response.json().catch(() => ({}))) as { investigationId?: string; error?: string; cached?: boolean };
    if (!response.ok || !payload.investigationId) throw new Error(payload.error ?? "Could not start the investigation.");
    return { investigationId: payload.investigationId, flag: payload.cached ? "synthetic=1&cached=1" : "synthetic=1" };
  }

  async function startLive() {
    const entries = connected
      .map((source) => ({
        source: source.id,
        targets: scopes[source.id]?.targets ?? [],
        query: (scopes[source.id]?.query ?? "").trim() || undefined,
      }))
      .filter((entry) => (entry.source === "gmail" ? Boolean(entry.query) : entry.targets.length > 0));

    const response = await fetch("/api/sources/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sources: entries, escalation, client }),
    });
    const payload = (await response.json().catch(() => ({}))) as { investigationId?: string; error?: string };
    if (!response.ok || !payload.investigationId) throw new Error(payload.error ?? "Could not pull the selected sources.");
    return { investigationId: payload.investigationId, flag: "live=1" };
  }

  async function investigate() {
    setBusy(true);
    setError(null);
    try {
      const result = synthetic ? await startSynthetic() : await startLive();
      router.push(`/investigations/${result.investigationId}/progress?${result.flag}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  const hasSources = connected.length > 0;

  return (
    <div className="shell shell-sm stack">
      <h1>Begin an investigation</h1>

      <section className="panel stack">
        <label className="field">
          <span className="field-label">The client&apos;s escalation</span>
          <textarea
            className="input"
            value={escalation}
            onChange={(event) => {
              setEscalation(event.target.value);
              setSynthetic(false);
            }}
            placeholder="Paste the escalation message here."
          />
        </label>
        <label className="field">
          <span className="field-label">Client (the external party)</span>
          <input
            className="input"
            value={client}
            onChange={(event) => setClient(event.target.value)}
            placeholder="e.g. Northwind Logistics — the party who escalated, not the product or vendor."
          />
          <span className="small muted">
            Name the external party who escalated, not the product or vendor. The project/product is
            confirmed from the records after the plan.
          </span>
        </label>
        <div className="row">
          <button type="button" className="btn" onClick={loadScenario} disabled={busy}>
            Load Northwind scenario
          </button>
          <button type="button" className="btn" onClick={loadMultiScenario} disabled={busy}>
            Load multi-issue scenario
          </button>
          <span className="chip chip-broken">synthetic data</span>
        </div>
      </section>

      <section className="panel">
        <h2>Sources</h2>
        {sources.length === 0 && (
          <p className="small muted">Checking source connections…</p>
        )}
        {sources.map((source) => {
          const scope = scopes[source.id] ?? { targets: [], query: "" };
          const sourceTargets = targets[source.id] ?? [];
          return (
            <div className="source-row" key={source.id}>
              <span className="strong">{source.label}</span>
              <span>
                {source.configured ? (
                  <span className="chip chip-verified">connected</span>
                ) : (
                  <span className="chip">not connected</span>
                )}
              </span>
              <span className="scope-inputs">
                {source.configured && source.id === "jira" && (
                  <>
                    {sourceTargets.length === 0 && <span className="small muted">Loading projects…</span>}
                    {sourceTargets.map((target) => (
                      <label key={target.id} className="small row row-tight">
                        <input
                          type="checkbox"
                          checked={scope.targets.includes(target.id)}
                          onChange={() => toggleTarget(source.id, target.id)}
                        />
                        {target.label}
                      </label>
                    ))}
                  </>
                )}
                {source.configured && source.id === "slack" && (
                  <>
                    {sourceTargets.length === 0 && <span className="small muted">Loading channels…</span>}
                    {sourceTargets.slice(0, 24).map((target) => (
                      <label key={target.id} className="small row row-tight">
                        <input
                          type="checkbox"
                          checked={scope.targets.includes(target.id)}
                          onChange={() => toggleTarget(source.id, target.id)}
                        />
                        {target.label}
                      </label>
                    ))}
                  </>
                )}
                {source.configured && source.id === "gmail" && (
                  <input
                    className="input"
                    placeholder="Mailbox filter, e.g. label:meridian newer_than:90d"
                    value={scope.query}
                    onChange={(event) => setScope(source.id, { query: event.target.value })}
                  />
                )}
                {!source.configured && (
                  <span className="small muted">
                    Read-only credentials are held by the server. Ask the admin to connect this source.
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </section>

      <div className="stack">
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={investigate} disabled={!canInvestigate}>
            {busy ? "Starting…" : "Investigate"}
          </button>
          <a href="/upload">Use uploaded exports instead</a>
        </div>
        {!canInvestigate && !busy && (
          <p className="small muted">
            Paste the client&apos;s escalation and choose sources to begin, or load the synthetic scenario.
          </p>
        )}
        {hasSources && !anyScope && !synthetic && (
          <p className="small muted">Select at least one project, channel or mailbox filter to investigate live.</p>
        )}
        {error && <p className="alert alert-error">{error}</p>}
      </div>

      {recent.length > 0 && (
        <section className="panel stack">
          <h2>Recent investigations</h2>
          <ul className="stack stack-sm">
            {recent.map((entry) => (
              <li key={entry.id} className="row small">
                <a href={`/investigations/${entry.id}`}>
                  {entry.title.trim() ? cleanReportTitle(entry.title) : entry.id.slice(0, 8)}
                </a>
                <span className="muted tabular">{entry.createdAt.slice(0, 10)}</span>
                {entry.origin === "demo" && <span className="chip chip-broken">synthetic</span>}
                {!entry.complete && <span className="chip">in progress</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
