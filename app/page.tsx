"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { SourceIcon } from "@/app/_components/icons";
import { cleanReportTitle } from "@/lib/report/model";

interface SourceInfo {
  id: string;
  label: string;
  configured: boolean;
  missingEnv: string[];
  /** What the source will search by default ("searching everything …",
      "mail: <query>", "not connected"). */
  detail?: string;
}

interface SourceTargetInfo {
  id: string;
  label: string;
  meta?: { hidden?: boolean; isMember?: boolean };
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

/* The three source groups render in a stable order. */
const SOURCE_ORDER = ["jira", "slack", "gmail"] as const;

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
  const [targetSearch, setTargetSearch] = useState("");
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
  const hasEscalation = escalation.trim().length > 0;
  const canInvestigate = !busy && hasEscalation && (synthetic || connected.length > 0);

  const gmail = connected.find((source) => source.id === "gmail");
  const gmailQuery = (scopes.gmail?.query ?? "").trim();
  const gmailReady = Boolean(gmail) && (gmailQuery.length > 0 || (gmail?.detail ?? "").startsWith("mail:"));
  const searchable = connected.filter((source) => source.id !== "gmail" || gmailReady);

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
    // No selection = search everything these sources have access to; a
    // selection in Advanced narrows the pull.
    const entries = searchable.map((source) => ({
      source: source.id,
      targets: scopes[source.id]?.targets ?? [],
      query: source.id === "gmail" ? gmailQuery || undefined : undefined,
    }));

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

  const loadingSources = sources.length === 0;

  /* Connection status: what will actually be searched, no choosing required. */
  const connectedNames = searchable.map((source) => source.label).join(", ");
  const skipped = connected.filter((source) => !searchable.includes(source));
  const statusLine = busy
    ? "Starting the investigation…"
    : synthetic
      ? "Sample scenario loaded — the investigation runs on the built-in synthetic export."
      : !hasEscalation
        ? "Paste the client's escalation to begin."
        : connected.length === 0
          ? "No live sources are connected — ask the admin, or use uploaded exports instead."
          : `${connectedNames} connected — searching everything you have access to.${
              skipped.length > 0
                ? ` ${skipped.map((source) => source.label).join(", ")} not searched: add a mailbox filter under Advanced.`
                : ""
            }`;

  const filterTargets = (list: SourceTargetInfo[]): SourceTargetInfo[] => {
    const query = targetSearch.trim().toLowerCase();
    if (!query) return list.filter((target) => target.meta?.hidden !== true);
    return list.filter((target) => `${target.id} ${target.label}`.toLowerCase().includes(query));
  };

  const jiraTargets = filterTargets(targets.jira ?? []).slice(0, 40);
  const slackTargets = filterTargets(targets.slack ?? []).slice(0, 40);
  const selectionCount = Object.values(scopes).reduce((total, scope) => total + scope.targets.length, 0);

