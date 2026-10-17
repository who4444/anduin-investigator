-- One evidence set, one investigation: drop duplicate rows left by racing
-- uploads (keep the latest), then enforce the cache key.
delete from investigations a using investigations b
where a.content_hash = b.content_hash
  and (b.created_at > a.created_at or (b.created_at = a.created_at and b.id > a.id));

create unique index if not exists investigations_content_hash_uq on investigations (content_hash);
