-- Website chat: customers prove an email is theirs with a one-time code, then the AI can look up their orders
ALTER TABLE chats ADD COLUMN verify_email TEXT;            -- where the pending code went
ALTER TABLE chats ADD COLUMN verify_code TEXT;             -- SHA-256 of the pending code
ALTER TABLE chats ADD COLUMN verify_expires TEXT;
ALTER TABLE chats ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN verify_sends INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN verified_emails TEXT NOT NULL DEFAULT '[]';
