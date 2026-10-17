"use client";

import type { Metric, ReportPayload } from "@/lib/report/build";

function firstEvidenceId(claimIds: string[], eventIds: string[]): { claimId?: string; eventId?: string } {
  if (claimIds.length > 0) return { claimId: claimIds[0] };
  if (eventIds.length > 0) return { eventId: eventIds[0] };
  return {};
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
  const verdict = report.verdict ?? report.briefing.narrative;
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
        </p>
      )}

      {(!scope || scope.confidence === "none") && (
        <p className="scope-line tone-none small muted">
          {scope?.client
            ? `No scope could be confirmed for ${scope.client} — every stored record was searched.`
            : "No client or project could be identified from the escalation — every stored record was searched."}
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

      <p className="small muted">
        Verification: {report.stats.verified} of {report.stats.total} claims verified end-to-end
        {report.stats.supported > 0 ? ` · ${report.stats.supported} check before repeating` : ""}
        {report.stats.rejected > 0 ? ` · ${report.stats.rejected} rejected` : ""}
        {report.stats.flagged > 0 ? ` · ${report.stats.flagged} flagged` : ""}.
      </p>

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
          {quietMetrics.map((metric) => (
            <span key={metric.id}>
              <span className="quiet-metric-value">{metric.value}</span> {metric.label.toLowerCase()}
            </span>
          ))}
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
