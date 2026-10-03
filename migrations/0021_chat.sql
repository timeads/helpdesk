-- Live chat on the store website: each chat is a ticket (channel = 'chat'), its messages live in messages (kind = chat*)
ALTER TABLE tickets ADD COLUMN channel TEXT NOT NULL DEFAULT 'email';  -- email | chat
ALTER TABLE messages ADD COLUMN kind TEXT;                              -- null (email) | chat | chat_ai | chat_system

CREATE TABLE chats (
  id TEXT PRIMARY KEY,                 -- public id the widget keeps
  token TEXT NOT NULL,                 -- secret the widget sends with every request
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  name TEXT,
  state TEXT NOT NULL DEFAULT 'ai',    -- ai | waiting (wants a person) | agent (teammate replying) | email (moved to email) | ended
  page_url TEXT,
  ip_hash TEXT,
  waiting_since TEXT,                  -- when it started waiting for a person
  visitor_seen_at TEXT,                -- last poll from the widget (online dot)
  visitor_typing_at TEXT,
  agent_seen_at TEXT,
  agent_typing_at TEXT,
  ai_replies INTEGER NOT NULL DEFAULT 0,
  ai_draft TEXT,                       -- draft mode: {reply, handoff, reason} waiting for a teammate to send
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX chats_ticket_idx ON chats(ticket_id);
CREATE INDEX chats_state_idx ON chats(state, updated_at);
CREATE INDEX chats_ip_idx ON chats(ip_hash, created_at);

-- Photos sent in a chat (either side), resized in the browser before upload
CREATE TABLE chat_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data TEXT NOT NULL,                  -- base64
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX chat_files_chat_idx ON chat_files(chat_id);
