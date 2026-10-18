"use client";

import type { CaseState } from "@/lib/report/case-state";
import type { Metric, ReportPayload } from "@/lib/report/build";

function firstEvidenceId(claimIds: string[], eventIds: string[]): { claimId?: string; eventId?: string } {
  if (claimIds.length > 0) return { claimId: claimIds[0] };
  if (eventIds.length > 0) return { eventId: eventIds[0] };
  return {};
}

/* G-06: the "now" strip. Every field is evidence-linked or explicitly
   unknown — a missing owner is a critical condition, not a blank. */
function CaseStateBlock({
  state,
  onEvent,
}: {
  state: CaseState;
  onEvent: (eventId: string) => void;
}) {
  const when = (iso: string) => <span className="now-when">· {iso.slice(0, 10)}</span>;
  const record = (eventId: string | null | undefined) =>
    eventId ? (
      <button
        type="button"
        className="btn btn-quiet btn-claim now-open"
        onClick={() => onEvent(eventId)}
      >
        record
      </button>
    ) : null;

  return (
    <div className="now-block" role="group" aria-label="Current state">
      <div className="now-item">
        <span className="now-label">Current status</span>
        {state.currentStatus.known ? (
          <span className="now-value">
            {state.currentStatus.value} {state.currentStatus.since && when(state.currentStatus.since)}
          </span>
        ) : (
          <span className="now-unknown">{state.currentStatus.reason}</span>
        )}
      </div>

      <div className={`now-item${state.owner.known ? "" : " now-bad"}`}>
        <span className="now-label">Owner now</span>
        {state.owner.known ? (
          <span className="now-value">
            {state.owner.value} {state.owner.since && when(state.owner.since)}
          </span>
        ) : (
          <span className="now-unknown">no current owner — {state.owner.reason}</span>
        )}
      </div>

      <div className="now-item">
        <span className="now-label">Latest fix</span>
        {state.latestFix.known ? (
          <span className="now-value">
            {state.latestFix.value.text} {when(state.latestFix.value.ts)}
          </span>
        ) : (
          <span className="now-unknown">{state.latestFix.reason}</span>
        )}
        {state.fixCheck.known && <span className="now-sub">check: {state.fixCheck.value}</span>}
      </div>

      <div className="now-item">
        <span className="now-label">Next commitment</span>
        {state.nextCommitment.known ? (
          <span className="now-value">
            {state.nextCommitment.value.object}{" "}
            {state.nextCommitment.value.deadline && when(state.nextCommitment.value.deadline)}
            {state.nextCommitment.eventId && <span> {record(state.nextCommitment.eventId)}</span>}
          </span>
        ) : (
          <span className="now-unknown">{state.nextCommitment.reason}</span>
        )}
      </div>

      <div className="now-item">
        <span className="now-label">Last client contact</span>
        {state.lastClientContact.known ? (
          <span className="now-value">
            {state.lastClientContact.value.actor} {when(state.lastClientContact.value.ts)}{" "}
            {record(state.lastClientContact.eventId)}
          </span>
        ) : (
          <span className="now-unknown">{state.lastClientContact.reason}</span>
        )}
      </div>

      <div className="now-item">
        <span className="now-label">Last internal update</span>
        {state.lastInternalUpdate.known ? (
          <span className="now-value">
            {state.lastInternalUpdate.value.actor} {when(state.lastInternalUpdate.value.ts)}{" "}
            {record(state.lastInternalUpdate.eventId)}
          </span>
        ) : (
          <span className="now-unknown">{state.lastInternalUpdate.reason}</span>
        )}
      </div>
    </div>
  );
}

function escalationSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

const QUIET_METRIC_IDS = new Set(["commitments", "longestSilence", "chasers"]);

