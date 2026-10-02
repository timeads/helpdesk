-- Repair manual: topics written by AI from repair conversations (and edited by people)
CREATE TABLE IF NOT EXISTS manual_topics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  product TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',             -- markdown: symptoms, causes, fix steps, parts & tools
  status TEXT NOT NULL DEFAULT 'draft',      -- draft | published
  use_in_ai INTEGER NOT NULL DEFAULT 1,      -- published topics feed AI reply drafts
  edited_at TEXT,                            -- last edit by a person
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Each conversation that's an example of a topic: the running repair record
CREATE TABLE IF NOT EXISTS manual_cases (
  topic_id INTEGER NOT NULL REFERENCES manual_topics(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  summary TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  happened_at TEXT NOT NULL,
  PRIMARY KEY (topic_id, ticket_id)
);
CREATE INDEX IF NOT EXISTS manual_cases_ticket ON manual_cases(ticket_id);

-- Photos and videos from those conversations, shown on the topic
CREATE TABLE IF NOT EXISTS manual_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id INTEGER NOT NULL REFERENCES manual_topics(id) ON DELETE CASCADE,
  ticket_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  mime TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (topic_id, message_id, attachment_id)
);

-- Conversations the AI has already read for the manual
CREATE TABLE IF NOT EXISTS manual_scanned (
  ticket_id INTEGER PRIMARY KEY,
  result TEXT NOT NULL,                      -- repair | not_repair | error
  scanned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
