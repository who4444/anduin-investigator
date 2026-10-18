-- G-12: the pre-run scope review is confirmed once per investigation; a
-- reload while investigators run must not re-open the review.
alter table investigations
  add column if not exists scope_reviewed_at timestamptz;
