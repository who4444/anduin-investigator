-- One finding is one row: the same cited item plus the same normalized claim
-- text is the same claim no matter which agent, pass, or run produced it.
alter table claims add column if not exists dedupe_key text;

update claims
set dedupe_key = md5(event_id || '|' || btrim(lower(regexp_replace(text, '\s+', ' ', 'g'))))
where dedupe_key is null;

-- drop rows that already collide, keeping the earliest run's row
delete from claims a using claims b
where a.investigation_id = b.investigation_id
  and a.dedupe_key = b.dedupe_key
  and a.seq > b.seq;

create unique index if not exists claims_dedupe_idx on claims (investigation_id, dedupe_key);
