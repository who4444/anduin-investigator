import { createHash } from "node:crypto";
import type { JSONValue } from "postgres";

import { getPool } from "./db/pool";
import { toUtcIso } from "./ingest/normalize";
import { mergeStatuses } from "./pipeline/commitments";
import { normalizePlanData } from "./pipeline/plan";
import type {
  Claim,
  ClaimChecks,
  ClaimInput,
  ClaimReview,
  ClaimReviewVerdict,
  ClaimStatus,
  Commitment,
  CommitmentInput,
  CommitmentStatus,
  Event,
  EventInput,
  Gap,
  GapInput,
  IdentityResolution,
  IdentityResolutionInput,
  Investigation,
  InvestigationScope,
  Issue,
  IssueInput,
  NewInvestigation,
  PlanData,
  ReplyPayload,
  ReplySentence,
  ScopeAnchor,
  SkepticNote,
  SkepticNoteInput,
  SkepticNoteKind,
  SourceKind,
  Stage,
  StageName,
  StageStatus,
  VerifyStatus,
} from "./types";

type IsoValue = Date | string | null | undefined;

function toIso(value: IsoValue): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

interface InvestigationRow {
  id: string;
  title: string;
  escalation_text: string;
  status: string;
  content_hash: string;
  plan: string | null;
  created_at: Date | string;
  scope: unknown;
  declared_client: string | null;
  plan_data: unknown;
  ingest_warnings: unknown;
  origin: string | null;
  scope_overrides: unknown;
  scope_reviewed_at: Date | string | null;
}

function mapScope(value: unknown): InvestigationScope | null {
  if (typeof value !== "object" || value === null) return null;
  const scope = value as Partial<InvestigationScope>;
  const strings = (list: unknown): string[] =>
    Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
  // Missing confidence (pre-tier rows) means a verified-anchors scope;
  // a present-but-unreadable value is corruption: fail OPEN to unfiltered.
  const confidence =
    scope.confidence === "partial" || scope.confidence === "none"
      ? scope.confidence
      : scope.confidence === "scoped"
        ? "scoped"
        : scope.confidence === undefined || scope.confidence === null
          ? "scoped"
          : "none";
  return {
    client: typeof scope.client === "string" ? scope.client : null,
    project: typeof scope.project === "string" ? scope.project : null,
    ticketPrefixes: strings(scope.ticketPrefixes),
    channels: strings(scope.channels),
    senderDomains: strings(scope.senderDomains),
    confidence,
    anchors: Array.isArray(scope.anchors)
      ? scope.anchors.filter(
          (anchor): anchor is ScopeAnchor =>
            typeof anchor === "object" &&
            anchor !== null &&
            typeof (anchor as ScopeAnchor).kind === "string" &&
            typeof (anchor as ScopeAnchor).value === "string" &&
            typeof (anchor as ScopeAnchor).source === "string",
        )
      : [],
  };
}

function mapInvestigation(row: InvestigationRow): Investigation {
  return {
    id: row.id,
    title: row.title,
    escalationText: row.escalation_text,
    status: row.status,
    contentHash: row.content_hash,
    plan: row.plan,
    createdAt: toIso(row.created_at) as string,
    scope: mapScope(row.scope),
    declaredClient: row.declared_client ?? null,
    planData: normalizePlanData(row.plan_data),
    ingestWarnings: Array.isArray(row.ingest_warnings)
      ? (row.ingest_warnings as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
    origin: row.origin ?? "upload",
    scopeOverrides: Array.isArray(row.scope_overrides)
      ? (row.scope_overrides as unknown[]).filter((entry): entry is string => typeof entry === "string")
      : [],
    scopeReviewedAt: row.scope_reviewed_at ? (toIso(row.scope_reviewed_at) as string) : null,
  };
}

interface IssueRow {
  id: string;
  investigation_id: string;
  seq: number;
  title: string;
  ask: string;
  summary: string;
  confidence: number;
  confirmed: boolean;
  created_at: Date | string;
}

function mapIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    seq: row.seq,
    title: row.title,
    ask: row.ask,
    summary: row.summary,
    confidence: row.confidence,
    confirmed: row.confirmed,
    createdAt: toIso(row.created_at) as string,
  };
}

interface EventRow {
  investigation_id: string;
  id: string;
  source: string;
  ts: Date | string;
  actor: string;
  channel: string;
  text: string;
  url: string | null;
  thread_id: string | null;
  refs: string[] | null;
  meta: Record<string, unknown> | null;
  actor_resolved: string | null;
}

function mapEvent(row: EventRow): Event {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    source: row.source as SourceKind,
    ts: toIso(row.ts) as string,
    actor: row.actor,
    channel: row.channel,
    text: row.text,
    url: row.url ?? undefined,
    threadId: row.thread_id ?? undefined,
    refs: row.refs ?? [],
    meta: row.meta ?? {},
    actorResolved: row.actor_resolved,
  };
}

