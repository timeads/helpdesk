-- In-store pickup orders: when they were marked ready (Shopify emails the customer) and picked up
CREATE TABLE IF NOT EXISTS pickup_status (
  order_id TEXT PRIMARY KEY,
  order_name TEXT,
  ready_at TEXT,
  picked_up_at TEXT,
  agent_id INTEGER
);
