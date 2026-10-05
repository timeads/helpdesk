-- AI spend so far on the repair manual was reading the old support email (the one-time backlog):
-- file it under its own name so the dashboard keeps it out of the monthly estimate
UPDATE ai_usage SET feature = 'Repair manual backlog' WHERE feature = 'Repair manual';