interface ClaimRow {
  id: string;
  investigation_id: string;
  agent: string;
  type: string;
  text: string;
  actor: string | null;
  quote: string;
  event_id: string;
  ts: Date | string | null;
  status: string;
  confidence: number;
  verify_status: string;
  verify_error: string | null;
  verify_checks: Record<string, unknown> | null;
  skeptic_flag: boolean;
  issue_id: string | null;
}

function mapVerifyStatus(raw: string): VerifyStatus {
  if (raw === "kept") return "verified";
  if (raw === "excluded") return "rejected";
  return raw as VerifyStatus;
}

function mapClaim(row: ClaimRow): Claim {
  const checks =
    row.verify_checks && Object.keys(row.verify_checks).length > 0
      ? (row.verify_checks as unknown as ClaimChecks)
      : undefined;
  return {
    id: row.id,
    investigationId: row.investigation_id,
    agent: row.agent,
    type: row.type,
    text: row.text,
    actor: row.actor ?? undefined,
    quote: row.quote,
    eventId: row.event_id,
    ts: toIso(row.ts) ?? undefined,
    status: row.status as ClaimStatus,
    confidence: row.confidence,
    verifyStatus: mapVerifyStatus(row.verify_status),
    verifyError: row.verify_error,
    checks,
    skepticFlag: row.skeptic_flag,
    issueId: row.issue_id ?? null,
  };
}

interface GapRow {
  id: string;
  investigation_id: string;
  question: string;
  note: string;
  event_ids: string[] | null;
  issue_id: string | null;
}

function mapGap(row: GapRow): Gap {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    question: row.question,
    note: row.note,
    eventIds: row.event_ids ?? [],
    issueId: row.issue_id ?? null,
  };
}

interface SkepticNoteRow {
  id: string;
  investigation_id: string;
  claim_id: string | null;
  kind: string;
  text: string;
  event_ids: string[] | null;
}

function mapSkepticNote(row: SkepticNoteRow): SkepticNote {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    claimId: row.claim_id ?? undefined,
    kind: row.kind as SkepticNoteKind,
    text: row.text,
    eventIds: row.event_ids ?? [],
  };
}

interface StageRow {  stage: string;
  pass: number;
  status: string;
  error: string | null;
  log: unknown[];
  started_at: Date | string | null;
  finished_at: Date | string | null;
}

function mapStage(row: StageRow): Stage {
  return {
    stage: row.stage as StageName,
    pass: row.pass,
    status: row.status as StageStatus,
    error: row.error,
    log: row.log ?? [],
    startedAt: toIso(row.started_at),
    finishedAt: toIso(row.finished_at),
  };
}

interface IdentityRow {
  id: string;
  investigation_id: string;
  alias: string;
  canonical: string;
  method: string;
  confidence: number;
  applied: boolean;
}

function mapIdentity(row: IdentityRow): IdentityResolution {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    alias: row.alias,
    canonical: row.canonical,
    method: row.method,
    confidence: row.confidence,
    applied: row.applied,
  };
}

const EVENT_COLUMNS = [
  "investigation_id",
  "id",
  "source",
  "ts",
  "actor",
  "channel",
  "text",
  "url",
  "thread_id",
  "refs",
  "meta",
] as const;

const CLAIM_COLUMNS = [
  "investigation_id",
  "agent",
  "type",
  "text",
  "actor",
  "quote",
  "event_id",
  "ts",
  "status",
  "confidence",
  "dedupe_key",
  "issue_id",
] as const;

/* Must match the migration's key: md5(event_id || '|' || btrim(lower(regexp_replace(text, '\s+', ' ', 'g')))) */
export function claimDedupeKey(eventId: string, text: string): string {
  return createHash("md5")
    .update(`${eventId}|${text.toLowerCase().replace(/\s+/g, " ").trim()}`)
    .digest("hex");
}

export async function createInvestigation(input: NewInvestigation): Promise<string> {
  const sql = getPool();
  try {
    const rows = await sql<{ id: string }[]>`
      insert into investigations (title, escalation_text, content_hash, declared_client, origin)
      values (${input.title}, ${input.escalationText}, ${input.contentHash}, ${input.declaredClient ?? null}, ${input.origin ?? "upload"})
      returning id
    `;
    return rows[0].id;
  } catch (error) {
    // A racing duplicate upload must land on the same investigation, not a
    // second row with the same cache key.
    if (!/duplicate key value/i.test(String(error))) throw error;
    const existing = await findInvestigationByHash(input.contentHash);
    if (!existing) throw error;
    return existing.id;
  }
}

export async function getInvestigation(id: string): Promise<Investigation | null> {
  const sql = getPool();
  const rows = await sql<InvestigationRow[]>`
    select id, title, escalation_text, status, content_hash, plan, created_at, scope, declared_client, plan_data, ingest_warnings, origin, scope_overrides, scope_reviewed_at
    from investigations
    where id = ${id}
    limit 1
  `;
  return rows.length ? mapInvestigation(rows[0]) : null;
}

