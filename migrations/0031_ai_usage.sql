-- AI usage per day, feature and model: tokens from each response's usage, for the cost card on the dashboard
CREATE TABLE ai_usage (
  day TEXT NOT NULL,                       -- YYYY-MM-DD (UTC)
  feature TEXT NOT NULL,                   -- Website chat, Help & Guides, Suggested replies, …
  model TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0, -- includes thinking
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, feature, model)
);
