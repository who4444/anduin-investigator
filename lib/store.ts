import { createHash } from "node:crypto";
import type { JSONValue } from "postgres";

import { getPool } from "./db/pool";
import { toUtcIso } from "./ingest/normalize";
import { normalizePlanData } from "./pipeline/plan";
import type {
  Claim,
  ClaimChecks,
  ClaimInput,
  ClaimStatus,
  Event,
  EventInput,
  Gap,
  GapInput,
  IdentityResolution,
  IdentityResolutionInput,
  Investigation,
  InvestigationScope,
  NewInvestigation,
  PlanData,
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
  };
}

interface GapRow {
  id: string;
  investigation_id: string;
  question: string;
  note: string;
  event_ids: string[] | null;
}

function mapGap(row: GapRow): Gap {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    question: row.question,
    note: row.note,
    eventIds: row.event_ids ?? [],
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
    select id, title, escalation_text, status, content_hash, plan, created_at, scope, declared_client, plan_data, ingest_warnings, origin
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

export async function setPlanData(id: string, data: PlanData | null): Promise<void> {
  const sql = getPool();
  await sql`update investigations set plan_data = ${data ? sql.json(data as unknown as JSONValue) : null} where id = ${id}`;
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
    select id, title, escalation_text, status, content_hash, plan, created_at, scope, declared_client, plan_data, ingest_warnings, origin
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
  }));
  const inserted = await sql<ClaimRow[]>`
    insert into claims ${sql(rows, ...CLAIM_COLUMNS)}
    on conflict (investigation_id, dedupe_key) do nothing
    returning id, investigation_id, agent, type, text, actor, quote, event_id, ts, status, confidence, verify_status, verify_error, verify_checks, skeptic_flag
  `;
  return inserted.map(mapClaim);
}

export async function getClaims(investigationId: string): Promise<Claim[]> {
  const sql = getPool();
  const rows = await sql<ClaimRow[]>`
    select id, investigation_id, agent, type, text, actor, quote, event_id, ts, status, confidence, verify_status, verify_error, verify_checks, skeptic_flag
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
  const existing = await sql<{ question: string; note: string }[]>`
    select question, note from gaps where investigation_id = ${investigationId}
  `;
  const seen = new Set(existing.map((row) => `${row.question}|${row.note}`));
  const fresh = gaps.filter((gap) => !seen.has(`${gap.question}|${gap.note}`));
  if (fresh.length === 0) {
    return;
  }
  const rows = fresh.map((gap) => ({
    investigation_id: investigationId,
    question: gap.question,
    note: gap.note,
    event_ids: sql.array(gap.eventIds, 25),
  }));
  await sql`insert into gaps ${sql(rows, "investigation_id", "question", "note", "event_ids")}`;
}

export async function setIngestWarnings(id: string, warnings: string[]): Promise<void> {
  const sql = getPool();
  await sql`update investigations set ingest_warnings = ${sql.json(warnings as unknown as JSONValue)} where id = ${id}`;
}

const STAGE_LEASE_SECONDS = 180;
const STALE_RUNNING_SECONDS = 180;

export async function acquireStageLease(
  investigationId: string,
  ttlSeconds = STAGE_LEASE_SECONDS,
): Promise<boolean> {
  const sql = getPool();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const rows = await sql<{ id: string }[]>`
    update investigations
    set lease = ${sql.json({ expiresAt } as unknown as JSONValue)}
    where id = ${investigationId}
      and (
        lease is null
        or (lease ->> 'expiresAt')::timestamptz < now()
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
    select id, investigation_id, question, note, event_ids
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

export interface ReplySentence {
  text: string;
  claimIds: string[];
}

export interface ReportExtras {
  verdict: string | null;
  reply: { sentences: ReplySentence[] } | null;
}

export async function upsertReportExtras(
  investigationId: string,
  extras: { verdict: string; reply: { sentences: ReplySentence[] } },
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
  const rows = await sql<{ verdict: string | null; reply: { sentences?: ReplySentence[] } | null }[]>`
    select verdict, reply from report_extras where investigation_id = ${investigationId} limit 1
  `;
  if (rows.length === 0) return null;
  const reply = rows[0].reply;
  return {
    verdict: rows[0].verdict,
    reply:
      reply && Array.isArray(reply.sentences)
        ? { sentences: reply.sentences.filter((s) => typeof s?.text === "string") }
        : null,
  };
}
