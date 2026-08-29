CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  repo TEXT,
  path TEXT,
  start_line INTEGER,
  end_line INTEGER,
  signature TEXT,
  summary TEXT,
  extra JSON NOT NULL DEFAULT '{}',
  critical INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  evidence JSON NOT NULL,
  sources JSON NOT NULL,
  confidence REAL,
  conflict INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  UNIQUE(type, from_id, to_id)
);

CREATE INDEX IF NOT EXISTS edges_from_idx ON edges(from_id);
CREATE INDEX IF NOT EXISTS edges_to_idx ON edges(to_id);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  node_id TEXT,
  kind TEXT,
  text TEXT NOT NULL,
  embedding BLOB,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS journal (
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  payload JSON NOT NULL
);

CREATE TABLE IF NOT EXISTS health (
  key TEXT PRIMARY KEY,
  value JSON NOT NULL,
  updated_at TEXT NOT NULL
);
