-- Labels that ship only part of an order (the rest waits, on hold)
ALTER TABLE shipments ADD COLUMN partial INTEGER NOT NULL DEFAULT 0;
