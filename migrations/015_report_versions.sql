-- G-08: each assembled report freezes the top answer with the run parameters
-- that produced it. The report page reads the latest version for the selected
-- issue (or the case-level row when no issue is selected); drafting a reply
-- never mutates it.
create table if not exists report_versions (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations(id) on delete cascade,
  issue_id uuid references issues(id) on delete set null,
  version integer not null,
  narrative text not null,
  stats jsonb not null default '{}'::jsonb,
  model text,
  prompt_version text,
  created_at timestamptz not null default now()
);

create unique index if not exists report_versions_scope_version_idx
  on report_versions (investigation_id, coalesce(issue_id, '00000000-0000-0000-0000-000000000000'::uuid), version);

create index if not exists report_versions_latest_idx
  on report_versions (investigation_id, issue_id, created_at desc);
