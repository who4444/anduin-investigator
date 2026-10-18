"use client";

import { useState } from "react";

import { Avatar, colorFor } from "@/app/_components/briefing/people";
import { VerificationChip } from "@/app/_components/evidence";
import type { ReportPayload } from "@/lib/report/build";
import type { ReplyPayload } from "@/lib/types";

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
      <h2 id="promises-title">What was promised?</h2>
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
                    {row.contested && (
                      <span
                        className="chip chip-check"
                        title={row.rationale ?? "sources disagree on the outcome"}
                      >
                        contested
                      </span>
                    )}
                    {row.mergedClaims && (
                      <span className="chip" title="Near-duplicate findings merged into this promise">
                        {row.mergedClaims} findings merged
                      </span>
                    )}
                  </span>
                  <span className="promise-quote">“{row.promise}”</span>
                  {row.deadline && (
                    <span className="stack stack-xs">
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
                          {row.deadlineInvalid
                            ? "the date does not fit the record window"
                            : row.outcome === "broken"
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
                  {row.rationale && <span className="small muted">Status: {row.rationale}.</span>}
                </button>
              );
            })}
          </div>
        )}

        <h3 className="section-title">Internal review: what was communicated vs other records (not client communications)</h3>
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
      <h2 id="causes-title">What went wrong?</h2>
      <div className="stack">
        {lanes.length === 0 ? (
          <p className="empty">No cited records to attribute to owners yet.</p>
        ) : (
          <div className="panel">
            <div className="lane-axis" aria-hidden>
              <span />
              <div className="lane-axis-track">
                <span className="tabular">{new Date(min).toISOString().slice(0, 10)}</span>
                <span className="tabular">{new Date(max).toISOString().slice(0, 10)}</span>
              </div>
            </div>
            {lanes.map((lane) => {
              const left = ((Date.parse(lane.start) - min) / span) * 100;
              const width = Math.max(2, ((Date.parse(lane.end) - Date.parse(lane.start)) / span) * 100);
              return (
                <div className="lane" key={lane.actor}>
                  <div>
                    <div className="strong">
                      <Avatar name={lane.actor} colorIndex={colorFor(report.briefing.people, lane.actor)} />{" "}
                      {lane.actor}
                    </div>
                    <div className="lane-range">
                      {lane.start.slice(0, 10)} → {lane.end.slice(0, 10)}
                    </div>
                  </div>
                  <div className="lane-main">
                    <div className="lane-track">
                      <span className="lane-bar" style={{ left: `${left}%`, width: `${width}%` }} />
                      {lane.lapses.map((lapse) => {
                        const lapseLeft = ((Date.parse(lapse.from) - min) / span) * 100;
                        const lapseWidth = Math.max(
                          1.5,
                          ((Date.parse(lapse.to) - Date.parse(lapse.from)) / span) * 100,
                        );
                        return (
                          <span
                            key={lapse.from}
                            className="lapse-band"
                            title={`${lapse.days}d without activity from ${lapse.from.slice(0, 10)}`}
                            style={{ left: `${lapseLeft}%`, width: `${lapseWidth}%` }}
                          />
                        );
                      })}
                    </div>
                    {lane.lapses.length > 0 && (
                      <div className="lane-lapses">
                        {lane.lapses
                          .map((lapse) => `${lapse.days}d gap from ${lapse.from.slice(5, 10)}`)
                          .join(" · ")}
                      </div>
                    )}
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

/* G-01 review: the excluded list, inspectable and addable back. Confirming
   saves the selection and re-runs the investigation over the enlarged scope
   (the re-run keeps everything already stored and redoes investigate →
   verify → assemble). */
function ExcludedRecordsPanel({ report, rerunHref }: { report: ReportPayload; rerunHref: string }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!report.scope || report.excludedEvents.length === 0) return null;

  const toggle = (eventId: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  const rerun = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/investigations/${report.investigation.id}/scope`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ includeEventIds: [...selected] }),
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Could not save the scope review.");
      }
      window.location.assign(rerunHref);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  };

  return (
    <details className="excluded-panel">
      <summary>
        <span className="section-title">
          Excluded from this investigation ({report.excludedEvents.length})
        </span>
        <span className="small muted">
          records outside the confirmed scope — review before trusting a negative
        </span>
      </summary>
      <div className="stack stack-sm excluded-body">
        <p className="small muted">
          Add back any record that belongs to this engagement, then re-run: the investigators will
          search it and the findings it supports.
        </p>
        <ul className="excluded-list">
          {report.excludedEvents.map((event) => (
            <li key={event.id}>
              <label className="excluded-row">
                <input
                  type="checkbox"
                  checked={selected.has(event.id)}
                  onChange={() => toggle(event.id)}
                />
                <span className="stack stack-xs">
                  <span className="row small muted">
                    <span className={`source-label source-${event.source}`}>{event.source}</span>
                    <span className="tabular">{event.ts.slice(0, 10)}</span>
                    <span>{event.channel}</span>
                    <span>{event.actorResolved ?? event.actor}</span>
                  </span>
                  <span className="excluded-text">{event.text.replace(/\s+/g, " ")}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {error && <p className="alert alert-error">{error}</p>}
        <div className="row">
          <button
            type="button"
            className="btn btn-primary"
            disabled={selected.size === 0 || saving}
            onClick={rerun}
          >
            {saving
              ? "Saving…"
              : `Re-run with ${selected.size} record${selected.size === 1 ? "" : "s"} included`}
          </button>
        </div>
      </div>
    </details>
  );
}

export function GapsSection({
  report,
  onClaim,
  onEvent,
  rerunHref,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  onEvent: (eventId: string) => void;
  rerunHref: string;
}) {
  const neverSearched = report.coverage.neverSearched;
  const chasers = report.metrics.find((metric) => metric.id === "chasers");
  // An agent note can say a chase "could not be confirmed" while the code's
  // chaser metric has already found the client records. Keep the honest SLA
  // unknown, but do not present a determined chaser count as absent.
  const displayGapNote = (note: string): string => {
    if (!chasers?.determined || chasers.value === "none found" || !/chase/i.test(note)) return note;
    if (!/could not|unconfirmed|unanswered|no (?:reply|response|confirmation)/i.test(note)) return note;
    return `${note} Code-level chaser check: ${chasers.value}; the chaser records are in the report.`;
  };

  return (
    <section className="briefing-section" id="gaps" aria-labelledby="gaps-title">
      <h2 id="gaps-title">What could not be determined?</h2>
      <div className="stack">
        <ExcludedRecordsPanel report={report} rerunHref={rerunHref} />
        {report.investigation.ingestWarnings.length > 0 && (
          <div className="alert alert-warn alert-block">
            <strong>Evidence-set notes from ingest:</strong>
            <ul className="bullets">
              {report.investigation.ingestWarnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        {neverSearched.length > 0 && (
          <p className="alert alert-warn">
            Available but never searched: {neverSearched.join(", ")}. Findings may be incomplete.
          </p>
        )}

        {report.missing.length > 0 && report.complete && (
          <p className="small muted">
            No verified finding answered: {report.missing.join(", ")}. Those question groups are
            listed as gaps above.
          </p>
        )}
        {report.gaps.length === 0 ? (
          <p className="empty">The retrieved sources left no obvious gaps.</p>
        ) : (
          <ul className="finding-list">
            {report.gaps.map((gap) => (
              <li key={gap.id} className="finding">
                <span className="finding-text">{gap.question}</span>
                <span className="small muted">{displayGapNote(gap.note)}</span>
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

        <h3 className="section-title">Client-safe facts (verified)</h3>
        <p className="small muted">The draft may only use these verified facts; the draft itself requires approval before copying.</p>
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
                <button type="button" className="btn btn-quiet btn-claim" onClick={() => onClaim(item.claimId)}>
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
                  {item.verifyError === "evidence_incomplete" ? (
                    <span className="chip chip-check">coverage incomplete — not searched fully</span>
                  ) : item.verification === "supported" ? (
                    <span className="chip chip-check">check before repeating</span>
                  ) : (
                    <span className="chip chip-flag">flagged in skeptic review</span>
                  )}
                </span>
                <button type="button" className="btn btn-quiet btn-claim" onClick={() => onClaim(item.claimId)}>
                  <span className="finding-text">{item.text}</span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <details className="stack stack-sm">
          <summary className="section-title">
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
                  <span className="finding-text struck">
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
  reply,
  state,
  error,
  onDraft,
  onClaim,
  onApprove,
  disabledReason,
}: {
  reply: ReplyPayload | null;
  state: "idle" | "loading" | "error";
  error: string | null;
  onDraft: () => void;
  onClaim: (claimId: string) => void;
  onApprove: (approved: boolean) => void;
  disabledReason?: string | null;
}) {
  const [copied, setCopied] = useState(false);

  const copyAll = async () => {
    if (!reply) return;
    const text = [
      reply.greeting ?? "",
      ...reply.sentences.map((sentence) => sentence.text),
      reply.signOff ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
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
          Client-safe draft. Built only from verified, unflagged findings. Approval is required
          before copying; nothing is sent from this app.
        </p>
        {disabledReason ? (
          <p className="empty">{disabledReason}</p>
        ) : !reply ? (
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
            {reply.greeting && <p className="reply-greeting">{reply.greeting}</p>}
            <div className="evidence">
              {reply.sentences.map((sentence) => (
                <div key={sentence.text} className="reply-line">
                  <button
                    type="button"
                    className="reply-sentence"
                    onClick={() => onClaim(sentence.claimIds[0])}
                    title="Open the supporting evidence"
                  >
                    {sentence.text}
                  </button>
                  <span className={`reply-label reply-label-${sentence.label ?? "safe"}`}>
                    {sentence.label === "needs-check"
                      ? "needs check"
                      : sentence.label === "do-not-send"
                        ? "do not send"
                        : "safe"}
                  </span>
                </div>
              ))}
            </div>
            {reply.signOff && <p className="reply-signoff">{reply.signOff}</p>}
            <div className="row">
              <label className="check">
                <input
                  type="checkbox"
                  checked={reply.approved === true}
                  onChange={(event) => onApprove(event.target.checked)}
                />
                Approve for client use
              </label>
            </div>
            <div className="row">
              <button
                type="button"
                className="btn"
                onClick={copyAll}
                disabled={reply.approved !== true}
                title={reply.approved ? "Copy the approved client reply" : "Approve the draft before copying"}
              >
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
