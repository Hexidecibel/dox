CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER DEFAULT 0,
  window_start TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
