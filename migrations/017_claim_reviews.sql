-- G-14: the manager's corrections — mark a claim wrong, unsupported or out
-- of scope with a reason. One review per claim (latest wins); reviewed
-- claims leave the findings, the client pack and the draft, and the review
-- is recorded in the frozen report version's stats.
create table if not exists claim_reviews (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid not null references investigations (id) on delete cascade,
  claim_id uuid not null references claims (id) on delete cascade,
  verdict text not null,
  reason text,
  created_at timestamptz not null default now(),
  unique (claim_id)
);

create index if not exists claim_reviews_investigation_idx on claim_reviews (investigation_id);
