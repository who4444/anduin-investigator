"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Avatar, PERSON_COLORS } from "@/app/_components/briefing/people";
import { ExcludedRecordsPanel } from "@/app/_components/briefing/sections";
import type { ReportPayload } from "@/lib/report/build";
import type {
  ReportActorModel,
  ReportFindingModel,
  ReportModel,
  ReportStateField,
} from "@/lib/report/model";
import { fullFindingLabel, shortFindingLabel } from "@/lib/report/model";

/* Revision brief: every report section renders from ReportModel. The components
   below never read claims directly; the only full sentences are the headline
   and the story rows, so a finding can never be repeated section to section. */

function actorFor(model: ReportModel, id: string | null): ReportActorModel | undefined {
  return id ? model.actors.find((actor) => actor.id === id) : undefined;
}

function actorRoleLabel(actor: ReportActorModel | undefined, clientResolved: boolean): string {
  if (!clientResolved) return "needs client confirmation";
  if (!actor || actor.role === "unknown") return "role unknown";
  return actor.role;
}

function actorColor(model: ReportModel, actorId: string | null): number {
  const index = model.actors.findIndex((actor) => actor.id === actorId);
  return index < 0 ? 0 : index % PERSON_COLORS.length;
}

function sourceClass(source: string): string {
  return `source-label source-${source}`;
}

function Pill({ finding }: { finding: ReportFindingModel }) {
  if (!finding.pill) return null;
  return (
    <span className={`pill pill-${finding.pill}`}>
      {finding.pill === "conflict" ? "conflict" : "needs check"}
    </span>
  );
}

/* A finding label in a list. When the label was word-capped, a muted
   "see more" marks it; opening the drawer shows the full sentence in bold. */
function FindingButton({
  finding,
  actors,
  onFinding,
}: {
  finding: ReportFindingModel;
  actors: ReportActorModel[];
  onFinding: (finding: ReportFindingModel) => void;
}) {
  const full = fullFindingLabel(finding, actors);
  const short = shortFindingLabel(finding, actors);
  const truncated = short.trim() !== full.replace(/\s+/g, " ").trim();
  return (
    <button type="button" className="finding-link" onClick={() => onFinding(finding)}>
      {short}
      {truncated && <span className="see-more">see more</span>}
    </button>
  );
}

export function ClientResolutionNotice({ report }: { report: ReportPayload }) {
  const model = report.model;
  const scope = report.scope;
  const confidence = scope?.confidence ?? null;
  const partial = confidence === "partial";
  const scoped = confidence === "scoped";
  const reviewed = Boolean(scope?.reviewed);
  const identifiers = [
    scope?.client ?? model.client.client,
    scope?.project ?? model.client.project,
    ...(scope?.channels ?? []),
    ...(scope?.ticketPrefixes ?? []),
  ]
    .filter((value): value is string => Boolean(value))
    .filter((value, index, values) => values.findIndex((other) => other.toLowerCase() === value.toLowerCase()) === index);
  const excluded = (scope?.excludedRecords ?? 0) + (scope?.excludedClaims ?? 0);

  const line =
    confidence === "none" || confidence === null
      ? scope?.client
        ? `No scope could be confirmed for ${scope.client} — every stored record was searched.`
        : "No client or project could be identified from the escalation — every stored record was searched."
      : identifiers.join(" · ");

  return (
    <div className={model.client.clientKnown ? "scope-wrap" : "client-resolution alert-block"}>
      <p className={`scope-line tone-${scoped ? "scoped" : partial ? "partial" : "none"}`}>
        {partial && (
          <span className={`scope-flag${reviewed ? " scope-confirmed" : ""}`}>
            {reviewed ? "Scope confirmed by you" : "Unconfirmed scope"}
          </span>
        )}
        {line}
        {excluded > 0 && (
          <span className="small muted">
            {" "}· {scope?.excludedRecords ?? 0} stored record{(scope?.excludedRecords ?? 0) === 1 ? "" : "s"}
            {(scope?.excludedClaims ?? 0) > 0 ? ` and ${scope?.excludedClaims} finding${(scope?.excludedClaims ?? 0) === 1 ? "" : "s"}` : ""} from other clients or projects excluded
          </span>
        )}
        {(scope?.includedByReview ?? 0) > 0 && (
          <span className="small muted">
            {" "}· {scope?.includedByReview} reviewed record{(scope?.includedByReview ?? 0) === 1 ? "" : "s"} added back into scope
          </span>
        )}
        {partial && !reviewed && <span className="small muted"> — verify before relying on it.</span>}
        {partial && reviewed && <span className="small muted"> — confirmed by you before the run.</span>}
      </p>
      {!model.client.clientKnown && (
        <div className="client-resolution-body">
          <h2>Client and project not confirmed</h2>
          <p>
            {model.client.reasons.join(" ")} Until this is resolved, customer contact, actor roles and
            the told-vs-actual audit cannot be stated.
          </p>
          <ClientConfirmForm investigationId={report.investigation.id} />
        </div>
      )}
    </div>
  );
}

