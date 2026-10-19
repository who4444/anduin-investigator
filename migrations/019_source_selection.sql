-- 019_source_selection: the live pull's expanded target selection, with
-- labels, so the pre-run scope review can say "I'll search: <names>".
alter table investigations add column if not exists source_selection jsonb;
