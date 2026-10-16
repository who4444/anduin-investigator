alter table claims
  add column if not exists verify_checks jsonb not null default '{}'::jsonb;
