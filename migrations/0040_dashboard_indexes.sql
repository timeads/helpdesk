-- "Database overloaded" while the Dashboard loads: its teammate and resolution figures read whole tables
-- Replies per teammate since a date
CREATE INDEX IF NOT EXISTS messages_agent_idx ON messages(agent_id, sent_at);
-- Tickets closed per teammate since a date
CREATE INDEX IF NOT EXISTS events_agent_idx ON events(agent_id, created_at);
-- Resolution times since a date
CREATE INDEX IF NOT EXISTS tickets_resolved_idx ON tickets(resolved_at);