export async function setScope(id: string, scope: InvestigationScope | null): Promise<void> {
  const sql = getPool();
  await sql`update investigations set scope = ${scope ? sql.json(scope as unknown as JSONValue) : null} where id = ${id}`;
}

/* G-01 review: records the manager added back from the excluded list. The
   route validates ids against the registry before this is called. */
export async function setScopeOverrides(id: string, eventIds: string[]): Promise<void> {
  const sql = getPool();
  await sql`update investigations set scope_overrides = ${sql.json(eventIds as unknown as JSONValue)}, scope_reviewed_at = now() where id = ${id}`;
}

/* G-05: commitments keyed by promisor+promisee+object+deadline. A restatement
   from another source merges into the same row; contested outcomes keep the
   failing reading and record the disagreement. */
interface CommitmentRow {
  id: string;
  investigation_id: string;
  claim_id: string;
  issue_id: string | null;
  promisor: string | null;
  promisee: string | null;
  object: string;
  conditions: string | null;
  deadline_phrase: string | null;
  deadline_iso: Date | string | null;
  rationale: string | null;
  status: string;
  contested: boolean;
  fulfilment_event_ids: unknown;
  source_event_ids: unknown;
  dedupe_key: string;
  created_at: Date | string;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function mapCommitment(row: CommitmentRow): Commitment {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    claimId: row.claim_id,
    issueId: row.issue_id ?? null,
    promisor: row.promisor ?? null,
    promisee: row.promisee ?? null,
    object: row.object,
    conditions: row.conditions ?? null,
    deadlinePhrase: row.deadline_phrase ?? null,
    deadlineIso: row.deadline_iso ? toIso(row.deadline_iso) : null,
    rationale: row.rationale ?? null,
    status: row.status as CommitmentStatus,
    contested: row.contested,
    fulfilmentEventIds: stringList(row.fulfilment_event_ids),
    sourceEventIds: stringList(row.source_event_ids),
    dedupeKey: row.dedupe_key,
    createdAt: toIso(row.created_at) as string,
  };
}

/* G-14: manager reviews — one verdict per claim, latest wins. Reviewed
   claims leave the findings, the client pack and the draft. */
interface ClaimReviewRow {
  claim_id: string;
  verdict: string;
  reason: string | null;
  created_at: Date | string;
}

function mapClaimReview(row: ClaimReviewRow): ClaimReview {
  return {
    claimId: row.claim_id,
    verdict: row.verdict as ClaimReviewVerdict,
    reason: row.reason ?? null,
    createdAt: toIso(row.created_at) as string,
  };
}

export async function getClaimReviews(investigationId: string): Promise<ClaimReview[]> {
  const sql = getPool();
  const rows = await sql<ClaimReviewRow[]>`
    select claim_id, verdict, reason, created_at
    from claim_reviews where investigation_id = ${investigationId}
  `;
  return rows.map(mapClaimReview);
}

export async function upsertClaimReview(
  investigationId: string,
  claimId: string,
  verdict: ClaimReviewVerdict,
  reason: string | null,
): Promise<ClaimReview> {
  const sql = getPool();
  const [claim] = await sql<{ id: string }[]>`
    select id from claims where id = ${claimId} and investigation_id = ${investigationId} limit 1
  `;
  if (!claim) throw new Error("No claim with that id belongs to this investigation.");
  const [row] = await sql<ClaimReviewRow[]>`
    insert into claim_reviews (investigation_id, claim_id, verdict, reason)
    values (${investigationId}, ${claimId}, ${verdict}, ${reason})
    on conflict (claim_id) do update set
      verdict = excluded.verdict, reason = excluded.reason, created_at = now()
    returning claim_id, verdict, reason, created_at
  `;
  return mapClaimReview(row);
}

export async function clearClaimReview(investigationId: string, claimId: string): Promise<void> {
  const sql = getPool();
  await sql`delete from claim_reviews where investigation_id = ${investigationId} and claim_id = ${claimId}`;
}

export async function getCommitments(investigationId: string): Promise<Commitment[]> {
  const sql = getPool();
  const rows = await sql<CommitmentRow[]>`
    select * from commitments where investigation_id = ${investigationId} order by created_at, id
  `;
  return rows.map(mapCommitment);
}

