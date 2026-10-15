create table if not exists investigations (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  escalation_text text not null default '',
  status text not null default 'created',
  content_hash text not null,
  plan text,
  created_at timestamptz not null default now()
);

create index if not exists investigations_content_hash_idx on investigations (content_hash);

create table if not exists events (
  investigation_id uuid not null references investigations (id) on delete cascade,
  id text not null,
  source text not null,
  ts timestamptz not null,
  actor text not null,
  channel text not null,
  text text not null,
  url text,
  thread_id text,
  refs text[] not null default '{}',
  meta jsonb not null default '{}'::jsonb,
  actor_resolved text,
  primary key (investigation_id, id)
);

create index if not exists events_investigation_ts_idx on events (investigation_id, ts);

create table if not exists claims (
  seq bigserial primary key,
  id uuid not null unique default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  agent text not null,
  type text not null,
  text text not null,
  actor text,
  quote text not null,
  event_id text not null,
  ts timestamptz,
  status text not null,
  confidence real not null default 0,
  verify_status text not null default 'unverified',
  verify_error text,
  skeptic_flag boolean not null default false
);

create index if not exists claims_investigation_seq_idx on claims (investigation_id, seq);

create table if not exists skeptic_notes (
  seq bigserial primary key,
  id uuid not null unique default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  claim_id uuid references claims (id) on delete set null,
  kind text not null,
  text text not null,
  event_ids text[] not null default '{}'
);

create table if not exists gaps (
  seq bigserial primary key,
  id uuid not null unique default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  question text not null,
  note text not null,
  event_ids text[] not null default '{}'
);

create table if not exists stages (
  investigation_id uuid not null references investigations (id) on delete cascade,
  stage text not null,
  "pass" integer not null,
  status text not null default 'pending',
  error text,
  log jsonb not null default '[]'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  primary key (investigation_id, stage, "pass")
);

create table if not exists identity_resolutions (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  alias text not null,
  canonical text not null,
  method text not null,
  confidence real not null default 0,
  applied boolean not null default false,
  unique (investigation_id, alias)
);
