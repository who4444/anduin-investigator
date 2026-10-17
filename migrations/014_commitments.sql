-- G-05: a promise is a first-class entity, not a claim. Each commitment is
-- backed by one verified claim (quote + event); the structured fields let
-- CODE dedupe near-duplicates across sources and apply status rules.
create table if not exists commitments (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  claim_id uuid not null references claims (id) on delete cascade,
  issue_id uuid references issues (id) on delete set null,
  promisor text,
  promisee text,
  object text not null,
  conditions text,
  deadline_phrase text,
  deadline_iso timestamptz,
  rationale text,
  status text not null,
  contested boolean not null default false,
  fulfilment_event_ids jsonb not null default '[]'::jsonb,
  source_event_ids jsonb not null default '[]'::jsonb,
  dedupe_key text not null,
  created_at timestamptz not null default now()
);

create index if not exists commitments_investigation_idx on commitments (investigation_id);
create unique index if not exists commitments_dedupe_idx on commitments (investigation_id, dedupe_key);
