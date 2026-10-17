create table if not exists learned_scopes (
  id uuid primary key default gen_random_uuid(),
  declared_client text not null unique,
  scope jsonb not null,
  learned_at timestamptz not null default now()
);