export function AnswerSection({
  report,
  onClaim,
  onEvent,
}: {
  report: ReportPayload;
  onClaim: (claimId: string) => void;
  onEvent: (eventId: string) => void;
}) {
  const verdict = report.version?.narrative ?? report.verdict ?? report.briefing.narrative;
  const quietMetrics = report.metrics.filter((metric: Metric) => !QUIET_METRIC_IDS.has(metric.id));
  const { immediate, followUp } = report.actions;
  const scope = report.scope;
  const scopeParts: string[] = [];
  if (scope) {
    if (scope.client) scopeParts.push(scope.client);
    if (scope.project) scopeParts.push(scope.project);
    if (scopeParts.length === 0) {
      if (scope.channels.length > 0) scopeParts.push(`channel ${scope.channels.join(", ")}`);
      if (scope.ticketPrefixes.length > 0) scopeParts.push(`tickets ${scope.ticketPrefixes.join(", ")}`);
      if (scope.senderDomains.length > 0) scopeParts.push(`domains ${scope.senderDomains.join(", ")}`);
    }
  }

  return (
    <section className="briefing-section answer" id="answer" aria-labelledby="answer-title">
      <h2 id="answer-title" className="visually-hidden">
        The answer
      </h2>

      {scope && scope.confidence !== "none" && (
        <p className={`scope-line tone-${scope.confidence}`}>
          {scope.confidence === "partial" && <span className="scope-flag">Unconfirmed scope</span>}
          <span className="scope-client">{scopeParts.join(" · ")}</span>
          {scope.excludedRecords + scope.excludedClaims > 0 && (
            <span className="small muted">
              {" "}
              ·{" "}
              {[
                scope.excludedRecords > 0
                  ? `${scope.excludedRecords} stored record${scope.excludedRecords === 1 ? "" : "s"}`
                  : "",
                scope.excludedClaims > 0
                  ? `${scope.excludedClaims} finding${scope.excludedClaims === 1 ? "" : "s"}`
                  : "",
              ]
                .filter(Boolean)
                .join(" and ")}{" "}
              from other clients or projects excluded
            </span>
          )}
          {scope.confidence === "partial" && (
            <span className="small muted"> — verify before relying on it.</span>
          )}
          {scope.includedByReview > 0 && (
            <span className="small muted">
              {" "}
              · {scope.includedByReview} reviewed record{scope.includedByReview === 1 ? "" : "s"} added
              back into scope
            </span>
          )}
        </p>
      )}

      {(!scope || scope.confidence === "none") && (
        <p className="scope-line tone-none small muted">
          {scope?.client
            ? `No scope could be confirmed for ${scope.client} — every stored record was searched.`
            : "No client or project could be identified from the escalation — every stored record was searched."}
        </p>
      )}

      {scope && scope.excludedClientRecords > 0 && (
        <p className="alert alert-error">
          {scope.excludedClientRecords} record{scope.excludedClientRecords === 1 ? "" : "s"} authored
          by the client {scope.excludedClientRecords === 1 ? "is" : "are"} excluded from this
          investigation — a reply could contradict evidence that was never searched, so drafting is
          blocked until the scope is resolved.
        </p>
      )}

      {report.investigation.escalationText.trim() && (
        <details className="client-says">
          <summary>
            <span className="client-says-label">The client says</span>
            <span className="client-says-preview">“{escalationSummary(report.investigation.escalationText)}”</span>
          </summary>
          <blockquote className="client-says-full evidence">{report.investigation.escalationText}</blockquote>
        </details>
      )}

      {verdict && <p className="verdict">{verdict}</p>}
      {report.version && (
        <p className="small muted version-line">
          Report v{report.version.number} · frozen {report.version.createdAt.slice(0, 10)}
          {report.version.model ? ` · ${report.version.model}` : ""}
          {report.version.promptVersion ? ` · pipeline ${report.version.promptVersion}` : ""}
        </p>
      )}

      <p className="small muted">
        Verification: {report.stats.verified} of {report.stats.total} claims verified end-to-end
        {report.stats.supported > 0 ? ` · ${report.stats.supported} check before repeating` : ""}
        {report.stats.rejected > 0 ? ` · ${report.stats.rejected} rejected` : ""}
        {report.stats.flagged > 0 ? ` · ${report.stats.flagged} flagged` : ""}.
      </p>

      {/* G-09: the manager's four decisions, answer-first. */}
      <div className="say-block">
        <div className="say-col">
          <span className="now-label">You can say · {report.safeToRepeat.length}</span>
          {report.safeToRepeat.length === 0 ? (
            <span className="now-unknown">Nothing is fully verified yet — check before repeating anything.</span>
          ) : (
            <ul className="say-list">
              {report.safeToRepeat.slice(0, 3).map((item) => (
                <li key={item.claimId}>
                  <button
                    type="button"
                    className="btn btn-quiet btn-claim"
                    onClick={() => onClaim(item.claimId)}
                  >
                    {item.text}
                  </button>
                </li>
              ))}
              {report.safeToRepeat.length > 3 && (
                <li className="small muted">+{report.safeToRepeat.length - 3} more in the sections below</li>
              )}
            </ul>
          )}
        </div>
        <div className="say-col">
          <span className="now-label">Not yet — check first · {report.checkWithHuman.length}</span>
          {report.checkWithHuman.length === 0 ? (
            <span className="now-unknown">Nothing is waiting on a human check.</span>
          ) : (
            <ul className="say-list">
              {report.checkWithHuman.slice(0, 3).map((item) => (
                <li key={item.claimId}>
                  <button
                    type="button"
                    className="btn btn-quiet btn-claim"
                    onClick={() => onClaim(item.claimId)}
                  >
                    {item.text}
                  </button>
                </li>
              ))}
              {report.checkWithHuman.length > 3 && (
                <li className="small muted">+{report.checkWithHuman.length - 3} more in the sections below</li>
              )}
            </ul>
          )}
        </div>
      </div>

      <CaseStateBlock state={report.caseState} onEvent={onEvent} />

      <div className="scoreboard" role="list" aria-label="The five answers">
        {report.bottomLine.cells.map((cell) => {
          const evidence = firstEvidenceId(cell.claimIds, cell.eventIds);
          const open = () => {
            if (evidence.claimId) onClaim(evidence.claimId);
            else if (evidence.eventId) onEvent(evidence.eventId);
          };
          return (
            <button
              key={cell.id}
              type="button"
              className={`scoreboard-cell tone-${cell.tone}`}
              role="listitem"
              onClick={open}
              disabled={!evidence.claimId && !evidence.eventId}
              aria-label={`${cell.label}: ${cell.value}`}
            >
              <span className="scoreboard-label">{cell.label}</span>
              <span className="scoreboard-value">{cell.value}</span>
              {cell.detail && <span className="small muted">{cell.detail}</span>}
            </button>
          );
        })}
      </div>

      {quietMetrics.length > 0 && (
        <p className="quiet-metrics small muted">
          {quietMetrics.map((metric) => {
            // G-09: no metric without a drill-down into its evidence.
            const evidence = firstEvidenceId(metric.claimIds, metric.eventIds);
            const open = () => {
              if (evidence.claimId) onClaim(evidence.claimId);
              else if (evidence.eventId) onEvent(evidence.eventId);
            };
            return (
              <button
                key={metric.id}
                type="button"
                className="quiet-metric"
                onClick={open}
                disabled={!evidence.claimId && !evidence.eventId}
                title={evidence.claimId || evidence.eventId ? "Open the supporting evidence" : undefined}
              >
                <span className="quiet-metric-value">{metric.value}</span> {metric.label.toLowerCase()}
              </button>
            );
          })}
        </p>
      )}

      {immediate.length > 0 && (
        <div className="do-now">
          <h3>Do now</h3>
          <ul className="action-list">
            {immediate.map((action) => (
              <li key={action.text} className="action-card">
                <span className="action-text">{action.text}</span>
                <span className="small muted">{action.reason}</span>
                {(action.claimIds.length > 0 || action.eventIds.length > 0) && (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      if (action.claimIds[0]) onClaim(action.claimIds[0]);
                      else if (action.eventIds[0]) onEvent(action.eventIds[0]);
                    }}
                  >
                    evidence
                  </button>
                )}
              </li>
            ))}
          </ul>
          {followUp.length > 0 && (
            <details className="follow-up">
              <summary>Prevent next time ({followUp.length})</summary>
              <ul className="action-list">
                {followUp.map((action) => (
                  <li key={action.text} className="action-card">
                    <span className="action-text">{action.text}</span>
                    <span className="small muted">{action.reason}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
