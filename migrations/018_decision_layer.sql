-- 018_decision_layer: structured gap categories (C6).
-- Question grouping must not depend on text regexes; agents set the category
-- at write time, legacy rows fall back deterministically in code (null).
alter table gaps add column if not exists category text;
