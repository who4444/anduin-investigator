"use client";

import { useState } from "react";

import { Avatar, colorFor } from "@/app/_components/briefing/people";
import { VerificationChip } from "@/app/_components/evidence";
import type { ReportPayload } from "@/lib/report/build";

const STAMP_CLASS: Record<string, string> = {
  broken: "stamp stamp-broken",
  kept: "stamp stamp-kept",
  unclear: "stamp stamp-unclear",
  "n/a": "stamp stamp-unclear",
};

const STATUS_WORD: Record<string, string> = {
  broken: "broken",
  kept: "kept",
  unclear: "unclear",
  "n/a": "recorded",
};

export function PromisesSection({
  report,
  onClaim,
  onEvent,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  onEvent: (eventId: string) => void;
}) {
  const { ledger, audit } = report;

  return (
    <section className="briefing-section" id="promises" aria-labelledby="promises-title">
      <h2 id="promises-title">Promises</h2>
      <div className="stack">
        {ledger.length === 0 ? (
          <p className="empty">No source-backed promises were found in the records.</p>
        ) : (
          <div className="stack">
            {ledger.map((row) => {
              const deadlineDays = row.daysLate ?? 0;
              const overrun = row.outcome === "broken" && deadlineDays > 0 ? deadlineDays : 0;
              const total = 10 + overrun;
              return (
                <button
                  key={row.claimId}
                  type="button"
                  className="promise-card"
                  data-outcome={row.outcome}
                  onClick={() => onClaim(row.claimId)}
                  aria-label={`Promise: ${row.promise}`}
                >
                  <span className="event-chips">
                    {row.who && <Avatar name={row.who} colorIndex={colorFor(report.briefing.people, row.who)} />}
                    <span>
                      <strong>{row.who ?? "unknown"}</strong>
                      {row.toWhom ? ` → ${row.toWhom}` : ""}
                    </span>
                    <span className={STAMP_CLASS[row.outcome] ?? "stamp"}>
                      {STATUS_WORD[row.outcome] ?? row.outcome}
                      {row.outcome === "broken" && deadlineDays > 0 ? `, ${deadlineDays} days late` : ""}
                    </span>
                    <VerificationChip verification={row.verification} />
                    {row.mergedClaims && (
                      <span className="chip" title="Near-duplicate findings merged into this promise">
                        {row.mergedClaims} findings merged
                      </span>
                    )}
                  </span>
                  <span className="promise-quote">“{row.promise}”</span>
                  {row.deadline && (
                    <span className="stack" style={{ gap: 4 }}>
                      <span className="deadline-bar" aria-hidden>
                        <span className="deadline-planned" style={{ width: `${(10 / total) * 100}%` }} />
                        {overrun > 0 && (
                          <span
                            className="deadline-overrun"
                            style={{ left: `${(10 / total) * 100}%`, width: `${(overrun / total) * 100}%` }}
                          />
                        )}
                      </span>
                      <span className="deadline-labels">
                        <span>promised by {row.deadline}</span>
                        <span>
                          {row.outcome === "broken"
                            ? overrun > 0
                              ? `${overrun} day${overrun === 1 ? "" : "s"} past the deadline`
                              : "deadline passed"
                            : row.outcome === "kept"
                              ? "delivered"
                              : "still unclear"}
                        </span>
                      </span>
                    </span>
                  )}
                  {row.madeAt && (
                    <span className="small muted">made {row.madeAt.slice(0, 10)} · {row.source ?? "record"}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <h3 className="section-title">What was communicated versus other records</h3>
        {audit.length === 0 ? (
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
                {audit.map((row) => (
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
      </div>
    </section>
  );
}

export function CausesSection({
  report,
  onClaim,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
}) {
  const { lanes, causes } = report;
  const starts = lanes.map((lane) => Date.parse(lane.start));
  const ends = lanes.map((lane) => Date.parse(lane.end));
  const min = starts.length > 0 ? Math.min(...starts) : 0;
  const max = ends.length > 0 ? Math.max(...ends) : min + 1;
  const span = Math.max(1, max - min);
  const hasProcess = causes.some((cause) => cause.tag === "process");

  return (
    <section className="briefing-section" id="causes" aria-labelledby="causes-title">
      <h2 id="causes-title">Causes and ownership</h2>
      <div className="stack">
        {lanes.length === 0 ? (
          <p className="empty">No cited records to attribute to owners yet.</p>
        ) : (
          <div className="panel">
            {lanes.map((lane) => {
              const left = ((Date.parse(lane.start) - min) / span) * 100;
              const width = Math.max(2, ((Date.parse(lane.end) - Date.parse(lane.start)) / span) * 100);
              return (
                <div className="lane" key={lane.actor}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      <Avatar name={lane.actor} colorIndex={colorFor(report.briefing.people, lane.actor)} />{" "}
                      {lane.actor}
                    </div>
                    <div className="small muted tabular">
                      {lane.start.slice(0, 10)} → {lane.end.slice(0, 10)}
                    </div>
                    {lane.lapses.map((lapse) => (
                      <span className="lane-lapse" key={lapse.from}>
                        {lapse.days}d without activity from {lapse.from.slice(0, 10)}
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

        <h3 className="section-title">Root cause and contributing factors</h3>
        {causes.length === 0 ? (
          <p className="empty">No cause findings were source-backed.</p>
        ) : (
          <ul className="finding-list">
            {causes.map((cause) => (
              <li key={cause.claimId}>
                <button
                  type="button"
                  className="finding"
                  style={{ width: "100%", textAlign: "left", cursor: "pointer" }}
                  onClick={() => onClaim(cause.claimId)}
                >
                  <span className="finding-head">
                    <span className="tag judgment" title="System classification">
                      {cause.tag}
                    </span>
                  </span>
                  <span className="finding-text">{cause.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {hasProcess && (
          <p className="small muted">
            Process findings are judged against generic norms; no SLA was provided in the sources.
          </p>
        )}
      </div>
    </section>
  );
}

export function GapsSection({
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
    <section className="briefing-section" id="gaps" aria-labelledby="gaps-title">
      <h2 id="gaps-title">Gaps and confidence</h2>
      <div className="stack">
        {neverSearched.length > 0 && (
          <p className="alert alert-warn">
            Available but never searched: {neverSearched.join(", ")}. Findings may be incomplete.
          </p>
        )}

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

        <h3 className="section-title">Safe to repeat externally</h3>
        {report.safeToRepeat.length === 0 ? (
          <p className="empty">No finding is safe to repeat without checking first.</p>
        ) : (
          <ul className="finding-list">
            {report.safeToRepeat.map((item) => (
              <li key={item.claimId} className="finding">
                <span className="finding-head">
                  <span className="chip chip-verified">verified</span>
                  {item.source && <span className={`chip chip-source-${item.source}`}>{item.source}</span>}
                </span>
                <button type="button" className="btn btn-quiet" style={{ padding: 0, textAlign: "left" }} onClick={() => onClaim(item.claimId)}>
                  <span className="finding-text">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3 className="section-title">Check with a human first</h3>
        {report.checkWithHuman.length === 0 ? (
          <p className="empty">No source-backed finding needs a human check.</p>
        ) : (
          <ul className="finding-list">
            {report.checkWithHuman.map((item) => (
              <li key={item.claimId} className="finding">
                <span className="finding-head">
                  {item.verification === "supported" ? (
                    <span className="chip chip-check">check before repeating</span>
                  ) : (
                    <span className="chip chip-flag">flagged in skeptic review</span>
                  )}
                </span>
                <button type="button" className="btn btn-quiet" style={{ padding: 0, textAlign: "left" }} onClick={() => onClaim(item.claimId)}>
                  <span className="finding-text">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <details className="stack" style={{ gap: 8 }}>
          <summary className="section-title" style={{ cursor: "pointer" }}>
            Rejected claims ({report.rejected.length})
          </summary>
          <p className="small muted">
            These findings failed a hard code check — the quoted words were not found in the cited
            record, or the cited record is missing. They are kept visible and never used.
          </p>
          {report.rejected.length === 0 ? (
            <p className="empty">No claim failed verification.</p>
          ) : (
            <ul className="finding-list">
              {report.rejected.map((item) => (
                <li key={item.claimId} className="finding">
                  <span className="finding-head">
                    <span className="chip chip-broken">rejected · {item.reason}</span>
                  </span>
                  <span className="finding-text" style={{ textDecoration: "line-through" }}>
                    {item.text}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
    </section>
  );
}

export function ReplySection({
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
    <section className="briefing-section" id="reply" aria-labelledby="reply-title">
      <h2 id="reply-title">Draft reply</h2>
      <div className="stack">
        <p className="draft-banner">
          Draft for human review. Built only from verified findings. Nothing is sent from this app.
        </p>
        {!sentences ? (
          <div className="panel stack">
            <p>No reply has been drafted for this investigation yet.</p>
            <div className="row">
              <button type="button" className="btn btn-primary" onClick={onDraft} disabled={state === "loading"}>
                {state === "loading" ? "Drafting…" : "Draft the client reply"}
              </button>
            </div>
            {state === "error" && <p className="alert alert-error">{error}</p>}
          </div>
        ) : (
          <div className="panel stack">
            <div className="evidence">
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
            </div>
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
          </div>
        )}
      </div>
    </section>
  );
}
