"use client";

import { useEffect, useState } from "react";

import { AnswerSection } from "@/app/_components/briefing/answer";
import { ChaptersList } from "@/app/_components/briefing/chapters";
import { MomentsStrip } from "@/app/_components/briefing/story";
import { CausesSection, GapsSection, PromisesSection, ReplySection } from "@/app/_components/briefing/sections";
import { SwimlaneSection } from "@/app/_components/briefing/swimlane";
import { EvidenceDrawer } from "@/app/_components/evidence";
import type { ReportPayload } from "@/lib/report/build";

const SECTIONS = [
  { id: "answer", label: "The answer" },
  { id: "story", label: "What happened" },
  { id: "promises", label: "What was promised?" },
  { id: "causes", label: "What went wrong?" },
  { id: "gaps", label: "What could not be determined?" },
  { id: "reply", label: "Draft reply" },
  { id: "timeline-detail", label: "Timeline detail" },
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
  const [drawer, setDrawer] = useState<{ eventId: string; claimId?: string } | null>(null);
  const [reply, setReply] = useState(report.reply);
  const [replyState, setReplyState] = useState<"idle" | "loading" | "error">("idle");
  const [replyError, setReplyError] = useState<string | null>(null);
  const [appendixOpen, setAppendixOpen] = useState(false);
  const active = useScrollSpy();

  const sources = [...new Set(report.events.map((event) => event.source))];
  const multi = report.issues.length > 1;
  const activeIssue = report.issues.find((issue) => issue.id === report.activeIssueId) ?? null;

  // G-01: excluded client evidence outranks every other drafting restriction.
  const excludedClientRecords = report.scope?.excludedClientRecords ?? 0;
  const replyDisabledReason =
    excludedClientRecords > 0
      ? `${excludedClientRecords} record${excludedClientRecords === 1 ? "" : "s"} authored by the client ${
          excludedClientRecords === 1 ? "is" : "are"
        } excluded from this investigation — a reply could contradict evidence that was never searched, so drafting is blocked until the scope is resolved.`
      : multi && !report.activeIssueId
        ? "Open an issue tab to draft its reply; the combined view mixes issues."
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

  const openClaim = (claimId: string | undefined) => {
    if (!claimId) return;
    const claim = report.claims.find((candidate) => candidate.id === claimId);
    if (claim) setDrawer({ eventId: claim.eventId, claimId });
  };
  const openEvent = (eventId: string) => setDrawer({ eventId });

  async function approveReply(approved: boolean) {
    // Optimistic: the checkbox must reflect the click immediately; the
    // persisted state is the source of truth on reload, and a failed write
    // reverts the UI.
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
            <h1 className="report-title">{report.investigation.title}</h1>
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
              onClick={section.id === "timeline-detail" ? () => setAppendixOpen(true) : undefined}
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
        {multi && !report.activeIssueId && (
          <IssueOverview report={report} hrefFor={issueHref} />
        )}
        {multi && !report.activeIssueId && (
          <p className="alert alert-warn">
            Combined view: findings from {report.issues.length} independent issues are shown
            together below. Open an issue above for its own timeline, promises and reply.
          </p>
        )}
        <AnswerSection report={report} onClaim={openClaim} onEvent={openEvent} />

        <section className="briefing-section" id="story" aria-labelledby="story-title">
          <h2 id="story-title">What happened</h2>
          {report.caseState.asOf && (
            <p className="small muted">
              Current as of {report.caseState.asOf.slice(0, 10)} — the newest record in this
              investigation.
            </p>
          )}
          <div className="stack">
            {report.briefing.keyMoments.length > 0 && (
              <MomentsStrip
                moments={report.briefing.keyMoments}
                people={report.briefing.people}
                onClaim={openClaim}
              />
            )}
            <ChaptersList report={report} onClaim={openClaim} />
          </div>
        </section>

        <PromisesSection report={report} onClaim={openClaim} onEvent={openEvent} />
        <CausesSection report={report} onClaim={openClaim} />
        <GapsSection report={report} onClaim={openClaim} onEvent={openEvent} rerunHref={rerunHref} />
        <ReplySection
          reply={reply}
          state={replyState}
          error={replyError}
          onDraft={draftReply}
          onClaim={openClaim}
          onApprove={approveReply}
          disabledReason={replyDisabledReason}
        />

        <details
          className="briefing-section appendix"
          id="timeline-detail"
          open={appendixOpen}
          onToggle={(toggleEvent) =>
            setAppendixOpen((toggleEvent.target as HTMLDetailsElement).open)
          }
        >
          <summary>
            <span className="appendix-title">Timeline detail</span>
            <span className="small muted">swimlane board with every finding, silence and lapse</span>
          </summary>
          <div className="stack">
            <SwimlaneSection report={report} onClaim={openClaim} embedded />
            <p className="small muted">
              Person colors are a fixed palette for this briefing.
            </p>
          </div>
        </details>
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
            <span className="row">
              <span className="small muted tabular">Issue {issue.seq}</span>
              <span className="chip">
                {issue.verified} verified · {issue.supported} check
                {issue.flagged > 0 ? ` · ${issue.flagged} flagged` : ""}
              </span>
            </span>
            <strong>{issue.title}</strong>
            {issue.ask && <span className="small">{issue.ask}</span>}
            {issue.topFinding && (
              <span className="small muted issue-card-finding">
                Top finding: {issue.topFinding}
              </span>
            )}
            <span className="small muted">
              {issue.total} finding{issue.total === 1 ? "" : "s"} · open issue →
            </span>
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
