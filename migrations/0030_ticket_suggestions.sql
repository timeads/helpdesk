-- AI reply suggestions for email tickets: 2-3 ready-to-edit replies to the latest customer email
CREATE TABLE ticket_suggestions (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL,            -- the customer email they answer (new email → new suggestions)
  status TEXT NOT NULL DEFAULT 'working', -- working | ready | error
  options TEXT NOT NULL DEFAULT '[]',     -- [{ label, body }]
  error TEXT,
  used INTEGER,                           -- which option a teammate picked
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
