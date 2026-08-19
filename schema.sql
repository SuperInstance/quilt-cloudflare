-- Quilt on Cloudflare — D1 schema
-- Run with: wrangler d1 execute quilt-db --file=./schema.sql

-- Main cells table
CREATE TABLE IF NOT EXISTS cells (
  id TEXT NOT NULL,
  sheet_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  value TEXT,
  value_type TEXT,
  t INTEGER NOT NULL DEFAULT 0,
  author TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
  metadata TEXT,
  PRIMARY KEY (sheet_id, id)
);

-- Edges (cell graph topology)
CREATE TABLE IF NOT EXISTS edges (
  sheet_id TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  PRIMARY KEY (sheet_id, from_id, to_id)
);

-- History (every value change)
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  t INTEGER NOT NULL,
  author TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

-- Listeners
CREATE TABLE IF NOT EXISTS listeners (
  sheet_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  watch TEXT NOT NULL,
  condition TEXT,
  action TEXT,
  PRIMARY KEY (sheet_id, cell_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cells_sheet ON cells(sheet_id);
CREATE INDEX IF NOT EXISTS idx_history_cell ON history(sheet_id, cell_id, t);
CREATE INDEX IF NOT EXISTS idx_history_sheet ON history(sheet_id, t);
CREATE INDEX IF NOT EXISTS idx_edges_sheet ON edges(sheet_id);
CREATE INDEX IF NOT EXISTS idx_listeners_sheet ON listeners(sheet_id);

-- AI cell usage tracking
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sheet_id TEXT NOT NULL,
  cell_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_sheet ON ai_usage(sheet_id, created_at);
