"use client";

import { useMemo, useState } from "react";

import { EvidenceDrawer, OutcomeChip, SourceChip } from "@/app/_components/evidence";
import type { Metric, ReportPayload, TimelineGroup, TimelineRow } from "@/lib/report/build";

type TabId = "overview" | "timeline" | "promises" | "ownership" | "gaps" | "reply";

const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Timeline" },
  { id: "promises", label: "Promises and client communication" },
  { id: "ownership", label: "Ownership and causes" },
  { id: "gaps", label: "Gaps and confidence" },
  { id: "reply", label: "Draft reply" },
];

interface ReportShellProps {
  report: ReportPayload;
  progressHref: string;
  synthetic: boolean;
  cached: boolean;
  live: boolean;
}

interface DrawerState {
  eventId: string;
  claimId?: string;
}

export function ReportShell({ report, progressHref, synthetic, cached, live }: ReportShellProps) {
  const [tab, setTab] = useState<TabId>("overview");
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [reply, setReply] = useState(report.reply);
  const [replyState, setReplyState] = useState<"idle" | "loading" | "error">("idle");
  const [replyError, setReplyError] = useState<string | null>(null);

  const sources = useMemo(
    () => [...new Set(report.events.map((event) => event.source))],
    [report.events],
  );

  const openClaim = (claimId: string | undefined) => {
    if (!claimId) return;
    const claim = report.claims.find((candidate) => candidate.id === claimId);
    if (claim) setDrawer({ eventId: claim.eventId, claimId });
  };

  const openMetric = (metric: Metric) => {
    if (metric.claimIds.length > 0) openClaim(metric.claimIds[0]);
    else if (metric.eventIds.length > 0) setDrawer({ eventId: metric.eventIds[0] });
  };

  async function draftReply() {
    setReplyState("loading");
    setReplyError(null);
    try {
      const response = await fetch(`/api/investigations/${report.investigation.id}/reply`, { method: "POST" });
      const payload = (await response.json().catch(() => ({}))) as {
        sentences?: { text: string; claimIds: string[] }[];
        error?: string;
      };
      if (!response.ok || !payload.sentences) throw new Error(payload.error ?? "Could not draft the reply.");
      setReply({ sentences: payload.sentences });
      setReplyState("idle");
    } catch (error) {
      setReplyState("error");
      setReplyError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div>
      <div className="report-header" style={{ position: "sticky" }}>
        <div className="report-header-inner">
          <div className="spread">
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>{report.investigation.title}</h1>
            <span className="row">
              {synthetic && <span className="chip chip-broken">synthetic data</span>}
              {live && <span className="chip">pulled live</span>}
              {cached && <span className="chip">cached result</span>}
            </span>
          </div>
          <p className="verdict">
            {report.verdict ?? "Verdict not drafted yet — open the Draft reply tab to build it from verified findings."}
          </p>
          <div className="report-meta small muted">
            <span className="tabular">Escalation {report.investigation.createdAt.slice(0, 10)}</span>
            <span aria-hidden>·</span>
            <span className="tabular">
              {report.stats.kept} of {report.stats.total} claims verified
            </span>
            <span aria-hidden>·</span>
            {sources.map((source) => (
              <SourceChip key={source} source={source} />
            ))}
            <span aria-hidden>·</span>
            <a href={progressHref}>How this was produced</a>
          </div>
        </div>
        <nav className="tabbar" role="tablist" aria-label="Report sections">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              id={`tab-${entry.id}`}
              aria-selected={tab === entry.id}
              aria-controls={`panel-${entry.id}`}
              className="tab"
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="shell" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "overview" && (
          <OverviewTab report={report} onMetric={openMetric} onClaim={openClaim} onReply={() => setTab("reply")} />
        )}
        {tab === "timeline" && <TimelineTab report={report} onClaim={openClaim} onEvent={(eventId) => setDrawer({ eventId })} />}
        {tab === "promises" && (
          <PromisesTab report={report} onClaim={openClaim} onEvent={(eventId) => setDrawer({ eventId })} />
        )}
        {tab === "ownership" && <OwnershipTab report={report} onClaim={openClaim} />}
        {tab === "gaps" && (
          <GapsTab report={report} onClaim={openClaim} onEvent={(eventId) => setDrawer({ eventId })} />
        )}
        {tab === "reply" && (
          <ReplyTab
            sentences={reply?.sentences ?? null}
            state={replyState}
            error={replyError}
            onDraft={draftReply}
            onClaim={openClaim}
          />
        )}
      </div>

      {drawer && (
        <EvidenceDrawer
          eventId={drawer.eventId}
          claimId={drawer.claimId}
          events={report.events}
          claims={report.claims}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

/* ------------------------------ overview ------------------------------ */

function OverviewTab({
  report,
  onMetric,
  onClaim,
  onReply,
}: {
  report: ReportPayload;
  onMetric: (metric: Metric) => void;
  onClaim: (claimId: string) => void;
  onReply: () => void;
}) {
  return (
    <div className="stack">
      <section className="panel stack">
        <h2>Bottom line</h2>
        <p style={{ maxWidth: "70ch" }}>
          {report.verdict ??
            "No verdict has been drafted yet. The verified findings are listed below and in the other tabs."}
        </p>
        <p className="small muted">
          Confidence: {report.stats.kept} of {report.stats.total} claims verified against their stored records
          {report.stats.flagged > 0 ? `, ${report.stats.flagged} flagged in skeptic review` : ""}.
        </p>
      </section>

      <section className="panel stack">
        <h2>Metrics</h2>
        <div className="metrics">
          {report.metrics.map((metric) => (
            <button
              key={metric.id}
              type="button"
              className="metric"
              onClick={() => onMetric(metric)}
              disabled={metric.claimIds.length === 0 && metric.eventIds.length === 0}
            >
              <span className="metric-value">{metric.value}</span>
              <span className="metric-label judgment" title="System classification">
                {metric.label}
              </span>
              {metric.detail && <span className="small muted">{metric.detail}</span>}
            </button>
          ))}
        </div>
        <p className="small muted">Every metric links to the findings or records behind it.</p>
      </section>

      <section className="panel stack">
        <h2>Top failures</h2>
        {report.failures.length === 0 ? (
          <p className="empty">No failure findings were verified.</p>
        ) : (
          <ul className="finding-list">
            {report.failures.map((finding) => (
              <li key={finding.claimId}>
                <button type="button" className="finding" style={{ width: "100%", textAlign: "left", cursor: "pointer" }} onClick={() => onClaim(finding.claimId)}>
                  <span className="finding-head">
                    <span className="tag judgment" title="System classification">{finding.tag}</span>
                    <span className="chip chip-verified">verified</span>
                  </span>
                  <span className="finding-text">{finding.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel stack">
        <h2>Recommended actions</h2>
        <div className="stack">
          <h3 className="small muted">Immediate</h3>
          <ul className="finding-list">
            {report.actions.immediate.map((action) => (
              <li key={action.text} className="finding">
                <span className="finding-text judgment" title="System recommendation">{action.text}</span>
                <span className="small muted">{action.reason}</span>
                {(action.claimIds.length > 0 || action.eventIds.length > 0) && (
                  <span className="row">
                    {action.claimIds.map((claimId) => (
                      <button key={claimId} type="button" className="btn btn-quiet" onClick={() => onClaim(claimId)}>
                        Evidence
                      </button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <h3 className="small muted">Follow-up</h3>
          {report.actions.followUp.length === 0 ? (
            <p className="small muted">No process follow-ups were derived from the findings.</p>
          ) : (
            <ul className="finding-list">
              {report.actions.followUp.map((action) => (
                <li key={action.text} className="finding">
                  <span className="finding-text judgment" title="System recommendation">{action.text}</span>
                  <span className="small muted">{action.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="row">
          <button type="button" className="btn btn-primary" onClick={onReply}>
            Draft the client reply
          </button>
        </div>
      </section>
    </div>
  );
}

/* ------------------------------ timeline ------------------------------ */

function TimelineTab({
  report,
  onClaim,
  onEvent,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  onEvent: (eventId: string) => void;
}) {
  const [actor, setActor] = useState("all");
  const [source, setSource] = useState("all");
  const [claimType, setClaimType] = useState("all");

  const claimById = new Map(report.claims.map((claim) => [claim.id, claim]));
  const actors = [...new Set(report.events.map((event) => event.actorResolved ?? event.actor))].sort();
  const types = [...new Set(report.claims.filter((claim) => claim.verifyStatus === "kept").map((claim) => claim.type))].sort();

  const passes = (row: TimelineRow): boolean => {
    if (row.kind === "silence") return true;
    const claim = claimById.get(row.claimId);
    if (actor !== "all" && row.actor !== actor) return false;
    if (source !== "all" && row.source !== source) return false;
    if (claimType !== "all" && claim?.type !== claimType) return false;
    return true;
  };

  const groups: TimelineGroup[] = report.timeline
    .map((group) => ({ date: group.date, rows: group.rows.filter(passes) }))
    .filter((group) => group.rows.length > 0);

  return (
    <div className="stack">
      <div className="panel row">
        <label className="small">
          Person{" "}
          <select className="input" value={actor} onChange={(event) => setActor(event.target.value)}>
            <option value="all">all</option>
            {actors.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </label>
        <label className="small">
          Source{" "}
          <select className="input" value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="all">all</option>
            {["jira", "email", "slack"].map((kind) => (
              <option key={kind} value={kind}>{kind}</option>
            ))}
          </select>
        </label>
        <label className="small">
          Claim type{" "}
          <select className="input" value={claimType} onChange={(event) => setClaimType(event.target.value)}>
            <option value="all">all</option>
            {types.map((type) => (
              <option key={type} value={type}>{type.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
      </div>

      {groups.length === 0 ? (
        <p className="empty">No verified findings for this filter.</p>
      ) : (
        <div className="panel">
          <div className="tl">
            {groups.map((group) => (
              <div key={group.date}>
                <h3 className="tl-date">{group.date}</h3>
                {group.rows.map((row, index) =>
                  row.kind === "silence" ? (
                    <div className="tl-silence" key={`${group.date}-silence-${index}`}>
                      <span className="muted small tabular">
                        {row.days}d
                      </span>
                      <span className="tl-silence-rule" aria-hidden />
                      <button
                        type="button"
                        className="tl-silence-label"
                        onClick={() => onEvent(row.eventIds[0])}
                        style={{ textAlign: "left", cursor: "pointer" }}
                      >
                        {row.label}
                      </button>
                    </div>
                  ) : (
                    <button
                      key={row.claimId}
                      type="button"
                      className="tl-entry"
                      onClick={() => onClaim(row.claimId)}
                      aria-label={`${row.actor}, ${row.source}, ${row.ts}: ${row.text}`}
                    >
                      <span className="tl-time">{row.ts.slice(11, 16)}</span>
                      <span className="tl-marker">
                        <span className={`tl-dot tl-dot-${row.source}`} />
                      </span>
                      <span className="tl-body">
                        <span className="tl-head">
                          <span className="tl-actor">{row.actor}</span>
                          <SourceChip source={row.source} />
                          <OutcomeChip outcome={row.status} judged={row.judged} />
                          {row.flagged && <span className="chip chip-flag">flagged</span>}
                        </span>
                        <span className="tl-claim">{row.text}</span>
                      </span>
                    </button>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ promises ------------------------------ */

function PromisesTab({
  report,
  onClaim,
  onEvent,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  onEvent: (eventId: string) => void;
}) {
  return (
    <div className="stack">
      <section className="panel stack">
        <h2>Promise ledger</h2>
        {report.ledger.length === 0 ? (
          <p className="empty">No verified promises were found in the records.</p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Promise</th>
                  <th>Who</th>
                  <th>To whom</th>
                  <th>Date made</th>
                  <th>Deadline</th>
                  <th>Outcome</th>
                  <th>Days late</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {report.ledger.map((row) => (
                  <tr key={row.claimId}>
                    <td>{row.promise}</td>
                    <td>{row.who ?? "—"}</td>
                    <td>{row.toWhom ?? "as stated"}</td>
                    <td className="tabular">{row.madeAt?.slice(0, 10) ?? "—"}</td>
                    <td>{row.deadline ?? "—"}</td>
                    <td>
                      <OutcomeChip outcome={row.outcome} />
                    </td>
                    <td className="tabular">{row.daysLate ?? "—"}</td>
                    <td>
                      <button type="button" className="btn btn-quiet" onClick={() => onClaim(row.claimId)}>
                        {row.source ?? "record"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel stack">
        <h2>What was communicated versus other records</h2>
        {report.audit.length === 0 ? (
          <p className="empty">No communicated update was contradicted by another record.</p>
        ) : (
          <div className="table-scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Record that was communicated</th>
                  <th>What other records showed</th>
                  <th>Mismatch noted</th>
                </tr>
              </thead>
              <tbody>
                {report.audit.map((row) => (
                  <tr key={`${row.toldEventId}-${row.internalEventId}`}>
                    <td className="tabular">{row.date}</td>
                    <td>
                      <button type="button" className="btn btn-quiet" onClick={() => onEvent(row.toldEventId)}>
                        {row.told.slice(0, 120)}
                      </button>
                    </td>
                    <td>
                      <button type="button" className="btn btn-quiet" onClick={() => onEvent(row.internalEventId)}>
                        {row.internal.slice(0, 120)}
                      </button>
                    </td>
                    <td className="small">{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------ ownership ------------------------------ */

function OwnershipTab({ report, onClaim }: { report: ReportPayload; onClaim: (claimId: string) => void }) {
  const starts = report.lanes.map((lane) => Date.parse(lane.start));
  const ends = report.lanes.map((lane) => Date.parse(lane.end));
  const min = Math.min(...starts);
  const max = Math.max(...ends);
  const span = Math.max(1, max - min);

  return (
    <div className="stack">
      <section className="panel stack">
        <h2>Ownership by period</h2>
        {report.lanes.length === 0 ? (
          <p className="empty">No cited records to attribute.</p>
        ) : (
          <div>
            {report.lanes.map((lane) => {
              const left = ((Date.parse(lane.start) - min) / span) * 100;
              const width = Math.max(2, ((Date.parse(lane.end) - Date.parse(lane.start)) / span) * 100);
              return (
                <div className="lane" key={lane.actor}>
                  <div>
                    <div style={{ fontWeight: 600 }}>{lane.actor}</div>
                    <div className="small muted tabular">
                      {lane.start.slice(0, 10)} → {lane.end.slice(0, 10)}
                    </div>
                    {lane.lapses.map((lapse) => (
                      <span className="lane-lapse" key={lapse.from}>
                        {lapse.days}d with no activity from {lapse.from.slice(0, 10)}
                      </span>
                    ))}
                  </div>
                  <div className="lane-track">
                    <span className="lane-bar" style={{ left: `${left}%`, width: `${width}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <p className="small muted">Lapses are gaps of three days or more with no stored activity.</p>
      </section>

      <section className="panel stack">
        <h2>Root cause and contributing factors</h2>
        {report.causes.length === 0 ? (
          <p className="empty">No cause findings were verified.</p>
        ) : (
          <ul className="finding-list">
            {report.causes.map((cause) => (
              <li key={cause.claimId}>
                <button
                  type="button"
                  className="finding"
                  style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
                  onClick={() => onClaim(cause.claimId)}
                >
                  <span className="finding-head">
                    <span className="tag judgment" title="System classification">{cause.tag}</span>
                  </span>
                  <span className="finding-text">{cause.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------ gaps ------------------------------ */

function GapsTab({
  report,
  onClaim,
  onEvent,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  onEvent: (eventId: string) => void;
}) {
  const neverSearched = report.coverage.neverSearched;

  return (
    <div className="stack">
      {neverSearched.length > 0 && (
        <p className="alert alert-warn">
          Available but never searched: {neverSearched.join(", ")}. Findings may be incomplete.
        </p>
      )}

      <section className="panel stack">
        <h2>What we could not determine</h2>
        {report.gaps.length === 0 ? (
          <p className="empty">The retrieved sources left no obvious gaps.</p>
        ) : (
          <ul className="finding-list">
            {report.gaps.map((gap) => (
              <li key={gap.id} className="finding">
                <span className="finding-text">{gap.question}</span>
                <span className="small muted">{gap.note}</span>
                {gap.eventIds.length > 0 && (
                  <span className="row">
                    {gap.eventIds.map((eventId) => (
                      <button key={eventId} type="button" className="btn btn-quiet" onClick={() => onEvent(eventId)}>
                        record
                      </button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel stack">
        <h2>Safe to repeat externally</h2>
        {report.safeToRepeat.length === 0 ? (
          <p className="empty">No finding is safe to repeat without checking first.</p>
        ) : (
          <ul className="finding-list">
            {report.safeToRepeat.map((item) => (
              <li key={item.claimId} className="finding">
                <span className="finding-head">
                  <span className="chip chip-verified">verified</span>
                  {item.source && <SourceChip source={item.source} />}
                </span>
                <button type="button" className="btn btn-quiet" style={{ padding: 0, textAlign: "left" }} onClick={() => onClaim(item.claimId)}>
                  <span className="finding-text">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel stack">
        <h2>Check with a human first</h2>
        {report.checkWithHuman.length === 0 ? (
          <p className="empty">No verified finding needs a human check.</p>
        ) : (
          <ul className="finding-list">
            {report.checkWithHuman.map((item) => (
              <li key={item.claimId} className="finding">
                <span className="finding-head">
                  <span className="chip chip-flag">flagged in skeptic review</span>
                </span>
                <button type="button" className="btn btn-quiet" style={{ padding: 0, textAlign: "left" }} onClick={() => onClaim(item.claimId)}>
                  <span className="finding-text">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel stack">
        <h2>Rejected claims</h2>
        <p className="small muted">
          These findings were excluded because their quoted words were not found in the cited record. They are kept
          visible and never used.
        </p>
        {report.rejected.length === 0 ? (
          <p className="empty">No claim failed verification.</p>
        ) : (
          <ul className="finding-list">
            {report.rejected.map((item) => (
              <li key={item.claimId} className="finding">
                <span className="finding-head">
                  <span className="chip chip-broken">rejected · {item.reason}</span>
                  {item.source && <SourceChip source={item.source} />}
                </span>
                <span className="finding-text" style={{ textDecoration: "line-through" }}>
                  {item.text}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------ reply ------------------------------ */

function ReplyTab({
  sentences,
  state,
  error,
  onDraft,
  onClaim,
}: {
  sentences: { text: string; claimIds: string[] }[] | null;
  state: "idle" | "loading" | "error";
  error: string | null;
  onDraft: () => void;
  onClaim: (claimId: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const copyAll = async () => {
    if (!sentences) return;
    try {
      await navigator.clipboard.writeText(sentences.map((sentence) => sentence.text).join(" "));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied.
    }
  };

  return (
    <div className="stack">
      <p className="draft-banner">
        Draft for human review. Built only from verified findings. Nothing is sent from this app.
      </p>

      {!sentences ? (
        <section className="panel stack">
          <p>No reply has been drafted for this investigation yet.</p>
          <div className="row">
            <button type="button" className="btn btn-primary" onClick={onDraft} disabled={state === "loading"}>
              {state === "loading" ? "Drafting…" : "Draft the client reply"}
            </button>
          </div>
          {state === "error" && <p className="alert alert-error">{error}</p>}
        </section>
      ) : (
        <section className="panel stack">
          <p className="evidence">
            {sentences.map((sentence) => (
              <button
                key={sentence.text}
                type="button"
                className="reply-sentence"
                onClick={() => onClaim(sentence.claimIds[0])}
                title="Open the supporting evidence"
              >
                {sentence.text}
              </button>
            ))}
          </p>
          <div className="row">
            <button type="button" className="btn" onClick={copyAll}>
              {copied ? "Copied" : "Copy reply"}
            </button>
            <button type="button" className="btn" onClick={onDraft} disabled={state === "loading"}>
              Redraft
            </button>
          </div>
          <p className="small muted">Each sentence opens the verified finding behind it.</p>
          {state === "error" && <p className="alert alert-error">{error}</p>}
        </section>
      )}
    </div>
  );
}
