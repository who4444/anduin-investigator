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
  synthetic,
  cached,
  live,
}: {
  report: ReportPayload;
  progressHref: string;
  synthetic: boolean;
  cached: boolean;
  live: boolean;
}) {
  const [drawer, setDrawer] = useState<{ eventId: string; claimId?: string } | null>(null);
  const [reply, setReply] = useState(report.reply);
  const [replyState, setReplyState] = useState<"idle" | "loading" | "error">("idle");
  const [replyError, setReplyError] = useState<string | null>(null);
  const active = useScrollSpy();

  const sources = [...new Set(report.events.map((event) => event.source))];

  const openClaim = (claimId: string | undefined) => {
    if (!claimId) return;
    const claim = report.claims.find((candidate) => candidate.id === claimId);
    if (claim) setDrawer({ eventId: claim.eventId, claimId });
  };
  const openEvent = (eventId: string) => setDrawer({ eventId });

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
      <div className="briefing-top">
        <div className="report-header-inner">
          <div className="spread">
            <h1 style={{ fontSize: 20, fontWeight: 700 }}>{report.investigation.title}</h1>
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
            <a href={progressHref}>Watch the run</a> and reload afterwards.
          </p>
        )}
        <AnswerSection report={report} onClaim={openClaim} onEvent={openEvent} />

        <section className="briefing-section" id="story" aria-labelledby="story-title">
          <h2 id="story-title">What happened</h2>
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
        <GapsSection report={report} onClaim={openClaim} onEvent={openEvent} />
        <ReplySection
          sentences={reply?.sentences ?? null}
          state={replyState}
          error={replyError}
          onDraft={draftReply}
          onClaim={openClaim}
        />

        <details className="briefing-section appendix" id="timeline-detail">
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
