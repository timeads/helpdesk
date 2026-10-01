-- International shipping: per-product customs details (remembered once entered) and customs forms per label.
CREATE TABLE customs_profiles (
  product_key TEXT PRIMARY KEY,      -- same key as packing memory (SKU, else title / variant)
  description TEXT NOT NULL,         -- plain-language contents, e.g. "Acrylic yarn"
  hs_code TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'US',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE shipments ADD COLUMN forms TEXT NOT NULL DEFAULT '[]';   -- JSON [{type, data(base64 PDF)}]