function ClientConfirmForm({ investigationId }: { investigationId: string }) {
  const router = useRouter();
  const [client, setClient] = useState("");
  const [project, setProject] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!client.trim()) {
      setError("Enter the client name from the roster.");
      setState("error");
      return;
    }
    setState("saving");
    setError(null);
    try {
      const response = await fetch(`/api/investigations/${investigationId}/client`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: client.trim(), project: project.trim() || null }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not save the client.");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setState("error");
    }
  };

  return (
    <form className="client-confirm" onSubmit={(event) => void submit(event)}>
      <label className="small">
        Client roster
        <input
          className="input"
          value={client}
          onChange={(event) => setClient(event.target.value)}
          placeholder="Client name"
          disabled={state === "saving"}
        />
      </label>
      <label className="small">
        Project
        <input
          className="input"
          value={project}
          onChange={(event) => setProject(event.target.value)}
          placeholder="Project name"
          disabled={state === "saving"}
        />
      </label>
      <button type="submit" className="btn btn-primary" disabled={state === "saving"}>
        {state === "saving" ? "Saving…" : "Confirm client"}
      </button>
      {error && <span className="alert alert-error">{error}</span>}
    </form>
  );
}

function StateValue<T>({
  field,
  render,
  onFinding,
}: {
  field: ReportStateField<T>;
  render: (value: T) => React.ReactNode;
  onFinding: (findingId: string) => void;
}) {
  if (!field.known) {
    return <span className="now-unknown">{field.unknownReason}</span>;
  }
  return (
    <span className="now-value">
      {render(field.value as T)}
      {field.basis.length > 0 && (
        <button
          type="button"
          className="btn btn-quiet btn-claim now-open"
          onClick={() => onFinding(field.basis[0])}
        >
          record
        </button>
      )}
    </span>
  );
}

function compactAction(text: string): string {
  return text
    .replace(/[.!?].*$/, "")
    .split(":")[0]
    .split(/\s+/)
    .slice(0, 5)
    .join(" ");
}

/* The client's own message. A short message is shown in full — no click
   needed; a long one keeps the preview with a "see more" marker and expands
   in place. */
function ClientSays({ text }: { text: string }) {
  if (!text.trim()) return null;
  const preview = text.replace(/\s+/g, " ");
  if (preview.length <= 140) {
    return (
      <div className="client-says">
        <div className="client-says-open">
          <span className="client-says-label">The client says</span>
          <blockquote className="client-says-full evidence">{text}</blockquote>
        </div>
      </div>
    );
  }
  return (
    <details className="client-says">
      <summary>
        <span className="client-says-label">The client says</span>
        <span className="client-says-preview">
          “{preview.slice(0, 140)}…”
          <span className="see-more">see more</span>
        </span>
      </summary>
      <blockquote className="client-says-full evidence">{text}</blockquote>
    </details>
  );
}

