import { notFound } from "next/navigation";

import { BriefingShell } from "@/app/_components/briefing/shell";
import { pruneStaleReply } from "@/lib/agents/reply";
import { buildResult } from "@/lib/pipeline/assemble";
import { buildBriefing } from "@/lib/report/briefing";
import { buildBottomLine } from "@/lib/report/bottomline";
import {
  buildReportView,
  type IssueSummary,
  type ReportPayload,
} from "@/lib/report/build";
import { getIssueReportExtras, getReportExtras } from "@/lib/store";

export const dynamic = "force-dynamic";

const INVESTIGATOR_KINDS = ["root_cause", "commitments", "ownership"] as const;

export default async function ReportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;

  let report: ReportPayload;
  try {
    const assembled = await buildResult(id);
    const requested = typeof query.issue === "string" ? query.issue : null;
    // Per-issue is the default for a multi-issue case; "all" keeps the old
    // combined view available for cross-issue reading.
    const selected =
      requested === "all"
        ? null
        : assembled.issues.find((issue) => issue.id === requested) ??
          assembled.issues[0] ??
          null;
    const activeIssueId = selected?.id ?? null;
    // A single-issue case keeps the full event set (the historical report
    // behaviour); only a genuinely multi-issue case narrows to the selected
    // issue's cited records.
    const filterIssue = assembled.issues.length > 1 ? selected : null;

    const allClaims = assembled.claims;
    const activeClaims = filterIssue
      ? allClaims.filter((claim) => claim.issueId === filterIssue.id)
      : allClaims;
    const activeClaimIds = new Set(activeClaims.map((claim) => claim.id));
    const activeEventIds = new Set(activeClaims.map((claim) => claim.eventId));
    const activeEvents = filterIssue
      ? assembled.timeline.filter((event) => activeEventIds.has(event.id))
      : assembled.timeline;
    const activeGaps = filterIssue
      ? assembled.gaps.filter(
          (gap) => gap.issueId === filterIssue.id || !gap.issueId,
        )
      : assembled.gaps;
    const activeNotes = filterIssue
      ? assembled.skepticNotes.filter(
          (note) =>
            (note.claimId !== undefined && activeClaimIds.has(note.claimId)) ||
            note.eventIds.some((eventId) => activeEventIds.has(eventId)),
        )
      : assembled.skepticNotes;

    const activeStats = {
      total: activeClaims.length,
      verified: activeClaims.filter((claim) => claim.verifyStatus === "verified").length,
      supported: activeClaims.filter((claim) => claim.verifyStatus === "supported").length,
      rejected: activeClaims.filter((claim) => claim.verifyStatus === "rejected").length,
      flagged: activeClaims.filter((claim) => claim.skepticFlag).length,
    };
    const activeMissing = filterIssue
      ? INVESTIGATOR_KINDS.filter(
          (kind) =>
            !activeClaims.some(
              (claim) =>
                claim.agent === kind &&
                (claim.verifyStatus === "verified" || claim.verifyStatus === "supported"),
            ),
        )
      : assembled.missing;

    const issueSummaries: IssueSummary[] = assembled.issues.map((issue) => {
      const claims = allClaims.filter((claim) => claim.issueId === issue.id);
      const visible = claims.filter(
        (claim) => claim.verifyStatus === "verified" || claim.verifyStatus === "supported",
      );
      const top =
        visible.find((claim) => claim.type === "root_cause" && !claim.skepticFlag) ??
        visible.find((claim) => claim.type === "root_cause") ??
        visible[0] ??
        null;
      return {
        id: issue.id,
        seq: issue.seq,
        title: issue.title,
        ask: issue.ask,
        confidence: issue.confidence,
        total: claims.length,
        verified: claims.filter((claim) => claim.verifyStatus === "verified").length,
        supported: claims.filter((claim) => claim.verifyStatus === "supported").length,
        flagged: claims.filter((claim) => claim.skepticFlag).length,
        topFinding: top?.text ?? null,
      };
    });

    // A reply drafted for a legacy single-issue case lives in report_extras;
    // per-issue replies live in issue_report_extras.
    const issueExtras = selected ? await getIssueReportExtras(id, selected.id) : null;
    const legacyExtras =
      !issueExtras && assembled.issues.length <= 1 ? await getReportExtras(id) : null;
    const extras = issueExtras ?? legacyExtras;
    const prunedReply = pruneStaleReply(extras?.reply ?? null, activeClaims);

    report = {
      investigation: {
        id: assembled.investigation.id,
        title: assembled.investigation.title,
        escalationText: assembled.investigation.escalationText,
        createdAt: assembled.investigation.createdAt,
        origin: assembled.investigation.origin,
        ingestWarnings: assembled.investigation.ingestWarnings,
      },
      // The drawer can open any stored record; the active issue's claims are
      // what the sections show.
      events: assembled.timeline,
      // The review list is for deciding, not reading: cap the preview text.
      excludedEvents: assembled.excludedEvents.map((event) => ({
        ...event,
        text: event.text.slice(0, 240),
      })),
      claims: activeClaims,
      stats: activeStats,
      stages: assembled.stages,
      coverage: assembled.coverage,
      gaps: activeGaps,
      skepticNotes: activeNotes,
      verdict: extras ? (prunedReply ? extras.verdict : null) : null,
      reply: prunedReply,
      ...buildReportView({
        events: activeEvents,
        claims: activeClaims,
        notes: activeNotes,
      }),
      briefing: buildBriefing({
        events: activeEvents,
        claims: activeClaims,
      }),
      bottomLine: buildBottomLine({
        events: activeEvents,
        claims: activeClaims,
        notes: activeNotes,
        gaps: activeGaps,
      }),
      scope: assembled.scope,
      issues: issueSummaries,
      activeIssueId,
      unassignedClaims: allClaims.filter((claim) => !claim.issueId).length,
      complete: assembled.complete,
      missing: activeMissing,
    };
  } catch (error) {
    // Only a genuinely unknown investigation is a 404; anything else (database
    // outage, partial pipeline state) must not masquerade as a missing page.
    if (error instanceof Error && /^No investigation with id /.test(error.message)) notFound();
    throw error;
  }

  const flags = new URLSearchParams();
  if (query.synthetic === "1" || report.investigation.origin === "demo") flags.set("synthetic", "1");
  if (query.live === "1" || report.investigation.origin === "pull") flags.set("live", "1");
  if (query.cached === "1") flags.set("cached", "1");
  const suffix = flags.toString();
  const progressHref = `/investigations/${id}/progress?review=1${suffix ? `&${suffix}` : ""}`;
  // G-01 review: the report offers the excluded list, and this is where a
  // confirmed add-back re-runs the investigation over the enlarged scope.
  const rerunHref = `/investigations/${id}/progress?rerun=1${suffix ? `&${suffix}` : ""}`;

  return (
    <BriefingShell
      report={report}
      progressHref={progressHref}
      rerunHref={rerunHref}
      synthetic={query.synthetic === "1" || report.investigation.origin === "demo"}
      cached={query.cached === "1"}
      live={query.live === "1" || report.investigation.origin === "pull"}
    />
  );
}
