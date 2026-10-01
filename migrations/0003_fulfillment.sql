-- Fulfillment queue, holds, packing slips, batches, package learning and analytics fields.

ALTER TABLE shipments ADD COLUMN batch_id TEXT;
ALTER TABLE shipments ADD COLUMN shipping_paid REAL;       -- what the customer paid for shipping
ALTER TABLE shipments ADD COLUMN order_total REAL;
ALTER TABLE shipments ADD COLUMN order_created_at TEXT;
ALTER TABLE shipments ADD COLUMN requested_service TEXT;   -- checkout shipping line title
ALTER TABLE shipments ADD COLUMN list_cost REAL;           -- UPS published rate, before negotiated discount
ALTER TABLE shipments ADD COLUMN item_count INTEGER;
ALTER TABLE shipments ADD COLUMN dest_state TEXT;
ALTER TABLE shipments ADD COLUMN dest_country TEXT;
ALTER TABLE shipments ADD COLUMN scan_verified INTEGER NOT NULL DEFAULT 0;
CREATE INDEX shipments_batch_idx ON shipments(batch_id);
CREATE INDEX shipments_created_idx ON shipments(created_at);

-- Manual holds and releases. A rule can also hold an order; a 'released' row overrides that.
CREATE TABLE order_holds (
  order_id TEXT PRIMARY KEY,                 -- Shopify order GID
  order_name TEXT,
  status TEXT NOT NULL DEFAULT 'hold',       -- 'hold' | 'released'
  note TEXT NOT NULL DEFAULT '',
  agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE packing_slip_prints (
  order_id TEXT PRIMARY KEY,
  printed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- "Package learning": the box/weight last used for an identical set of items
CREATE TABLE learned_parcels (
  item_key TEXT PRIMARY KEY,                 -- sorted "sku-or-title×qty" list
  preset_id INTEGER,
  length REAL NOT NULL,
  width REAL NOT NULL,
  height REAL NOT NULL,
  weight REAL NOT NULL,
  uses INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
