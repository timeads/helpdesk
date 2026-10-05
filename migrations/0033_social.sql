-- Instagram and Facebook: comments on our posts and direct messages become tickets (channel = instagram | facebook).
-- One ticket per person per post for comments, and one per person for DMs; a private reply to a comment
-- continues as a DM on the same ticket.
CREATE TABLE social_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,              -- instagram | facebook
  kind TEXT NOT NULL,                  -- comment | dm
  thread_key TEXT NOT NULL UNIQUE,     -- instagram:dm:<user id> | instagram:c:<post id>:<user id>
  user_id TEXT NOT NULL,               -- their id as Meta gives it to our account
  user_name TEXT,
  post_id TEXT,
  post_caption TEXT,
  post_url TEXT,
  post_image TEXT,
  last_comment_id TEXT,                -- their latest comment: public replies go under it
  last_inbound_at TEXT,                -- DMs: Meta only delivers replies within 24 hours of this
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX social_threads_ticket_idx ON social_threads(ticket_id);

-- The comment or message id on Meta's side, so a webhook delivered twice is only kept once
ALTER TABLE messages ADD COLUMN external_id TEXT;
CREATE UNIQUE INDEX messages_external_idx ON messages(external_id) WHERE external_id IS NOT NULL;

-- Photos customers send in DMs (Meta's links expire, so they're kept here)
CREATE TABLE social_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mime TEXT NOT NULL,
  filename TEXT NOT NULL,
  data TEXT NOT NULL,                  -- base64
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
