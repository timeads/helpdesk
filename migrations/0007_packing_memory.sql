-- Packing memory: every box of a shipment (multi-box too) and what went in each, per item set.
ALTER TABLE learned_parcels ADD COLUMN boxes TEXT;          -- JSON [{preset_id, length, width, height, weight, items: {productKey: qty}}]
ALTER TABLE learned_parcels ADD COLUMN products_key TEXT;   -- same products ignoring quantities
ALTER TABLE learned_parcels ADD COLUMN label TEXT;          -- "1 × AK-I Cut Pile Tufting Gun, 4 × Mustard"
CREATE INDEX learned_parcels_products_idx ON learned_parcels(products_key, updated_at);
