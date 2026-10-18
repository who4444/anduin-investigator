"use client";

import { useEffect, useState } from "react";

import { EvidenceDrawer } from "@/app/_components/evidence";
import {
  ClientResolutionNotice,
  ModelAnswer,
  ModelFailures,
  ModelOpenQuestions,
  ModelPromises,
  ModelStory,
  ModelSwimlane,
} from "@/app/_components/briefing/model-view";
import { ReplySection } from "@/app/_components/briefing/sections";
import type { ReportPayload } from "@/lib/report/build";
import { fullFindingLabel } from "@/lib/report/model";
import type { ReportFindingModel } from "@/lib/report/model";

const SECTIONS = [
  { id: "answer", label: "The answer" },
  { id: "story", label: "What happened" },
  { id: "timeline-detail", label: "Timeline detail" },
  { id: "promises", label: "Promises" },
  { id: "causes", label: "Failures" },
  { id: "gaps", label: "Open questions" },
  { id: "reply", label: "Reply" },
];

function useScrollSpy(): string {
  const [active, setActive] = useState(SECTIONS[0].id);
  useEffect(() => {
    const observed = SECTIONS.map((section) => document.getElementById(section.id)).filter(
      (element): element is HTMLElement => element !== null,
    );
    if (observed.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActive(visible[0].target.id);
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    for (const element of observed) observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return active;
}

export function BriefingShell({
  report,
  progressHref,
  rerunHref,
  watchHref,
  synthetic,
  cached,
  live,
}: {
  report: ReportPayload;
  progressHref: string;
  rerunHref: string;
  watchHref: string;
  synthetic: boolean;
  cached: boolean;
  live: boolean;
}) {
  const [drawer, setDrawer] = useState<{ eventId: string; claimId?: string; heading?: string } | null>(null);
  const [reply, setReply] = useState(report.reply);
  const [replyState, setReplyState] = useState<"idle" | "loading" | "error">("idle");
  const [replyError, setReplyError] = useState<string | null>(null);
  const active = useScrollSpy();

  const model = report.model;
  const sources = [...new Set(model.findings.map((finding) => finding.source))];
  const multi = report.issues.length > 1;
  const activeIssue = report.issues.find((issue) => issue.id === report.activeIssueId) ?? null;

  const excludedClientRecords = report.scope?.excludedClientRecords ?? 0;
  const replyDisabledReason =
    excludedClientRecords > 0
      ? `${excludedClientRecords} record${excludedClientRecords === 1 ? "" : "s"} authored by the client ${
          excludedClientRecords === 1 ? "is" : "are"
        } excluded from this investigation — a reply could contradict evidence that was never searched, so drafting is blocked until the scope is resolved.`
      : model.crossTenant
        ? "This export contains more than one candidate engagement and the escalation does not identify which one. Confirm the engagement before drafting a reply."
        : multi && !report.activeIssueId
          ? "Open an issue tab to draft its reply; the combined view mixes issues."
          : !model.client.clientKnown
            ? "Confirm the client before drafting a reply — a draft to the wrong party could contradict the records."
            : model.counts.verified === 0
              ? "No verified, client-safe finding is available yet; run verification and review the findings before drafting a reply."
              : null;

  const issueHref = (issueId: string | null) => {
    const query = new URLSearchParams();
    if (issueId) query.set("issue", issueId);
    else query.set("issue", "all");
    if (synthetic) query.set("synthetic", "1");
    if (cached) query.set("cached", "1");
    if (live) query.set("live", "1");
    return `/investigations/${report.investigation.id}?${query.toString()}`;
  };

  const openClaim = (claimId: string | undefined, heading?: string) => {
    if (!claimId) return;
    const claim = report.claims.find((candidate) => candidate.id === claimId);
    if (claim) setDrawer({ eventId: claim.eventId, claimId, heading });
  };
  const openFinding = (finding: ReportFindingModel) => {
    const heading = fullFindingLabel(finding, report.model.actors);
    if (finding.claimIds[0]) openClaim(finding.claimIds[0], heading);
    else if (finding.eventIds[0]) setDrawer({ eventId: finding.eventIds[0], heading });
  };

  async function approveReply(approved: boolean) {
    setReply((current) => (current ? { ...current, approved } : current));
    const response = await fetch(`/api/investigations/${report.investigation.id}/reply/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issueId: report.activeIssueId, approved }),
    });
    if (!response.ok) {
      setReply((current) => (current ? { ...current, approved: !approved } : current));
    }
  }

  async function draftReply() {
    setReplyState("loading");
    setReplyError(null);
    try {
      const response = await fetch(`/api/investigations/${report.investigation.id}/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ issueId: report.activeIssueId }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        greeting?: string;
        sentences?: { text: string; claimIds: string[]; label?: "safe" | "needs-check" | "do-not-send" }[];
        signOff?: string;
        approved?: boolean;
        error?: string;
      };
      if (!response.ok || !payload.sentences) throw new Error(payload.error ?? "Could not draft the reply.");
      setReply({
        greeting: payload.greeting,
        sentences: payload.sentences,
        signOff: payload.signOff,
        approved: payload.approved === true,
      });
      setReplyState("idle");
    } catch (error) {
      setReplyState("error");
      setReplyError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div>
      <div className="briefing-top">
        <div className="report-header-inner">
          <div className="spread">
            <h1 className="report-title">{model.title}</h1>
            <span className="row">
              {synthetic && <span className="chip chip-broken">synthetic data</span>}
              {live && <span className="chip">pulled live</span>}
              {cached && <span className="chip">cached result</span>}
            </span>
          </div>
          <div className="report-meta small muted">
            <span className="tabular">Logged {report.investigation.createdAt.slice(0, 10)}</span>
            <span aria-hidden>·</span>
            {sources.map((source) => (
              <span key={source} className={`source-label source-${source}`}>
                {source}
              </span>
            ))}
            <span aria-hidden>·</span>
            <a href={progressHref}>How this was produced</a>
          </div>
          {multi && (
            <div className="issue-heading">
              <span className="chip">
                {activeIssue ? `Issue ${activeIssue.seq} of ${report.issues.length}` : "All issues"}
              </span>
              <span className="issue-heading-title">
                {activeIssue ? activeIssue.title : "Combined view — findings from every issue"}
              </span>
            </div>
          )}
          {multi && activeIssue?.ask && (
            <p className="small muted issue-ask">
              <strong>The client asks on this issue:</strong> {activeIssue.ask}
            </p>
          )}
          {multi && report.activeIssueId && report.unassignedClaims > 0 && (
            <p className="alert alert-warn">
              {report.unassignedClaims} finding{report.unassignedClaims === 1 ? "" : "s"} could not
              be attributed to an issue and appear only in <a href={issueHref(null)}>All issues</a>.
            </p>
          )}
          {multi && (
            <nav className="issue-index" aria-label="Issues in this escalation">
              <a
                href={issueHref(null)}
                className={report.activeIssueId ? undefined : "is-active"}
                aria-current={report.activeIssueId ? undefined : "page"}
              >
                All issues
              </a>
              {report.issues.map((issue) => (
                <a
                  key={issue.id}
                  href={issueHref(issue.id)}
                  className={report.activeIssueId === issue.id ? "is-active" : undefined}
                  aria-current={report.activeIssueId === issue.id ? "page" : undefined}
                  title={issue.title}
                >
                  <span className="tabular">{issue.seq}</span> {issue.title}
                </a>
              ))}
            </nav>
          )}
        </div>
        <nav className="section-index" aria-label="Report sections">
          {SECTIONS.map((section) => (
            <a
              key={section.id}
              href={`#${section.id}`}
              className={active === section.id ? "is-active" : undefined}
              aria-current={active === section.id ? "true" : undefined}
            >
              {section.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="shell">
        {!report.complete && (
          <p className="alert alert-warn">
            This report is still being produced — findings may be incomplete.{" "}
            <a href={watchHref}>Watch the run</a> and reload afterwards.
          </p>
        )}
        {multi && !report.activeIssueId && <IssueOverview report={report} hrefFor={issueHref} />}
        {multi && !report.activeIssueId && (
          <p className="alert alert-warn">
            Combined view: findings from {report.issues.length} independent issues are shown
            together below. Open an issue above for its own timeline, promises and reply.
          </p>
        )}
        <ClientResolutionNotice report={report} />
        {model.crossTenant ? (
          <section className="briefing-section answer" id="answer" aria-labelledby="answer-title">
            <h2 id="answer-title" className="visually-hidden">The answer</h2>
            <div className="verdict headline">
              {model.headline.sentences.map((sentence, index) => (
                <p key={index} className={index === 0 ? "headline-lead" : "headline-line"}>
                  {sentence.text}
                </p>
              ))}
              {model.headline.nextStep && (
                <p className="headline-next">Next step: {model.headline.nextStep}</p>
              )}
              <p className="headline-stats small muted">{model.headline.statsLine}</p>
            </div>
          </section>
        ) : (
          <>
            <ModelAnswer report={report} onFinding={openFinding} />
            <ModelStory report={report} onFinding={openFinding} />
            <section className="briefing-section board-section" id="timeline-detail" aria-labelledby="board-title">
              <h2 id="board-title">Timeline detail</h2>
              <p className="small muted">One board for the whole report; the silent period is drawn here once.</p>
              <ModelSwimlane report={report} onFinding={openFinding} />
            </section>
            <ModelPromises report={report} onFinding={openFinding} />
            <ModelFailures report={report} onFinding={openFinding} />
          </>
        )}
        <ModelOpenQuestions report={report} rerunHref={rerunHref} onFinding={openFinding} />
        <ReplySection
          reply={reply}
          state={replyState}
          error={replyError}
          onDraft={draftReply}
          onClaim={openClaim}
          onApprove={approveReply}
          disabledReason={replyDisabledReason}
        />
      </div>

      {drawer && (
        <EvidenceDrawer
          eventId={drawer.eventId}
          claimId={drawer.claimId}
          heading={drawer.heading}
          events={report.events}
          claims={report.claims}
          onClose={() => setDrawer(null)}
        />
      )}
    </div>
  );
}

function IssueOverview({
  report,
  hrefFor,
}: {
  report: ReportPayload;
  hrefFor: (issueId: string | null) => string;
}) {
  return (
    <section className="briefing-section issue-overview" id="issues" aria-labelledby="issues-title">
      <h2 id="issues-title">Issues in this escalation</h2>
      <p className="small muted">
        {report.issues.length} independent issues were investigated in one evidence set. Each has
        its own timeline, promises and draft reply; nothing is merged across them.
      </p>
      <div className="issue-grid">
        {report.issues.map((issue) => (
          <a className="issue-card" key={issue.id} href={hrefFor(issue.id)}>
            <span className="small muted tabular">Issue {issue.seq}</span>
            <strong>{issue.title}</strong>
            {issue.ask && <span className="small">{issue.ask}</span>}
            <span className="small muted">Open issue →</span>
          </a>
        ))}
      </div>
      {report.unassignedClaims > 0 && (
        <p className="alert alert-warn">
          {report.unassignedClaims} finding{report.unassignedClaims === 1 ? "" : "s"} could not be
          assigned to an issue. They appear in the combined view only; open an issue to see the
          findings that were attributed.
        </p>
      )}
    </section>
  );
}
