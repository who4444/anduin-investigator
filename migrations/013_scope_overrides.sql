-- Manager force-include (G-01 scope review): record ids the manager added
-- back into the investigation from the excluded list. Ids are validated
-- against the registry at write time; unknown ids are dropped there.
alter table investigations
  add column if not exists scope_overrides jsonb not null default '[]'::jsonb;
