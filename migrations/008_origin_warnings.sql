alter table investigations add column if not exists ingest_warnings jsonb not null default '[]'::jsonb;
alter table investigations add column if not exists origin text not null default 'upload';