export async function mergeCommitment(
  investigationId: string,
  record: CommitmentInput & {
    status: CommitmentStatus;
    dedupeKey: string;
    sourceEventId: string;
  },
): Promise<Commitment> {
  const sql = getPool();
  const [exactRow] = await sql<CommitmentRow[]>`
    select * from commitments
    where investigation_id = ${investigationId} and dedupe_key = ${record.dedupeKey}
    limit 1
  `;
  // Restatements rarely phrase the object the same way ("ship the VAT export
  // fix in the Sep 20 release" vs "fix scheduled for the Sep 20 release").
  // Same promisor + deadline + issue is the same promise in practice; merge it
  // rather than showing the manager two rows for one commitment.
  const [fuzzyRow] = exactRow
    ? [null]
    : await sql<CommitmentRow[]>`
        select * from commitments
        where investigation_id = ${investigationId}
          and lower(coalesce(promisor, '')) = lower(${record.promisor ?? ""})
          and deadline_iso is not distinct from ${record.deadlineIso}::timestamptz
          and issue_id is not distinct from ${record.issueId ?? null}::uuid
        order by created_at asc
        limit 1
      `;
  const existingRow = exactRow ?? fuzzyRow;

  if (existingRow) {
    const existing = mapCommitment(existingRow);
    const merged = mergeStatuses([existing.status, record.status], record.rationale ?? existing.rationale);
    const sourceEventIds = [...new Set([...existing.sourceEventIds, record.sourceEventId])];
    const fulfilmentEventIds = [
      ...new Set([...existing.fulfilmentEventIds, ...record.fulfilmentEventIds]),
    ];
    const [updated] = await sql<CommitmentRow[]>`
      update commitments set
        status = ${merged.status},
        contested = ${merged.contested},
        rationale = ${merged.rationale},
        source_event_ids = ${sql.json(sourceEventIds as unknown as JSONValue)},
        fulfilment_event_ids = ${sql.json(fulfilmentEventIds as unknown as JSONValue)}
      where id = ${existing.id}
      returning *
    `;
    return mapCommitment(updated);
  }

  const [inserted] = await sql<CommitmentRow[]>`
    insert into commitments (
      investigation_id, claim_id, issue_id, promisor, promisee, object, conditions,
      deadline_phrase, deadline_iso, rationale, status, contested,
      fulfilment_event_ids, source_event_ids, dedupe_key
    )
    values (
      ${investigationId}, ${record.claimId}, ${record.issueId ?? null}, ${record.promisor},
      ${record.promisee}, ${record.object}, ${record.conditions}, ${record.deadlinePhrase},
      ${record.deadlineIso}, ${record.rationale}, ${record.status}, false,
      ${sql.json(record.fulfilmentEventIds as unknown as JSONValue)},
      ${sql.json([record.sourceEventId] as unknown as JSONValue)}, ${record.dedupeKey}
    )
    on conflict (investigation_id, dedupe_key) do nothing
    returning *
  `;
  if (inserted) return mapCommitment(inserted);

  // Lost a race against a concurrent submission: merge with the winner.
  return mergeCommitment(investigationId, record);
}

export async function setPlanData(id: string, data: PlanData | null): Promise<void> {
  const sql = getPool();
  await sql`update investigations set plan_data = ${data ? sql.json(data as unknown as JSONValue) : null} where id = ${id}`;
}

/* G-23: the plan stage proposes up to three issues. They are replaced as a
   unit before any claim exists; a single issue is auto-confirmed, multiple
   issues wait for the manager's pre-run review. */
export async function savePlanIssues(
  investigationId: string,
  inputs: IssueInput[],
): Promise<Issue[]> {
  const sql = getPool();
  const confirmed = inputs.length <= 1;
  const rows = await sql.begin(async (tx) => {
    await tx`delete from issues where investigation_id = ${investigationId}`;
    const inserted: IssueRow[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const result = await tx<IssueRow[]>`
        insert into issues (investigation_id, seq, title, ask, summary, confidence, confirmed)
        values (
          ${investigationId},
          ${index + 1},
          ${input.title},
          ${input.ask ?? ""},
          ${input.summary ?? ""},
          ${Math.min(1, Math.max(0, input.confidence))},
          ${confirmed}
        )
        returning id, investigation_id, seq, title, ask, summary, confidence, confirmed, created_at
      `;
      if (result[0]) inserted.push(result[0]);
    }
    return inserted;
  });
  return rows.map(mapIssue);
}

export async function confirmIssues(
  investigationId: string,
  inputs: IssueInput[],
): Promise<Issue[]> {
  const sql = getPool();
  const rows = await sql.begin(async (tx) => {
    await tx`delete from issues where investigation_id = ${investigationId}`;
    const inserted: IssueRow[] = [];
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs[index];
      const result = await tx<IssueRow[]>`
        insert into issues (investigation_id, seq, title, ask, summary, confidence, confirmed)
        values (
          ${investigationId},
          ${index + 1},
          ${input.title},
          ${input.ask ?? ""},
          ${input.summary ?? ""},
          ${Math.min(1, Math.max(0, input.confidence))},
          true
        )
        returning id, investigation_id, seq, title, ask, summary, confidence, confirmed, created_at
      `;
      if (result[0]) inserted.push(result[0]);
    }
    return inserted;
  });
  return rows.map(mapIssue);
}

export async function getIssues(investigationId: string): Promise<Issue[]> {
  const sql = getPool();
  const rows = await sql<IssueRow[]>`
    select id, investigation_id, seq, title, ask, summary, confidence, confirmed, created_at
    from issues
    where investigation_id = ${investigationId}
    order by seq asc
  `;
  return rows.map(mapIssue);
}

