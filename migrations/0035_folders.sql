-- Ticket folders: file a ticket away (e.g. "Repairs — waiting for the machine") so it leaves the inbox views
-- but is one click away in the sidebar. A ticket is in at most one folder.
CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE tickets ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX tickets_folder_idx ON tickets(folder_id, status);
