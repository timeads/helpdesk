-- Orders made on the blank-label page ("Save as order"): wait in To ship until their label is bought
CREATE TABLE IF NOT EXISTS manual_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL DEFAULT '',
  ship_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | shipped | deleted
  agent_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS manual_orders_status ON manual_orders (status);
