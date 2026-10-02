-- The Shopify fulfillment each label created, so voiding the label can undo it
ALTER TABLE shipments ADD COLUMN fulfillment_id TEXT;
ALTER TABLE shipments ADD COLUMN voided_at TEXT;