export function ModelAnswer({
  report,
  onFinding,
}: {
  report: ReportPayload;
  onFinding: (finding: ReportFindingModel) => void;
}) {
  const model = report.model;
  const findingById = new Map(model.findings.map((finding) => [finding.id, finding]));
  const citations = (ids: string[]) =>
    ids
      .map((id) => findingById.get(id))
      .filter((finding): finding is ReportFindingModel => Boolean(finding))
      .map((finding) => (
        <button
          key={finding.id}
          type="button"
          className="citation"
          title={finding.headline}
          onClick={() => onFinding(finding)}
        >
          [{finding.id}]
        </button>
      ));

  const countCell = (
    id: string,
    label: string,
    value: number,
    detail: string,
    findings: ReportFindingModel[],
    fallbackScroll?: string,
  ) => (
    <button
      key={id}
      type="button"
      className={`scoreboard-cell ${value === 0 ? "is-empty" : ""}`}
      aria-label={`${label}: ${value}`}
      onClick={() => {
        if (findings[0]) onFinding(findings[0]);
        else if (fallbackScroll) document.getElementById(fallbackScroll)?.scrollIntoView({ behavior: "smooth" });
      }}
      disabled={findings.length === 0 && !fallbackScroll}
    >
      <span className="scoreboard-label">{label}</span>
      <span className="scoreboard-value">{value}</span>
      <span className="small muted">{detail}</span>
    </button>
  );

  const action = model.actions[0];
  return (
    <section className="briefing-section answer" id="answer" aria-labelledby="answer-title">
      <h2 id="answer-title" className="visually-hidden">The answer</h2>
      <ClientSays text={report.investigation.escalationText} />
      <div className="verdict headline">
        {model.headline.sentences.map((sentence, index) => (
          <p key={index} className={index === 0 ? "headline-lead" : "headline-line"}>
            {sentence.text} {citations(sentence.findingIds)}
          </p>
        ))}
        {model.headline.nextStep && (
          <p className="headline-next">Next step: {model.headline.nextStep}</p>
        )}
        <p className="headline-stats small muted">{model.headline.statsLine}</p>
      </div>

      <div className="say-block">
        <div className="say-col">
          <span className="now-label">You can say · {model.counts.verified}</span>
          {model.verifiedFindings.length === 0 ? (
            <span className="now-unknown">Nothing is verified yet; use the story below and treat every finding as unsafe to repeat.</span>
          ) : (
            <>
              <ul className="say-list">
                {model.verifiedFindings.map((finding) => (
                  <li key={finding.id}>
                    <FindingButton finding={finding} actors={model.actors} onFinding={onFinding} />
                  </li>
                ))}
              </ul>
              {model.withheldVerified.length > 0 && (
                <p className="small muted">
                  {model.withheldVerified.length} verified finding{model.withheldVerified.length === 1 ? "" : "s"} withheld because they carry a conflict.
                </p>
              )}
            </>
          )}
        </div>
        <div className="say-col">
          <span className="now-label">Not yet · {model.counts.needsCheck}</span>
          {model.counts.needsCheck === 0 ? (
            <span className="now-unknown">Nothing is waiting on a human check.</span>
          ) : (
            <>
              <ul className="say-list">
                {model.findings.filter((finding) => finding.pill).slice(0, 3).map((finding) => (
                  <li key={finding.id}>
                    <FindingButton finding={finding} actors={model.actors} onFinding={onFinding} />
                  </li>
                ))}
              </ul>
              {model.counts.needsCheck > 3 && (
                <p className="small muted">+{model.counts.needsCheck - 3} more under What happened.</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="scoreboard" role="list" aria-label="Report counts">
        {countCell(
          "findings",
          "Findings",
          model.counts.findings,
          "every finding appears once",
          model.findings.filter((finding) => finding.claimIds.length > 0),
          "story",
        )}
        {countCell(
          "verified",
          "Verified",
          model.counts.verified,
          "safe to repeat",
          model.verifiedFindings,
        )}
        {countCell(
          "needs-check",
          "Needs check",
          model.counts.needsCheck,
          "one exception vocabulary",
          model.findings.filter((finding) => finding.pill),
        )}
        {countCell(
          "open-questions",
          "Open questions",
          model.counts.openQuestions,
          "grouped, with next steps",
          [],
          "gaps",
        )}
        <button
          type="button"
          className="scoreboard-cell action-cell"
          aria-label={`Next action: ${action?.text ?? "No urgent action found"}`}
          onClick={() => document.getElementById("actions")?.scrollIntoView({ behavior: "smooth" })}
        >
          <span className="scoreboard-label">Next action</span>
          <span className="scoreboard-value action-value">
            {action && action.id !== "act_none" ? compactAction(action.text) : "No urgent action"}
          </span>
          <span className="small muted">see Do now</span>
        </button>
      </div>

      <div className="now-block" role="group" aria-label="Current state">
        <div className="now-item">
          <span className="now-label">Current status</span>
          <StateValue field={model.state.currentStatus} render={(value) => value} onFinding={(findingId) => findingById.get(findingId) && onFinding(findingById.get(findingId)!)} />
        </div>
        <div className={`now-item${model.state.owner.known ? "" : " now-bad"}`}>
          <span className="now-label">Owner now</span>
          <StateValue field={model.state.owner} render={(value) => value} onFinding={(findingId) => findingById.get(findingId) && onFinding(findingById.get(findingId)!)} />
        </div>
        <div className="now-item">
          <span className="now-label">Last client contact</span>
          <StateValue
            field={model.state.lastClientContact}
            render={(value) => `${value.actor} · ${value.ts.slice(0, 10)}`}
            onFinding={(findingId) => findingById.get(findingId) && onFinding(findingById.get(findingId)!)}
          />
        </div>
        <div className="now-item">
          <span className="now-label">Last internal update</span>
          <StateValue
            field={model.state.lastInternalUpdate}
            render={(value) => `${value.actor} · ${value.ts.slice(0, 10)}`}
            onFinding={(findingId) => findingById.get(findingId) && onFinding(findingById.get(findingId)!)}
          />
        </div>
        <div className="now-item">
          <span className="now-label">Latest fix</span>
          <StateValue
            field={model.state.latestFix}
            render={(value) => `${value.text} · ${value.ts.slice(0, 10)}`}
            onFinding={(findingId) => findingById.get(findingId) && onFinding(findingById.get(findingId)!)}
          />
        </div>
        <div className="now-item">
          <span className="now-label">Next commitment</span>
          <StateValue
            field={model.state.nextCommitment}
            render={(value) => `${value.object}${value.deadline ? ` · ${value.deadline.slice(0, 10)}` : ""}`}
            onFinding={(findingId) => findingById.get(findingId) && onFinding(findingById.get(findingId)!)}
          />
        </div>
      </div>

      <div className="do-now" id="actions">
        <h3>Do now</h3>
        {model.actions.length === 0 || (model.actions.length === 1 && model.actions[0].id === "act_none") ? (
          <p className="empty">No urgent action found.</p>
        ) : (
          <ul className="action-list">
            {model.actions.map((item) => {
              const trigger = item.findingIds
                .map((id) => findingById.get(id))
                .find((entry): entry is ReportFindingModel => Boolean(entry));
              return (
              <li key={item.id} className={`action-card action-${item.tone}`}>
                {trigger ? (
                  <button type="button" className="action-text" onClick={() => onFinding(trigger)}>
                    {item.text}
                    {item.text.includes("…") && <span className="see-more">see more</span>}
                  </button>
                ) : (
                  <span className="action-text">{item.text}</span>
                )}
                <span className="row">
                  {item.findingIds.map((findingId) => {
                    const finding = findingById.get(findingId);
                    return finding ? (
                      <button key={findingId} type="button" className="btn btn-quiet btn-claim" onClick={() => onFinding(finding)}>
                        trigger {finding.id}
                      </button>
                    ) : null;
                  })}
                </span>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export function ModelStory({ report, onFinding }: { report: ReportPayload; onFinding: (finding: ReportFindingModel) => void }) {
  const model = report.model;
  const suppressed = model.suppressPills;
  const groups = new Map<string, ReportFindingModel[]>();
  for (const finding of model.findings) {
    const key = finding.ts.slice(0, 10);
    groups.set(key, [...(groups.get(key) ?? []), finding]);
  }
  return (
    <section className="briefing-section" id="story" aria-labelledby="story-title">
      <h2 id="story-title">What happened</h2>
      <p className="small muted">
        Current as of {model.state.asOf ? model.state.asOf.slice(0, 10) : "the latest record"} — each finding appears once.
      </p>
      {suppressed && model.pillSummary && <p className="pill-summary">{model.pillSummary}</p>}
      <div className="chapters">
        {[...groups.entries()].map(([date, findings]) => (
          <details className="chapter" key={date} open>
            <summary>
              <span className="chapter-title">Updates on {new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}</span>
              <span className="chapter-range">{date}</span>
              <span className="chapter-takeaway judgment">{findings.length} finding{findings.length === 1 ? "" : "s"}</span>
            </summary>
            <div className="chapter-events">
              {findings.map((finding) => {
                const actor = actorFor(model, finding.eventActorId);
                return (
                  <div className="event-row-wrap" id={finding.slug} key={finding.id}>
                    <button
                      type="button"
                      className="event-row"
                      data-importance={finding.importance}
                      onClick={() => onFinding(finding)}
                      aria-label={`${finding.headline}. ${finding.text}`}
                    >
                      <span className="event-day">{finding.id}</span>
                      <Avatar name={actor?.name ?? "Unknown"} colorIndex={actorColor(model, finding.eventActorId)} />
                      <span className="event-main">
                        <span className="event-headline">{finding.headline}</span>
                        {finding.text !== finding.headline &&
                          !finding.text
                            .toLowerCase()
                            .startsWith(finding.headline.replace(/…$/, "").toLowerCase()) && (
                            <span className="event-full">{finding.text}</span>
                          )}
                        {finding.quotes[0] &&
                          !finding.text.includes(finding.quotes[0]) &&
                          finding.quotes[0] !== finding.eventText && (
                            <span className="source-quote">
                              Source: “{finding.quotes[0]}”
                            </span>
                          )}
                        <span className="event-chips">
                          <span className={sourceClass(finding.source)}>{finding.source}</span>
                          <span className="person">
                            <span className="person-role">{actor?.name ?? "Unknown actor"}</span>
                            <span className="role-label">{actorRoleLabel(actor, model.client.clientKnown)}</span>
                          </span>
                          {finding.failureTag && <span className={`chip failure-${finding.failureTag}`}>{finding.failureTag}</span>}
                          {!suppressed && <Pill finding={finding} />}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}

export function ModelPromises({ report, onFinding }: { report: ReportPayload; onFinding: (finding: ReportFindingModel) => void }) {
  const model = report.model;
  return (
    <section className="briefing-section" id="promises" aria-labelledby="promises-title">
      <h2 id="promises-title">What was promised?</h2>
      {model.promises.length === 0 ? (
        <p className="empty">No source-backed promises were found in the records.</p>
      ) : (
        <ul className="compact-list">
          {model.promises.map((finding) => (
            <li key={finding.id} className="compact-row">
              <FindingButton finding={finding} actors={model.actors} onFinding={onFinding} />
              <span className={`stamp ${finding.promiseStatus === "broken" ? "stamp-broken" : finding.promiseStatus === "kept" ? "stamp-kept" : "stamp-unclear"}`}>
                {finding.promiseStatus ?? "unclear"}
              </span>
              {finding.deadline && <span className="small muted">deadline {finding.deadline}</span>}
              <button type="button" className="see-id small muted" onClick={() => onFinding(finding)}>
                see {finding.id}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ModelAudit report={report} onFinding={onFinding} />
    </section>
  );
}

function ModelAudit({ report, onFinding }: { report: ReportPayload; onFinding: (finding: ReportFindingModel) => void }) {
  const model = report.model;
  return (
    <div className="stack stack-xs audit">
      <h3 className="section-title">What we told the client vs what the records show</h3>
      {!model.client.clientKnown ? (
        <p className="empty">Needs client confirmation — actor roles are unresolved.</p>
      ) : model.audit.length === 0 ? (
        <p className="empty">No communicated update was contradicted by another record.</p>
      ) : (
        <ul className="compact-list">
          {model.audit.map((row) => {
            const finding = model.findings.find((entry) => entry.id === row.findingId);
            return (
              <li key={row.findingId} className="compact-row">
                <span className="small muted">{row.findingId}</span>
                {finding && <FindingButton finding={finding} actors={model.actors} onFinding={onFinding} />}
                <span className="small muted">{row.note}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ModelFailures({ report, onFinding }: { report: ReportPayload; onFinding: (finding: ReportFindingModel) => void }) {
  const model = report.model;
  return (
    <section className="briefing-section" id="causes" aria-labelledby="causes-title">
      <h2 id="causes-title">What went wrong?</h2>
      {model.processNormsNote && <p className="small muted">{model.processNormsNote}</p>}
      {model.failures.length === 0 ? (
        <p className="empty">No failure is classified in the records yet.</p>
      ) : (
        <ul className="compact-list">
          {model.failures.map((finding) => (
            <li key={finding.id} className="compact-row">
              <FindingButton finding={finding} actors={model.actors} onFinding={onFinding} />
              <span className="chip">{finding.failureTag}</span>
              <button type="button" className="see-id small muted" onClick={() => onFinding(finding)}>
                see {finding.id}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function ModelOpenQuestions({
  report,
  rerunHref,
  onFinding,
}: {
  report: ReportPayload;
  rerunHref: string;
  onFinding: (finding: ReportFindingModel) => void;
}) {
  const model = report.model;
  const top = model.openQuestions.slice(0, 5);
  const rest = model.openQuestions.slice(5);

  const renderGroup = (group: ReportModel["openQuestions"][number]) => (
    <li className="finding question-group" key={group.id}>
      <span className="finding-head">
        <span className="chip">{group.theme}</span>
        {group.count > 1 && <span className="small muted">{group.count} related questions</span>}
      </span>
      <span className="finding-text">{group.question}</span>
      <span className="small muted">Next step: {group.nextStep}</span>
      {group.findingIds.length > 0 && (
        <span className="row">
          {group.findingIds.slice(0, 2).map((findingId) => {
            const finding = model.findings.find((entry) => entry.id === findingId);
            return finding ? (
              <button key={findingId} type="button" className="btn btn-quiet" onClick={() => onFinding(finding)}>
                {findingId}
              </button>
            ) : null;
          })}
        </span>
      )}
    </li>
  );

  return (
    <section className="briefing-section" id="gaps" aria-labelledby="gaps-title">
      <h2 id="gaps-title">
        What could not be determined? <span className="count-chip">{model.counts.openQuestions}</span>
      </h2>
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
        {report.coverage.neverSearched.length > 0 && (
          <p className="alert alert-warn">
            Available but never searched: {report.coverage.neverSearched.join(", ")}. Findings may be incomplete.
          </p>
        )}
        {top.length === 0 ? (
          <p className="empty">No open question was recorded.</p>
        ) : (
          <ul className="finding-list question-groups">{top.map(renderGroup)}</ul>
        )}
        {rest.length > 0 && (
          <details className="show-all">
            <summary>Show all ({model.counts.openQuestions})</summary>
            <ul className="finding-list question-groups">{rest.map(renderGroup)}</ul>
          </details>
        )}
      </div>
    </section>
  );
}

const LANES: { id: string; label: string }[] = [
  { id: "client", label: "Client" },
  { id: "promises", label: "Promises" },
  { id: "owner", label: "Owner" },
  { id: "ticket", label: "Ticket" },
  { id: "engineering", label: "Engineering" },
];

function laneFor(finding: ReportFindingModel, model: ReportModel): string {
  if (finding.kind === "promise") return "promises";
  if (finding.kind === "status_change") return "owner";
  if (finding.failureTag === "technical" || finding.failureTag === "process") return "engineering";
  const actor = actorFor(model, finding.eventActorId);
  if (actor?.role === "client") return "client";
  if (finding.source === "jira") return "ticket";
  return "engineering";
}

export function ModelSwimlane({ report, onFinding }: { report: ReportPayload; onFinding: (finding: ReportFindingModel) => void }) {
  const model = report.model;
  const times = model.findings.map((finding) => Date.parse(finding.ts)).filter(Number.isFinite);
  if (times.length === 0) return <p className="empty">No dated findings to place on the board.</p>;
  const min = Math.min(...times);
  const max = Math.max(...times);
  const span = Math.max(1, max - min);
  const percent = (ts: string) => 4 + Math.min(92, Math.max(0, ((Date.parse(ts) - min) / span) * 92));
  const silence = model.silence;
  const byLane = new Map(LANES.map((lane) => [lane.id, model.findings.filter((finding) => laneFor(finding, model) === lane.id)]));
  return (
    <div className="swimlane-wrap">
      <div className="swimlane">
        <div className="swimlane-axis" aria-hidden>
          <span className="swimlane-axis-spacer" />
          <div className="swimlane-axis-track">
            <span className="tabular">{new Date(min).toISOString().slice(0, 10)}</span>
            <span className="tabular">{new Date(max).toISOString().slice(0, 10)}</span>
          </div>
        </div>
        <div className="swimlane-body">
          {LANES.map((lane) => (
            <div className="swimlane-row" key={lane.id}>
              <span className="swimlane-label">{lane.label}</span>
              <div className="swimlane-track">
                {silence && (byLane.get(lane.id)?.length ?? 0) > 0 && (
                  <span
                    className="silence-band"
                    style={{ left: `${percent(silence.from)}%`, width: `${percent(silence.to) - percent(silence.from)}%` }}
                    title={silence.label}
                  />
                )}
                {(byLane.get(lane.id) ?? []).map((finding) => {
                  const actor = actorFor(model, finding.eventActorId);
                  return (
                    <button
                      key={finding.id}
                      type="button"
                      className="marker"
                      style={{
                        left: `${percent(finding.ts)}%`,
                        color: PERSON_COLORS[actorColor(model, finding.eventActorId)],
                      }}
                      data-importance={finding.importance}
                      data-pill={finding.pill ?? "none"}
                      title={`${actor?.name ?? "Unknown"} · ${finding.headline} · ${finding.ts}`}
                      aria-label={`${finding.headline} (${finding.ts})`}
                      onClick={() => onFinding(finding)}
                    >
                      <span className="marker-dot" />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {silence && (
            <p className="silence-label small muted">
              {silence.label} · {silence.from.slice(0, 10)} → {silence.to.slice(0, 10)}
            </p>
          )}
        </div>
      </div>
      <div className="swimlane-legend small muted">
        <span className="legend-item"><span className="legend-swatch legend-needs-check" /> needs check</span>
        <span className="legend-item"><span className="legend-swatch legend-conflict" /> conflict</span>
        <span className="legend-item"><span className="legend-swatch legend-silence" /> silent period</span>
      </div>
    </div>
  );
}
