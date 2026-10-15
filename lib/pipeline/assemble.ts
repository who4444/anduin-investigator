import {
  appendStageLog,
  getClaims,
  getEvents,
  getGaps,
  getIdentities,
  getInvestigation,
  getSkepticNotes,
  getStages,
} from "../store";
import type { Claim, Event, Gap, Investigation, SkepticNote, Stage } from "../types";
import type { InvestigatorKind } from "../agents/investigator";
import { buildCoverage, type CoverageReport } from "./coverage";

const INVESTIGATOR_KINDS: InvestigatorKind[] = ["root_cause", "commitments", "ownership"];
const LEDGER_TYPES = new Set(["commitment", "decision"]);
const MAX_RETRY_PASS = 3;

export interface AssembledStats {
  total: number;
  kept: number;
  excluded: number;
  flagged: number;
}

export interface AssembledResult {
  investigation: Investigation;
  timeline: Event[];
  ledger: Claim[];
  claims: Claim[];
  gaps: Gap[];
  skepticNotes: SkepticNote[];
  coverage: CoverageReport;
  stats: AssembledStats;
  identities: AssembledIdentity[];
  stages: Stage[];
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

export async function buildResult(investigationId: string): Promise<AssembleOutcome> {
  const investigation = await getInvestigation(investigationId);
  if (!investigation) {
    throw new Error(`No investigation with id ${investigationId}.`);
  }

  const [events, claims, gaps, skepticNotes, identities, stages] = await Promise.all([
    getEvents(investigationId),
    getClaims(investigationId),
    getGaps(investigationId),
    getSkepticNotes(investigationId),
    getIdentities(investigationId),
    getStages(investigationId),
  ]);

  const timeline = events.map(coalesceActor);
  const visibleClaims = claims.filter((claim) => claim.verifyStatus !== "excluded");

  const ledger = visibleClaims
    .filter((claim) => LEDGER_TYPES.has(claim.type))
    .sort((a, b) => {
      const left = a.ts ?? "";
      const right = b.ts ?? "";
      return left < right ? -1 : left > right ? 1 : 0;
    });

  const stats: AssembledStats = {
    total: claims.length,
    kept: claims.filter((claim) => claim.verifyStatus === "kept").length,
    excluded: claims.filter((claim) => claim.verifyStatus === "excluded").length,
    flagged: claims.filter((claim) => claim.skepticFlag).length,
  };

  const missing = INVESTIGATOR_KINDS.filter((kind) => {
    const kindClaims = claims.filter((claim) => claim.agent === kind);
    return !kindClaims.some((claim) => claim.verifyStatus === "kept");
  });

  const pass = currentPass(stages);
  const needsRetry = missing.length > 0 && pass < MAX_RETRY_PASS;
  const coverage = buildCoverage(events, stages);

  return {
    investigation,
    timeline,
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
  });

  return result;
}
