-- Shipments imported from another tool (Redo): one row per order, every box in `packages`.
ALTER TABLE shipments ADD COLUMN source TEXT;          -- null = bought here | 'redo'
ALTER TABLE shipments ADD COLUMN source_ref TEXT;      -- e.g. 'redo:#68702-TG' (re-importing updates in place)
ALTER TABLE shipments ADD COLUMN delivery_status TEXT;
ALTER TABLE shipments ADD COLUMN reported_margin REAL; -- what the other tool claimed (Redo counts shipping paid once per box)
CREATE UNIQUE INDEX shipments_source_ref_idx ON shipments(source_ref);