  return (
    <div className="shell shell-sm stack start-shell">
      <div className="stack-sm">
        <h1>Begin an investigation</h1>
        <p className="muted">Paste the client&apos;s escalation and I search your connected sources — you confirm the scope before anything runs.</p>
      </div>

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
      </section>

      <section className="panel stack-sm source-status" aria-label="Source connection status">
        {loadingSources && <div className="skeleton skeleton-line" style={{ width: "46%" }} />}
        {!loadingSources &&
          SOURCE_ORDER.map((sourceId) => {
            const source = sources.find((entry) => entry.id === sourceId);
            if (!source) return null;
            return (
              <div className="conn-row" key={source.id}>
                <span className={`source-icon source-${source.id}`}>
                  <SourceIcon source={source.id} />
                </span>
                <span className="conn-name">{source.label}</span>
                <span className={`conn${source.configured ? " is-on" : ""}`}>
                  <span className="dot" />
                  {source.configured ? source.detail ?? "connected" : "not connected"}
                </span>
              </div>
            );
          })}
        {!loadingSources && connected.length === 0 && (
          <p className="small muted">
            No live sources are connected. Ask the admin to connect them, or{" "}
            <a href="/upload">use uploaded exports instead</a>.
          </p>
        )}
      </section>

      <details className="panel source-advanced">
        <summary>
          Advanced: limit sources
          {selectionCount > 0 && <span className="chip" style={{ marginLeft: "var(--sp-2)" }}>{selectionCount} selected</span>}
        </summary>
        <div className="stack-sm source-advanced-body">
          <p className="small muted">
            Leave everything empty to search all you have access to. Selecting projects or channels
            narrows the search; the system still proposes the final scope after the plan.
          </p>
          <input
            className="input"
            type="search"
            value={targetSearch}
            onChange={(event) => setTargetSearch(event.target.value)}
            placeholder="Search projects, channels or mail…"
            aria-label="Search source targets"
          />
          {(["jira", "slack", "gmail"] as const).map((sourceId) => {
            const source = sources.find((entry) => entry.id === sourceId);
            if (!source || !source.configured) return null;
            const scope = scopes[source.id] ?? { targets: [], query: "" };
            return (
              <div className="pick-group" key={source.id}>
                <span className="pick-group-title">
                  <SourceIcon source={source.id} size={16} /> {source.label}
                </span>
                {source.id === "gmail" ? (
                  <input
                    className="input"
                    placeholder="Mailbox filter, e.g. label:meridian newer_than:90d"
                    value={scope.query}
                    onChange={(event) => setScope(source.id, { query: event.target.value })}
                  />
                ) : (
                  <div className="pick-list">
                    {(source.id === "jira" ? jiraTargets : slackTargets).length === 0 && (
                      <span className="small muted">
                        {targetSearch.trim() ? "No matches." : source.id === "jira" ? "Loading projects…" : "Loading channels…"}
                      </span>
                    )}
                    {(source.id === "jira" ? jiraTargets : slackTargets).map((target) => {
                      const [key, ...rest] = target.label.split(" · ");
                      const name = rest.join(" · ");
                      return (
                        <button
                          key={target.id}
                          type="button"
                          className="pick"
                          aria-pressed={scope.targets.includes(target.id)}
                          title={name || key}
                          onClick={() => toggleTarget(source.id, target.id)}
                        >
                          {source.id === "jira" && rest.length > 0 && <span className="pick-key">{key}</span>}
                          <span className="pick-name">{source.id === "slack" ? target.label : name || key}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </details>

      <div className="sample-strip">
        <span className="small muted">Try a sample:</span>
        <button type="button" className="btn btn-sm" onClick={loadScenario} disabled={busy}>
          Load Northwind scenario
        </button>
        <button type="button" className="btn btn-sm" onClick={loadMultiScenario} disabled={busy}>
          Load multi-issue scenario
        </button>
        {synthetic && (
          <span className="chip" style={{ marginLeft: "auto" }}>
            synthetic data
          </span>
        )}
      </div>

      <div className="stack-sm">
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={investigate} disabled={!canInvestigate}>
            {busy ? "Starting…" : "Investigate"}
          </button>
          <a href="/upload">Use uploaded exports instead</a>
        </div>
        <p className="small muted">{statusLine}</p>
        {error && <p className="alert alert-error">{error}</p>}
      </div>

      {recent.length > 0 && (
        <section className="panel">
          <h2>Recent investigations</h2>
          <ul>
            {recent.map((entry) => (
              <li key={entry.id} className="recent-row">
                <a href={`/investigations/${entry.id}`}>
                  {entry.title.trim() ? cleanReportTitle(entry.title) : entry.id.slice(0, 8)}
                </a>
                <span className="muted tabular small">{entry.createdAt.slice(0, 10)}</span>
                <span className="row row-tight" style={{ justifyContent: "flex-end" }}>
                  {entry.origin === "demo" && <span className="chip">synthetic</span>}
                  <span className="chip">{entry.complete ? "complete" : "in progress"}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
