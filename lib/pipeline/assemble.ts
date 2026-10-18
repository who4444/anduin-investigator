import {
  appendStageLog,
  getClaims,
  getCommitments,
  getEvents,
  getGaps,
  getIdentities,
  getInvestigation,
  getIssues,
  getSkepticNotes,
  getStages,
  recordReportVersion,
} from "../store";
import type {
  Claim,
  Commitment,
  Event,
  Gap,
  Investigation,
  Issue,
  SkepticNote,
  Stage,
} from "../types";
import type { InvestigatorKind } from "../agents/investigator";
import { buildCoverage, type CoverageReport } from "./coverage";
import { excludedClientEvidence, splitEventsByScope, type ReportScope } from "./scope";
import { buildBriefing } from "../report/briefing";
import { PIPELINE_VERSION, modelVersion } from "./version";

const INVESTIGATOR_KINDS: InvestigatorKind[] = ["root_cause", "commitments", "ownership"];
const LEDGER_TYPES = new Set(["commitment", "decision"]);
const MAX_RETRY_PASS = 2;

export interface AssembledStats {
  total: number;
  verified: number;
  supported: number;
  rejected: number;
  /** Claims that never went through verification (a crashed verify stage) —
      they are the reason total can exceed verified+supported+rejected. */
  unverified: number;
  flagged: number;
}

export interface AssembledResult {
  investigation: Investigation;
  issues: Issue[];
  timeline: Event[];
  /** Records the scope split excluded, so the manager can review and add them back (G-01). */
  excludedEvents: Event[];
  /** G-05: structured promises, when the run produced them. */
  commitments: Commitment[];
  ledger: Claim[];
  claims: Claim[];
  gaps: Gap[];
  skepticNotes: SkepticNote[];
  coverage: CoverageReport;
  stats: AssembledStats;
  identities: AssembledIdentity[];
  stages: Stage[];
  scope: ReportScope | null;
  /** True only once the assemble stage has completed at least once: a report
      read mid-run must not present itself as a finished "no findings" answer. */
  complete: boolean;
}

export interface AssembledIdentity {
  alias: string;
  canonical: string;
  method: string;
  confidence: number;
  applied: boolean;
}

export interface AssembleOutcome extends AssembledResult {
  needsRetry: boolean;
  missing: string[];
  pass: number;
}

function coalesceActor(event: Event): Event {
  return event.actorResolved ? { ...event, actor: event.actorResolved } : event;
}

function currentPass(stages: Stage[]): number {
  const investigatorPasses = stages
    .filter((stage) => (INVESTIGATOR_KINDS as string[]).includes(stage.stage))
    .map((stage) => stage.pass);
  return investigatorPasses.length > 0 ? Math.max(...investigatorPasses) : 1;
}

function isVisibleClaim(claim: Claim): boolean {
  return claim.verifyStatus === "verified" || claim.verifyStatus === "supported";
}