export async function getIssue(investigationId: string, issueId: string): Promise<Issue | null> {
  const sql = getPool();
  const rows = await sql<IssueRow[]>`
    select id, investigation_id, seq, title, ask, summary, confidence, confirmed, created_at
    from issues
    where investigation_id = ${investigationId} and id = ${issueId}
    limit 1
  `;
  return rows.length ? mapIssue(rows[0]) : null;
}

export async function upsertLearnedScope(declaredClient: string, scope: InvestigationScope): Promise<void> {
  const sql = getPool();
  const normalized = declaredClient.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return;
  await sql`
    insert into learned_scopes (declared_client, scope)
    values (${normalized}, ${sql.json(scope as unknown as JSONValue)})
    on conflict (declared_client) do update set
      scope = excluded.scope,
      learned_at = now()
  `;
}

export async function getLearnedScope(declaredClient: string | null | undefined): Promise<InvestigationScope | null> {
  const sql = getPool();
  const normalized = declaredClient?.replace(/\s+/g, " ").trim().toLowerCase();
  if (!normalized) return null;
  const rows = await sql<{ scope: unknown }[]>`
    select scope from learned_scopes where declared_client = ${normalized} limit 1
  `;
  return rows.length ? mapScope(rows[0].scope) : null;
}

export interface InvestigationSummary {
  id: string;
  title: string;
  createdAt: string;
  origin: string;
  complete: boolean;
}

