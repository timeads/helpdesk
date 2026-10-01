-- Agents who can sign in and work tickets
CREATE TABLE agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'agent',        -- 'admin' | 'agent'
  signature TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

-- Key/value JSON settings and cached integration state (tokens are encrypted)
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gmail_thread_id TEXT UNIQUE,
  subject TEXT NOT NULL DEFAULT '(no subject)',
  customer_email TEXT NOT NULL COLLATE NOCASE,
  customer_name TEXT,
  status TEXT NOT NULL DEFAULT 'open',      -- 'open' | 'pending' | 'closed'
  assignee_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  unread INTEGER NOT NULL DEFAULT 1,
  snippet TEXT NOT NULL DEFAULT '',
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_message_at TEXT NOT NULL,
  last_inbound_at TEXT,
  closed_at TEXT
);
CREATE INDEX tickets_status_idx ON tickets(status, last_message_at);
CREATE INDEX tickets_assignee_idx ON tickets(assignee_id, status);
CREATE INDEX tickets_customer_idx ON tickets(customer_email);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  gmail_message_id TEXT UNIQUE,
  rfc_message_id TEXT,
  direction TEXT NOT NULL,                  -- 'in' | 'out'
  from_email TEXT NOT NULL,
  from_name TEXT,
  to_emails TEXT NOT NULL DEFAULT '',
  cc_emails TEXT NOT NULL DEFAULT '',
  subject TEXT,
  sent_at TEXT NOT NULL,
  body_text TEXT NOT NULL DEFAULT '',
  body_html TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',   -- JSON [{id, filename, mimeType, size}]
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL
);
CREATE INDEX messages_ticket_idx ON messages(ticket_id, sent_at);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Activity log: assignment and status changes
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX events_ticket_idx ON events(ticket_id);

-- Saved replies
CREATE TABLE macros (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE package_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  length REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  weight REAL NOT NULL DEFAULT 0            -- empty box weight, lb
);

CREATE TABLE shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT,                            -- Shopify order GID
  order_name TEXT,
  ticket_id INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  carrier TEXT NOT NULL DEFAULT 'UPS',
  service_code TEXT NOT NULL,
  service_name TEXT NOT NULL,
  shipment_id TEXT,
  tracking_numbers TEXT NOT NULL DEFAULT '[]',
  labels TEXT NOT NULL DEFAULT '[]',        -- JSON [base64 image per package]
  label_format TEXT NOT NULL DEFAULT 'GIF',
  cost REAL,
  currency TEXT DEFAULT 'USD',
  packages TEXT NOT NULL DEFAULT '[]',
  ship_to TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'purchased', -- 'purchased' | 'voided'
  fulfilled INTEGER NOT NULL DEFAULT 0,
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX shipments_order_idx ON shipments(order_id);

INSERT INTO package_presets (name, length, width, height, weight) VALUES
  ('Small box 8×6×4', 8, 6, 4, 0.3),
  ('Medium box 12×10×6', 12, 10, 6, 0.6),
  ('Large box 18×14×10', 18, 14, 10, 1.2);
