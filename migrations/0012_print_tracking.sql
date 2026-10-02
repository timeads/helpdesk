-- When each label was last printed (and how often), so reprints can warn first
ALTER TABLE shipments ADD COLUMN printed_at TEXT;
ALTER TABLE shipments ADD COLUMN print_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE packing_slip_prints ADD COLUMN print_count INTEGER NOT NULL DEFAULT 1;
-- Labels bought before this opened their print page right away, so count them as printed
UPDATE shipments SET printed_at = created_at, print_count = 1 WHERE labels != '[]' AND printed_at IS NULL;
