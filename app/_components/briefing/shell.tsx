"use client";

import { useState } from "react";

import { ChaptersSection } from "@/app/_components/briefing/chapters";
import { PERSON_COLORS } from "@/app/_components/briefing/people";
import { CausesSection, GapsSection, PromisesSection, ReplySection } from "@/app/_components/briefing/sections";
import { StorySection } from "@/app/_components/briefing/story";
import { SwimlaneSection } from "@/app/_components/briefing/swimlane";
import { EvidenceDrawer } from "@/app/_components/evidence";
import type { ReportPayload } from "@/lib/report/build";

const SECTIONS = [
  { id: "story", label: "The story" },
  { id: "board", label: "Board" },
  { id: "chapters", label: "Chapters" },
  { id: "promises", label: "Promises" },
  { id: "causes", label: "Causes and ownership" },
  { id: "gaps", label: "Gaps and confidence" },
  { id: "reply", label: "Draft reply" },
];

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

  const sources = [...new Set(report.events.map((event) => event.source))];
  const verdict = report.verdict ?? report.briefing.narrative ?? null;

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
          {verdict && <p className="verdict">{verdict}</p>}
          <div className="report-meta small muted">
            <span className="tabular">Escalation {report.investigation.createdAt.slice(0, 10)}</span>
            <span aria-hidden>·</span>
            <span className="tabular">
              {report.stats.kept} of {report.stats.total} claims verified
            </span>
            <span aria-hidden>·</span>
            {sources.map((source) => (
              <span key={source} className={`chip chip-source-${source}`}>
                {source}
              </span>
            ))}
            <span aria-hidden>·</span>
            <a href={progressHref}>How this was produced</a>
          </div>
        </div>
        <nav className="section-index" aria-label="Report sections">
          {SECTIONS.map((section) => (
            <a key={section.id} href={`#${section.id}`}>
              {section.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="shell">
        <StorySection report={report} onClaim={openClaim} onEvent={openEvent} />
        <SwimlaneSection report={report} onClaim={openClaim} />
        <ChaptersSection report={report} onClaim={openClaim} />
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
        <p className="small muted" style={{ paddingTop: 24 }}>
          Person colors are a fixed palette for this briefing ({PERSON_COLORS.length} slots).
        </p>
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