export async function listInvestigations(limit = 20): Promise<InvestigationSummary[]> {
  const sql = getPool();
  const rows = await sql<{
    id: string;
    title: string;
    created_at: Date | string;
    origin: string | null;
    done: boolean;
  }[]>`
    select i.id, i.title, i.created_at, i.origin,
      exists (
        select 1 from stages s
        where s.investigation_id = i.id and s.stage = 'assemble' and s.status = 'done'
      ) as done
    from investigations i
    order by i.created_at desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    createdAt: toIso(row.created_at) as string,
    origin: row.origin ?? "upload",
    complete: row.done,
  }));
}

export async function findInvestigationByHash(hash: string): Promise<Investigation | null> {
  const sql = getPool();
  const rows = await sql<InvestigationRow[]>`
    select id, title, escalation_text, status, content_hash, plan, created_at, scope, declared_client, plan_data, ingest_warnings, origin, scope_overrides, scope_reviewed_at
    from investigations
    where content_hash = ${hash}
    order by created_at desc
    limit 1
  `;
  return rows.length ? mapInvestigation(rows[0]) : null;
}

export async function setPlan(id: string, plan: string): Promise<void> {
  const sql = getPool();
  await sql`update investigations set plan = ${plan} where id = ${id}`;
}

export async function deleteInvestigation(id: string): Promise<void> {
  const sql = getPool();
  await sql`delete from investigations where id = ${id}`;
}

export async function insertEvents(
  investigationId: string,
  events: (EventInput & { id: string })[],
): Promise<void> {
  if (events.length === 0) {
    return;
  }
  const sql = getPool();
  const rows = events.map((event) => ({
    investigation_id: investigationId,
    id: event.id,
    source: event.source,
    ts: event.ts,
    actor: event.actor,
    channel: event.channel,
    text: event.text,
    url: event.url ?? null,
    thread_id: event.threadId ?? null,
    refs: sql.array(event.refs ?? [], 25),
    meta: sql.json((event.meta ?? {}) as JSONValue),
  }));
  await sql`insert into events ${sql(rows, ...EVENT_COLUMNS)}`;
}

export async function getEvents(investigationId: string): Promise<Event[]> {
  const sql = getPool();
  const rows = await sql<EventRow[]>`
    select investigation_id, id, source, ts, actor, channel, text, url, thread_id, refs, meta, actor_resolved
    from events
    where investigation_id = ${investigationId}
    order by ts asc, id asc
  `;
  return rows.map(mapEvent);
}

export async function getEvent(investigationId: string, eventId: string): Promise<Event | null> {
  const sql = getPool();
  const rows = await sql<EventRow[]>`
    select investigation_id, id, source, ts, actor, channel, text, url, thread_id, refs, meta, actor_resolved
    from events
    where investigation_id = ${investigationId} and id = ${eventId}
    limit 1
  `;
  return rows.length ? mapEvent(rows[0]) : null;
}

export async function insertClaims(investigationId: string, claims: ClaimInput[]): Promise<Claim[]> {
  if (claims.length === 0) {
    return [];
  }
  const sql = getPool();
  const rows = claims.map((claim) => ({
    investigation_id: investigationId,
    agent: claim.agent,
    type: claim.type,
    text: claim.text,
    actor: claim.actor ?? null,
    quote: claim.quote,
    event_id: claim.eventId,
    ts: claim.ts ? toUtcIso(claim.ts) || null : null,
    status: claim.status,
    confidence: claim.confidence,
    dedupe_key: claimDedupeKey(claim.eventId, claim.text),
    issue_id: claim.issueId ?? null,
  }));
  const inserted = await sql<ClaimRow[]>`
    insert into claims ${sql(rows, ...CLAIM_COLUMNS)}
    on conflict (investigation_id, dedupe_key) do nothing
    returning id, investigation_id, agent, type, text, actor, quote, event_id, ts, status, confidence, verify_status, verify_error, verify_checks, skeptic_flag, issue_id
  `;
  return inserted.map(mapClaim);
}

export async function getClaims(investigationId: string): Promise<Claim[]> {
  const sql = getPool();
  const rows = await sql<ClaimRow[]>`
    select id, investigation_id, agent, type, text, actor, quote, event_id, ts, status, confidence, verify_status, verify_error, verify_checks, skeptic_flag, issue_id
    from claims
    where investigation_id = ${investigationId}
    order by seq asc
  `;
  return rows.map(mapClaim);
}

export async function setClaimVerification(
  claimId: string,
  verifyStatus: VerifyStatus,
  verifyError?: string | null,
  checks?: ClaimChecks,
): Promise<void> {
  const sql = getPool();
  if (checks === undefined) {
    await sql`
      update claims
      set verify_status = ${verifyStatus}, verify_error = ${verifyError ?? null}
      where id = ${claimId}
    `;
    return;
  }
  await sql`
    update claims
    set verify_status = ${verifyStatus},
        verify_error = ${verifyError ?? null},
        verify_checks = ${sql.json(checks as unknown as JSONValue)}
    where id = ${claimId}
  `;
}

export async function setClaimSkepticFlag(claimId: string, flag: boolean): Promise<void> {
  const sql = getPool();
  await sql`update claims set skeptic_flag = ${flag} where id = ${claimId}`;
}

export async function insertSkepticNotes(
  investigationId: string,
  notes: SkepticNoteInput[],
): Promise<void> {
  if (notes.length === 0) {
    return;
  }
  const sql = getPool();
  const existing = await sql<{ kind: string; claim_id: string | null; text: string }[]>`
    select kind, claim_id, text from skeptic_notes where investigation_id = ${investigationId}
  `;
  const seen = new Set(existing.map((row) => `${row.kind}|${row.claim_id ?? ""}|${row.text}`));
  const fresh = notes.filter((note) => !seen.has(`${note.kind}|${note.claimId ?? ""}|${note.text}`));
  if (fresh.length === 0) {
    return;
  }
  const rows = fresh.map((note) => ({
    investigation_id: investigationId,
    claim_id: note.claimId ?? null,
    kind: note.kind,
    text: note.text,
    event_ids: sql.array(note.eventIds, 25),
  }));
  await sql`insert into skeptic_notes ${sql(rows, "investigation_id", "claim_id", "kind", "text", "event_ids")}`;
}

export async function insertGaps(investigationId: string, gaps: GapInput[]): Promise<void> {
  if (gaps.length === 0) {
    return;
  }
  const sql = getPool();
  const existing = await sql<{ question: string; note: string; issue_id: string | null }[]>`
    select question, note, issue_id from gaps where investigation_id = ${investigationId}
  `;
  const seen = new Set(existing.map((row) => `${row.question}|${row.note}|${row.issue_id ?? ""}`));
  const fresh = gaps.filter(
    (gap) => !seen.has(`${gap.question}|${gap.note}|${gap.issueId ?? ""}`),
  );
  if (fresh.length === 0) {
    return;
  }
  const rows = fresh.map((gap) => ({
    investigation_id: investigationId,
    question: gap.question,
    note: gap.note,
    event_ids: sql.array(gap.eventIds, 25),
    issue_id: gap.issueId ?? null,
  }));
  await sql`insert into gaps ${sql(rows, "investigation_id", "question", "note", "event_ids", "issue_id")}`;
}

export async function setIngestWarnings(id: string, warnings: string[]): Promise<void> {
  const sql = getPool();
  await sql`update investigations set ingest_warnings = ${sql.json(warnings as unknown as JSONValue)} where id = ${id}`;
}

const STAGE_LEASE_SECONDS = 180;
const STALE_RUNNING_SECONDS = 180;

export async function acquireStageLease(
  investigationId: string,
  holder: string,
  ttlSeconds = STAGE_LEASE_SECONDS,
): Promise<boolean> {
  const sql = getPool();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const rows = await sql<{ id: string }[]>`
    update investigations
    set lease = ${sql.json({ holder, expiresAt } as unknown as JSONValue)}
    where id = ${investigationId}
      and (
        lease is null
        or (lease ->> 'expiresAt')::timestamptz < now()
        or lease ->> 'holder' = ${holder}
      )
    returning id
  `;
  return rows.length > 0;
}

export async function clearStageLease(investigationId: string): Promise<void> {
  const sql = getPool();
  await sql`update investigations set lease = null where id = ${investigationId}`;
}

/* A hard-killed function never records done/error; sweep those rows so the
   UI stops showing an eternal spinner, and the reload can retry the stage. */
export async function sweepStaleStages(investigationId: string): Promise<void> {
  const sql = getPool();
  await sql`
    update stages
    set status = 'error',
        error = 'Function was killed mid-run; no completion was recorded.',
        finished_at = now()
    where investigation_id = ${investigationId}
      and status = 'running'
      and started_at is not null
      and started_at < now() - (${STALE_RUNNING_SECONDS} || ' seconds')::interval
  `;
}

export async function getGaps(investigationId: string): Promise<Gap[]> {
  const sql = getPool();
  const rows = await sql<GapRow[]>`
    select id, investigation_id, question, note, event_ids, issue_id
    from gaps
    where investigation_id = ${investigationId}
    order by seq asc
  `;
  return rows.map(mapGap);
}

export async function getSkepticNotes(investigationId: string): Promise<SkepticNote[]> {
  const sql = getPool();
  const rows = await sql<SkepticNoteRow[]>`
    select id, investigation_id, claim_id, kind, text, event_ids
    from skeptic_notes
    where investigation_id = ${investigationId}
    order by seq asc
  `;
  return rows.map(mapSkepticNote);
}

export async function upsertStage(
  investigationId: string,
  stage: StageName,
  pass: number,
  status: StageStatus,
  error?: string | null,
): Promise<void> {
  const sql = getPool();
  await sql`
    insert into stages (investigation_id, stage, "pass", status, error, started_at, finished_at)
    values (
      ${investigationId},
      ${stage},
      ${pass},
      ${status},
      ${error ?? null},
      case when ${status} = 'running' then now() else null end,
      case when ${status} in ('done', 'error') then now() else null end
    )
    on conflict (investigation_id, stage, "pass") do update set
      status = excluded.status,
      error = excluded.error,
      started_at = coalesce(stages.started_at, excluded.started_at),
      finished_at = coalesce(excluded.finished_at, stages.finished_at)
  `;
}

export async function appendStageLog(
  investigationId: string,
  stage: StageName,
  pass: number,
  entry: unknown,
): Promise<void> {
  const sql = getPool();
  await sql`
    insert into stages (investigation_id, stage, "pass", status, log)
    values (${investigationId}, ${stage}, ${pass}, 'pending', ${sql.json([entry] as JSONValue[])})
    on conflict (investigation_id, stage, "pass") do update set
      log = stages.log || excluded.log
  `;
}

export async function getStages(investigationId: string): Promise<Stage[]> {
  await sweepStaleStages(investigationId);
  const sql = getPool();
  const rows = await sql<StageRow[]>`
    select stage, "pass", status, error, log, started_at, finished_at
    from stages
    where investigation_id = ${investigationId}
    order by stage asc, "pass" asc
  `;
  return rows.map(mapStage);
}

export async function upsertIdentity(
  investigationId: string,
  identity: IdentityResolutionInput,
): Promise<void> {
  const sql = getPool();
  await sql`
    insert into identity_resolutions (investigation_id, alias, canonical, method, confidence, applied)
    values (
      ${investigationId},
      ${identity.alias},
      ${identity.canonical},
      ${identity.method},
      ${identity.confidence},
      ${identity.applied}
    )
    on conflict (investigation_id, alias) do update set
      canonical = excluded.canonical,
      method = excluded.method,
      confidence = excluded.confidence,
      applied = excluded.applied
  `;
}

export async function getIdentities(investigationId: string): Promise<IdentityResolution[]> {
  const sql = getPool();
  const rows = await sql<IdentityRow[]>`
    select id, investigation_id, alias, canonical, method, confidence, applied
    from identity_resolutions
    where investigation_id = ${investigationId}
    order by alias asc
  `;
  return rows.map(mapIdentity);
}

export interface ReportExtras {
  verdict: string | null;
  reply: ReplyPayload | null;
}

function mapReplyPayload(value: unknown): ReplyPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const reply = value as {
    greeting?: unknown;
    sentences?: unknown;
    signOff?: unknown;
    approved?: unknown;
  };
  if (!Array.isArray(reply.sentences)) return null;
  const sentences: ReplySentence[] = reply.sentences
    .filter(
      (entry): entry is Record<string, unknown> =>
        typeof entry === "object" && entry !== null && typeof (entry as { text?: unknown }).text === "string",
    )
    .map((entry) => ({
      text: String(entry.text),
      claimIds: Array.isArray(entry.claimIds)
        ? entry.claimIds.filter((id): id is string => typeof id === "string")
        : [],
      label: (entry.label === "needs-check" || entry.label === "do-not-send"
        ? entry.label
        : "safe") as ReplySentence["label"],
    }))
    .filter((sentence) => sentence.claimIds.length > 0);
  if (sentences.length === 0) return null;
  return {
    greeting: typeof reply.greeting === "string" ? reply.greeting : undefined,
    sentences,
    signOff: typeof reply.signOff === "string" ? reply.signOff : undefined,
    approved: reply.approved === true,
  };
}

export async function upsertReportExtras(
  investigationId: string,
  extras: { verdict: string; reply: ReplyPayload },
): Promise<void> {
  const sql = getPool();
  await sql`
    insert into report_extras (investigation_id, verdict, reply)
    values (${investigationId}, ${extras.verdict}, ${sql.json(extras.reply as unknown as JSONValue)})
    on conflict (investigation_id) do update set
      verdict = excluded.verdict,
      reply = excluded.reply
  `;
}

export async function getReportExtras(investigationId: string): Promise<ReportExtras | null> {
  const sql = getPool();
  const rows = await sql<{ verdict: string | null; reply: unknown }[]>`
    select verdict, reply from report_extras where investigation_id = ${investigationId} limit 1
  `;
  if (rows.length === 0) return null;
  return { verdict: rows[0].verdict, reply: mapReplyPayload(rows[0].reply) };
}

export async function upsertIssueReportExtras(
  investigationId: string,
  issueId: string,
  extras: { verdict: string; reply: ReplyPayload },
): Promise<void> {
  const sql = getPool();
  await sql`
    insert into issue_report_extras (issue_id, investigation_id, verdict, reply)
    values (${issueId}, ${investigationId}, ${extras.verdict}, ${sql.json(extras.reply as unknown as JSONValue)})
    on conflict (issue_id) do update set
      verdict = excluded.verdict,
      reply = excluded.reply
  `;
}

export async function getIssueReportExtras(
  investigationId: string,
  issueId: string,
): Promise<ReportExtras | null> {
  const sql = getPool();
  const rows = await sql<{ verdict: string | null; reply: unknown }[]>`
    select verdict, reply from issue_report_extras
    where investigation_id = ${investigationId} and issue_id = ${issueId}
    limit 1
  `;
  if (rows.length === 0) return null;
  return { verdict: rows[0].verdict, reply: mapReplyPayload(rows[0].reply) };
}

export async function setReplyApproved(
  investigationId: string,
  issueId: string | null,
  approved: boolean,
): Promise<boolean> {
  const sql = getPool();
  if (issueId) {
    const rows = await sql<{ id: string }[]>`
      update issue_report_extras
      set reply = coalesce(reply, '{}'::jsonb) || ${sql.json({ approved })}
      where investigation_id = ${investigationId} and issue_id = ${issueId}
      returning issue_id as id
    `;
    return rows.length > 0;
  }
  const rows = await sql<{ id: string }[]>`
    update report_extras
    set reply = coalesce(reply, '{}'::jsonb) || ${sql.json({ approved })}
    where investigation_id = ${investigationId}
    returning investigation_id as id
  `;
  return rows.length > 0;
}

export interface ReportVersion {
  id: string;
  investigationId: string;
  issueId: string | null;
  version: number;
  narrative: string;
  stats: unknown;
  model: string | null;
  promptVersion: string | null;
  createdAt: string;
}

/* G-08: freeze the assembled top answer. The narrative is computed once from
   the claims at assemble time; a later draft cannot rewrite it. */
export async function recordReportVersion(input: {
  investigationId: string;
  issueId: string | null;
  narrative: string;
  stats: unknown;
  model: string | null;
  promptVersion: string;
}): Promise<ReportVersion> {
  const sql = getPool();
  const [latest] = await sql<{ next: number }[]>`
    select coalesce(max(version), 0) + 1 as next
    from report_versions
    where investigation_id = ${input.investigationId}
      and issue_id is not distinct from ${input.issueId ?? null}::uuid
  `;
  const [row] = await sql<{
    id: string;
    investigation_id: string;
    issue_id: string | null;
    version: number;
    narrative: string;
    stats: unknown;
    model: string | null;
    prompt_version: string | null;
    created_at: Date | string;
  }[]>`
    insert into report_versions (
      investigation_id, issue_id, version, narrative, stats, model, prompt_version
    ) values (
      ${input.investigationId}, ${input.issueId ?? null}::uuid, ${latest?.next ?? 1},
      ${input.narrative}, ${sql.json(input.stats as unknown as JSONValue)},
      ${input.model}, ${input.promptVersion}
    )
    returning *
  `;
  return {
    id: row.id,
    investigationId: row.investigation_id,
    issueId: row.issue_id,
    version: row.version,
    narrative: row.narrative,
    stats: row.stats,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: toIso(row.created_at) as string,
  };
}

export async function getLatestReportVersion(
  investigationId: string,
  issueId: string | null = null,
): Promise<ReportVersion | null> {
  const sql = getPool();
  const rows = await sql<{
    id: string;
    investigation_id: string;
    issue_id: string | null;
    version: number;
    narrative: string;
    stats: unknown;
    model: string | null;
    prompt_version: string | null;
    created_at: Date | string;
  }[]>`
    select * from report_versions
    where investigation_id = ${investigationId}
      and issue_id is not distinct from ${issueId ?? null}::uuid
    order by version desc
    limit 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    investigationId: row.investigation_id,
    issueId: row.issue_id,
    version: row.version,
    narrative: row.narrative,
    stats: row.stats,
    model: row.model,
    promptVersion: row.prompt_version,
    createdAt: toIso(row.created_at) as string,
  };
}
