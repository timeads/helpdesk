-- Orders shipped together: one label (shipments row, on the first order) covers the others listed here
CREATE TABLE merged_orders (
  order_id TEXT PRIMARY KEY,               -- the order that rode along
  order_name TEXT,
  shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
  fulfilled INTEGER NOT NULL DEFAULT 0,
  fulfillment_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX merged_orders_shipment_idx ON merged_orders(shipment_id);
