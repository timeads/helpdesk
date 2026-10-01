-- Gmail messages we looked at and chose not to import (newsletters, blocked senders, drafts…),
-- so the minute sync never downloads them again.
CREATE TABLE skipped_messages (
  gmail_message_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
