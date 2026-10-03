-- Knowledge base: earlier versions of articles (before AI merges and rewrites), so any change can be undone
CREATE TABLE kb_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  article_id TEXT NOT NULL,              -- no foreign key: versions of merged-away articles are kept too
  title TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  body_html TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  agent_id INTEGER,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX kb_versions_article_idx ON kb_versions(article_id, saved_at);
