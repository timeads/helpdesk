-- Choices made on an order before its label is bought (boxes, split, service, address edits)
CREATE TABLE IF NOT EXISTS order_drafts (
  order_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
