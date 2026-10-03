-- AI knowledge pulled from the store website (Shopify pages and policies, or any public link), kept up to date
ALTER TABLE knowledge ADD COLUMN source TEXT;        -- policy:<TYPE> | page:<gid> | url:<address>; null = written here
ALTER TABLE knowledge ADD COLUMN source_url TEXT;    -- where customers see it
ALTER TABLE knowledge ADD COLUMN synced_at TEXT;
CREATE UNIQUE INDEX knowledge_source_idx ON knowledge(source) WHERE source IS NOT NULL;
