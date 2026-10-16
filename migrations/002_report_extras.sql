create table if not exists report_extras (
  investigation_id uuid primary key references investigations(id) on delete cascade,
  verdict text,
  reply jsonb,
  created_at timestamptz not null default now()
);
