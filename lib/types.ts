export type SourceKind = "jira" | "email" | "slack";

export type StageName =
  | "ingest"
  | "plan"
  | "root_cause"
  | "commitments"
  | "ownership"
  | "skeptic"
  | "verify"
  | "assemble";

export type StageStatus = "pending" | "running" | "done" | "error";

export type ClaimStatus = "kept" | "broken" | "unclear" | "n/a";

export type VerifyStatus = "kept" | "excluded" | "unverified";

export type SkepticNoteKind = "contradiction" | "unsupported" | "silence" | "unanswered";

export interface EventInput {
  source: SourceKind;
  ts: string;
  actor: string;
  channel: string;
  text: string;
  url?: string;
  threadId?: string;
  refs?: string[];
  meta?: Record<string, unknown>;
}

export interface Event extends EventInput {
  id: string;
  investigationId: string;
  actorResolved?: string | null;
}

export interface ClaimInput {
  agent: string;
  type: string;
  text: string;
  actor?: string;
  quote: string;
  eventId: string;
  ts?: string;
  status: ClaimStatus;
  confidence: number;
}

export interface Claim extends ClaimInput {
  id: string;
  investigationId: string;
  verifyStatus: VerifyStatus;
  verifyError?: string | null;
  skepticFlag: boolean;
}

export interface Investigation {
  id: string;
  title: string;
  escalationText: string;
  status: string;
  contentHash: string;
  plan: string | null;
  createdAt: string;
}

export interface Stage {
  stage: StageName;
  pass: number;
  status: StageStatus;
  error?: string | null;
  log: unknown[];
  startedAt?: string | null;
  finishedAt?: string | null;
}

export interface IdentityResolution {
  id: string;
  investigationId: string;
  alias: string;
  canonical: string;
  method: string;
  confidence: number;
  applied: boolean;
}

export interface IdentityResolutionInput {
  alias: string;
  canonical: string;
  method: string;
  confidence: number;
  applied: boolean;
}

export interface SkepticNoteInput {
  claimId?: string;
  kind: SkepticNoteKind;
  text: string;
  eventIds: string[];
}

export interface GapInput {
  question: string;
  note: string;
  eventIds: string[];
}

export interface NewInvestigation {
  title: string;
  escalationText: string;
  contentHash: string;
}
