-- Imported from Redo (Oct 1, 2026): box library, shipping automations, ship-from address.

ALTER TABLE package_presets ADD COLUMN type TEXT NOT NULL DEFAULT 'box';     -- box | envelope | soft
ALTER TABLE package_presets ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- Replace the three placeholder boxes from the first migration (anything added by hand stays)
DELETE FROM package_presets WHERE name IN ('Small box 8×6×4', 'Medium box 12×10×6', 'Large box 18×14×10');

-- weight = empty-box tare in lb. In "multi layer" names, the number in parentheses is the depth the box is cut to.
INSERT INTO package_presets (name, type, length, width, height, weight, is_default) VALUES
  ('Fabric Bag - Large', 'soft', 24, 19, 4, 0.0625, 0),
  ('Fabric Bag - Small', 'soft', 15, 12, 3, 0.0625, 0),
  ('Frame Box', 'box', 36, 8, 8, 0.5, 0),
  ('High Pile Multi Layer (6) 8 10 12', 'box', 24, 12, 6, 0.5, 0),
  ('High Pile Multi Layer 6 (8) 10 12', 'box', 24, 12, 8, 0.5, 0),
  ('High Pile Multi Layer 6 8 (10) 12', 'box', 24, 12, 10, 0.5, 0),
  ('High Pile Multi Layer 6 8 10 (12)', 'box', 24, 12, 12, 0.5, 0),
  ('Kit Box 8"', 'box', 36, 12, 8, 0.125, 0),
  ('Kit Box 12"', 'box', 36, 12, 12, 0.3125, 0),
  ('KRD Box 18x 12x 12', 'box', 18, 12, 12, 0.3, 0),
  ('KRD Box 18x 12x 8', 'box', 18, 12, 8, 0.125, 0),
  ('KRD Box 18x 12x 6', 'box', 18, 12, 6, 0.5, 0),
  ('Multi-layer (6) 8 10 12', 'box', 16, 12, 6, 0.625, 0),
  ('Multi-layer 6 (8) 10 12', 'box', 16, 12, 8, 0.625, 0),
  ('Multi-layer 6 8 (10) 12', 'box', 16, 12, 10, 0.625, 1),
  ('Multi-layer 6 8 10 (12)', 'box', 16, 12, 12, 0.625, 0),
  ('Large Bubble Env', 'envelope', 16, 11.5, 0.5, 0.1875, 0),
  ('LG Multi Layer (8) 10 12 14', 'box', 20, 16, 8, 1.0, 0),
  ('LG Multi Layer 8 (10) 12 14', 'box', 20, 16, 10, 1.0, 0),
  ('LG Multi Layer 8 10 (12) 14', 'box', 20, 16, 12, 1.0, 0),
  ('LG Multi Layer 8 10 12 (14)', 'box', 20, 16, 14, 1.0, 0),
  ('Small Bubble Env 10 x 7', 'envelope', 10, 7, 0, 0.1875, 0),
  ('Standard', 'box', 16, 12, 6, 0.5, 0),
  ('Standard - small', 'box', 14, 10, 4, 0.5, 0),
  ('1 Yard Primary Case box', 'box', 24, 18, 14, 0.625, 0);

-- Shipping rules: evaluated top to bottom when an order is opened on the Shipping screen
CREATE TABLE shipping_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  conditions TEXT NOT NULL DEFAULT '[]',   -- JSON [{field, op, value}], all must match
  actions TEXT NOT NULL DEFAULT '[]',      -- JSON [{type, value}]
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO shipping_rules (name, enabled, position, conditions, actions) VALUES
  ('Tufting machine only > standard box', 1, 1, '[{"field": "item_quantity", "op": "eq", "value": "1"}, {"field": "product_names", "op": "includes_any", "value": "ak5 - cut & loop tufting machine"}]', '[{"type": "set_package", "value": "Standard"}]'),
  ('Signature required over $250', 1, 2, '[{"field": "order_total", "op": "gt", "value": "250"}]', '[{"type": "require_signature", "value": "standard"}]');

-- Ship-from from Redo, only if none has been saved yet (UPS also needs a phone number — add it in Settings)
INSERT OR IGNORE INTO settings (key, value) VALUES ('ship_from', '{"name": "Tuft HQ", "company": "Tuft the World", "phone": "", "address1": "5400 Grays Ave", "address2": "", "city": "Philadelphia", "state": "PA", "zip": "19143", "country": "US"}');

ALTER TABLE shipments ADD COLUMN signature TEXT;  -- null | standard | adult
