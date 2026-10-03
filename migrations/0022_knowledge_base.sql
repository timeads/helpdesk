-- Knowledge base: customer-facing articles (how-tos, product guides, troubleshooting), edited here,
-- published to the store as a Shopify blog (real pages for search engines and AI crawlers) and used
-- by the chat and AI drafts.
CREATE TABLE kb_topics (
  id TEXT PRIMARY KEY,                    -- slug, e.g. "troubleshoot"
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE kb_articles (
  id TEXT PRIMARY KEY,                    -- slug, used in links (#gs-overview)
  topic_id TEXT NOT NULL REFERENCES kb_topics(id) ON UPDATE CASCADE,
  title TEXT NOT NULL,
  body_html TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',     -- plain text, for search and the AI
  status TEXT NOT NULL DEFAULT 'published', -- draft | published
  use_in_ai INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',   -- search result snippet (meta description); first sentences when empty
  shopify_id TEXT,                        -- the Shopify blog article it's published as
  shopify_handle TEXT,                    -- its URL: /blogs/knowledge-base/<handle>
  synced_at TEXT,                         -- last published to Shopify
  edited_by INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX kb_articles_topic_idx ON kb_articles(topic_id, position);

CREATE TABLE kb_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mime TEXT NOT NULL,
  data TEXT NOT NULL,                     -- base64
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- What the AI noticed in support conversations that the knowledge base should say
CREATE TABLE kb_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT REFERENCES kb_articles(id) ON DELETE CASCADE,  -- null = a new article
  topic_id TEXT,
  title TEXT NOT NULL DEFAULT '',         -- the new article's title, or the section heading to add
  content_html TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  ticket_ids TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | dismissed
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX kb_suggestions_status_idx ON kb_suggestions(status, created_at);

CREATE TABLE kb_scanned (
  ticket_id INTEGER PRIMARY KEY,
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
