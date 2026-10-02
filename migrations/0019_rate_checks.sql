-- Rate check: Redo-imported shipments re-quoted with our own carrier accounts
CREATE TABLE rate_checks (
  shipment_id INTEGER PRIMARY KEY,        -- the Redo-imported shipment
  checked_at TEXT NOT NULL,
  boxes INTEGER,                          -- boxes we'd ship it in (box memory / rules / default)
  weight REAL,                            -- total lb across those boxes
  box_name TEXT,
  weight_source TEXT,                     -- learned | product weights
  redo_cost REAL,
  redo_service TEXT,
  redo_boxes INTEGER,
  best_total REAL,
  best_service TEXT,
  best_carrier TEXT,
  same_total REAL,                        -- our rate for the service Redo used, when we have it
  same_service TEXT,
  carriers TEXT NOT NULL DEFAULT '{}',    -- {carrier: {total, service}}: each carrier's cheapest
  error TEXT
);
