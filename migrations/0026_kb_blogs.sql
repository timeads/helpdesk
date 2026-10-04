-- Knowledge base articles can live in any of the store's blogs (they keep their URL there)
ALTER TABLE kb_articles ADD COLUMN blog_handle TEXT NOT NULL DEFAULT 'knowledge-base';
ALTER TABLE kb_articles ADD COLUMN store_tags TEXT;   -- JSON: tags on the store for articles in other blogs, kept as they are
