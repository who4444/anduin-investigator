-- G-23: an escalation can contain up to three independent issues. The
-- investigation stays the case (one evidence registry, one coverage report);
-- issues are the analysis units that claims, gaps and replies hang from.
create table if not exists issues (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  seq integer not null,
  title text not null,
  ask text not null default '',
  summary text not null default '',
  confidence real not null default 0.5,
  confirmed boolean not null default false,
  created_at timestamptz not null default now(),
  unique (investigation_id, seq)
);

create index if not exists issues_investigation_idx on issues (investigation_id, seq);

alter table claims add column if not exists issue_id uuid references issues (id) on delete set null;
alter table gaps add column if not exists issue_id uuid references issues (id) on delete set null;

create index if not exists claims_issue_idx on claims (investigation_id, issue_id);
create index if not exists gaps_issue_idx on gaps (investigation_id, issue_id);

-- A reply/verdict is per issue. Legacy single-issue rows stay in report_extras
-- so existing investigations keep working.
create table if not exists issue_report_extras (
  issue_id uuid primary key references issues (id) on delete cascade,
  investigation_id uuid not null references investigations (id) on delete cascade,
  verdict text,
  reply jsonb,
  created_at timestamptz not null default now()
);
