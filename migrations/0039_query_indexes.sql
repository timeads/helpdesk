-- "Database overloaded": indexes for queries that were reading whole tables
-- Tickets closed in a period (hub summary, dashboard)
CREATE INDEX IF NOT EXISTS tickets_closed_idx ON tickets(closed_at);
-- Tickets created in a period (dashboard, hub first-reply times, knowledge-base scan)
CREATE INDEX IF NOT EXISTS tickets_created_idx ON tickets(created_at);