export async function buildResult(investigationId: string): Promise<AssembleOutcome> {
  const investigation = await getInvestigation(investigationId);
  if (!investigation) {
    throw new Error(`No investigation with id ${investigationId}.`);
  }

  const [events, allClaims, commitments, gaps, skepticNotes, identities, stages, issues] =
    await Promise.all([
      getEvents(investigationId),
      getClaims(investigationId),
      getCommitments(investigationId),
      getGaps(investigationId),
      getSkepticNotes(investigationId),
      getIdentities(investigationId),
      getStages(investigationId),
      getIssues(investigationId),
    ]);

  // The registry may hold records for several clients and projects; when a
  // scope was identified for this escalation, the report covers only the
  // scoped records AND their claims — a claim citing a filtered record is
  // excluded too, and both exclusions are disclosed.
  const { inScope, outOfScope } = splitEventsByScope(
    events,
    investigation.scope,
    investigation.scopeOverrides,
  );
  const timeline = inScope.map(coalesceActor);
  const inScopeIds = new Set(timeline.map((event) => event.id));
  const registryIds = new Set(events.map((event) => event.id));
  // A claim citing a record the registry does not have can never be scoped;
  // it stays in the counts because verification already rejected it (an
  // honesty signal). Only claims citing KNOWN out-of-scope records drop.
  const claims = allClaims.filter(
    (claim) => inScopeIds.has(claim.eventId) || !registryIds.has(claim.eventId),
  );
  const excludedClaims = allClaims.length - claims.length;
  const visibleClaims = claims.filter(isVisibleClaim);

  const ledger = visibleClaims
    .filter((claim) => LEDGER_TYPES.has(claim.type))
    .sort((a, b) => {
      const left = a.ts ?? "";
      const right = b.ts ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const stats: AssembledStats = {
    total: claims.length,
    verified: claims.filter((claim) => claim.verifyStatus === "verified").length,
    supported: claims.filter((claim) => claim.verifyStatus === "supported").length,
    rejected: claims.filter((claim) => claim.verifyStatus === "rejected").length,
    unverified: claims.filter((claim) => claim.verifyStatus === "unverified").length,
    flagged: claims.filter((claim) => claim.skepticFlag).length,
  };

  const missing = INVESTIGATOR_KINDS.filter((kind) => {
    const kindClaims = claims.filter((claim) => claim.agent === kind);
    return !kindClaims.some(isVisibleClaim);
  });

  const pass = currentPass(stages);
  const needsRetry = missing.length > 0 && pass < MAX_RETRY_PASS;
  const coverage = buildCoverage(events, stages, timeline);
  const complete = stages.some((stage) => stage.stage === "assemble" && stage.status === "done");

  const scope: ReportScope | null = investigation.scope
    ? (() => {
        const clientEvidence = excludedClientEvidence(events, investigation.scope);
        return {
          ...investigation.scope,
          excludedRecords: outOfScope.length,
          excludedClaims,
          excludedClientRecords: clientEvidence.excludedEventIds.length,
          excludedClientEventIds: clientEvidence.excludedEventIds,
          includedByReview: investigation.scopeOverrides.filter((eventId) => inScopeIds.has(eventId))
            .length,
        };
      })()
    : null;

  return {
    investigation,
    issues,
    timeline,
    excludedEvents: outOfScope,
    // Commitments whose backing claim was filtered out are dropped by the
    // report builders (they resolve the claim from the filtered set).
    commitments,
    ledger,
    claims,
    gaps,
    skepticNotes,
    coverage,
    stats,
    identities: identities.map((identity) => ({
      alias: identity.alias,
      canonical: identity.canonical,
      method: identity.method,
      confidence: identity.confidence,
      applied: identity.applied,
    })),
    stages,
    scope,
    complete,
    needsRetry,
    missing,
    pass,
  };
}

export async function assemble(investigationId: string): Promise<AssembleOutcome> {
  const result = await buildResult(investigationId);

  await appendStageLog(investigationId, "assemble", result.pass, {
    needsRetry: result.needsRetry,
    missing: result.missing,
    stats: result.stats,
    issues: result.issues.length,
  });

  // G-08: freeze the top answer now. The report page reads the latest version;
  // drafting a reply or re-rendering the page cannot rewrite this narrative.
  const caseBriefing = buildBriefing({
    events: result.timeline,
    claims: result.claims,
    commitments: result.commitments,
  });
  await recordReportVersion({
    investigationId,
    issueId: null,
    narrative: caseBriefing.narrative,
    stats: result.stats,
    model: modelVersion(),
    promptVersion: PIPELINE_VERSION,
  });
  for (const issue of result.issues) {
    const issueClaims = result.claims.filter((claim) => claim.issueId === issue.id);
    if (issueClaims.length === 0) continue;
    const issueBriefing = buildBriefing({
      events: result.timeline,
      claims: issueClaims,
      commitments: result.commitments.filter((commitment) => commitment.issueId === issue.id),
    });
    await recordReportVersion({
      investigationId,
      issueId: issue.id,
      narrative: issueBriefing.narrative,
      stats: result.stats,
      model: modelVersion(),
      promptVersion: PIPELINE_VERSION,
    });
  }

  return result;
}
