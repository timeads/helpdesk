-- The learn hub's "Ask" box: every question, the answer given, and whether it helped
CREATE TABLE ask_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  machine TEXT NOT NULL DEFAULT '',
  qkey TEXT NOT NULL,                     -- normalized question + machine, to reuse a recent answer
  kind TEXT NOT NULL DEFAULT '',          -- fix | buy | classes | general | order
  answer TEXT NOT NULL DEFAULT '{}',      -- what the visitor was shown (JSON)
  sources TEXT NOT NULL DEFAULT '[]',     -- ids the answer drew on, incl. internal repair notes
  helpful INTEGER,                        -- 1 / -1 from the thumbs, null if not rated
  page TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ask_log_ip_idx ON ask_log(ip_hash, created_at);
CREATE INDEX ask_log_qkey_idx ON ask_log(qkey, created_at);
CREATE INDEX ask_log_created_idx ON ask_log(created_at);
