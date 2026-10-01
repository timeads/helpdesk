-- Support upgrade (Redo parity): statuses, priority, tags, threads, views, mentions, rules, knowledge, AI insights.

-- Statuses: open | in_progress | snoozed | closed | archived | spam | deleted ("pending" becomes "in progress")
UPDATE tickets SET status = 'in_progress' WHERE status = 'pending';
UPDATE events SET detail = 'in_progress' WHERE kind = 'status' AND detail = 'pending';

ALTER TABLE tickets ADD COLUMN priority TEXT;                -- null | low | normal | high | urgent
ALTER TABLE tickets ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE tickets ADD COLUMN snoozed_until TEXT;
ALTER TABLE tickets ADD COLUMN merged_into INTEGER REFERENCES tickets(id) ON DELETE SET NULL;
ALTER TABLE tickets ADD COLUMN ai_summary TEXT;
ALTER TABLE tickets ADD COLUMN ai_sentiment TEXT;            -- positive | neutral | negative
ALTER TABLE tickets ADD COLUMN ai_type TEXT;                 -- e.g. ORDER_STATUS, REPAIR, SALES, OTHER
ALTER TABLE tickets ADD COLUMN ai_updated_at TEXT;
ALTER TABLE tickets ADD COLUMN first_response_at TEXT;
ALTER TABLE tickets ADD COLUMN resolved_at TEXT;
CREATE INDEX tickets_snoozed_idx ON tickets(status, snoozed_until);

-- A ticket can hold several Gmail threads (merges, new email threads)
CREATE TABLE ticket_threads (
  thread_id TEXT PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  subject TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX ticket_threads_ticket_idx ON ticket_threads(ticket_id);
INSERT OR IGNORE INTO ticket_threads (thread_id, ticket_id, subject, created_at)
  SELECT gmail_thread_id, id, subject, created_at FROM tickets WHERE gmail_thread_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN bcc_emails TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN thread_id TEXT;

-- Tags live in groups
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  group_name TEXT NOT NULL DEFAULT 'General',
  color TEXT
);
INSERT INTO tags (name, group_name) VALUES
  ('instagram_story_reply','Email Categories'),('instagram_story_mention','Email Categories'),('category_promotions','Email Categories'),
  ('important','Email Categories'),('spam','Email Categories'),
  ('AI_NEEDS_HELP','General'),('ai:needs_help','General'),('ai:no_reply','General'),('PDP Initiated','General'),('not-shipped','General'),
  ('already-shipped','General'),('edit-address','General'),('RETURN/EXCHANGE','General'),('duo','General'),('damaged','General'),
  ('not-received','General'),('cancel','General'),('ORDER-CHANGE/CANCEL','General'),('full-refund','General'),('ORDER-STATUS','General'),
  ('shipped','General'),('REFUND','General'),('partial-refund','General'),('not TTW machine repair','General'),
  ('help-center-article-recommendation','General'),('Order Status','General'),('IG Comments','General'),('Repairs','General'),
  ('VIP','General'),('exclude analytics','General');

-- Saved views (sidebar), optionally grouped in folders
CREATE TABLE views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  folder TEXT,
  filters TEXT NOT NULL DEFAULT '{}',   -- JSON {status?, tags_any?, assignee?, priority?, q?}
  position INTEGER NOT NULL DEFAULT 0
);
INSERT INTO views (name, folder, filters, position) VALUES
  ('VIP', NULL, '{"tags_any":["VIP"],"status":"active"}', 1),
  ('Repairs', NULL, '{"tags_any":["Repairs"],"status":"active"}', 2),
  ('Order Status', NULL, '{"tags_any":["ORDER-STATUS","Order Status"],"status":"active"}', 3);

-- @mentions in internal notes
CREATE TABLE mentions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  note_id INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  seen INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX mentions_agent_idx ON mentions(agent_id, seen);

-- Macro automations: [{type: add_tags|set_status|set_subject|add_note, value}]
ALTER TABLE macros ADD COLUMN actions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE macros ADD COLUMN uses INTEGER NOT NULL DEFAULT 0;

-- Support rules, grouped by trigger, run top to bottom
CREATE TABLE support_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,                -- ticket_created | customer_message | agent_reply | status_changed
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  match TEXT NOT NULL DEFAULT 'all',    -- all | any
  conditions TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO support_rules (name, trigger, enabled, position, match, conditions, actions) VALUES
  ('Tag order status questions', 'ticket_created', 0, 1, 'any',
   '[{"field":"subject","op":"contains","value":"order status, where is my order, tracking"},{"field":"body","op":"contains","value":"where is my order, tracking number, hasn''t shipped"}]',
   '[{"type":"add_tag","value":"ORDER-STATUS"}]'),
  ('Flag repairs', 'ticket_created', 0, 2, 'any',
   '[{"field":"body","op":"contains","value":"repair, broken, not cutting, jammed"}]',
   '[{"type":"add_tag","value":"Repairs"}]');

-- Knowledge the AI draws on (replaces the single "AI guidance" box; that text is imported as one entry)
CREATE TABLE knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'policy',  -- policy | faq | product | shipping | other
  status TEXT NOT NULL DEFAULT 'active',-- active | inactive
  uses INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO knowledge (name, content, type)
  SELECT 'Store guidance', json_extract(value, '$'), 'policy' FROM settings WHERE key = 'ai_guidance' AND json_extract(value, '$') != '';

-- Assignment & availability
ALTER TABLE agents ADD COLUMN available INTEGER NOT NULL DEFAULT 1;
