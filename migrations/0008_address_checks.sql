-- Address verification results, so each ship-to address is checked once.
CREATE TABLE address_checks (
  hash TEXT PRIMARY KEY,
  result TEXT NOT NULL,              -- JSON AddressCheck
  checked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
