-- ProofTrace common database (D1). See docs/ARCHITECTURE.md §3.
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY,
  input_url TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'live',
  status TEXT NOT NULL,
  selected_claim_id TEXT,
  result_json TEXT,              -- full Investigation state at finish
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_investigations_started ON investigations(started_at DESC);

CREATE TABLE IF NOT EXISTS source_pages (
  id TEXT PRIMARY KEY,           -- sha-256 of final_url
  requested_url TEXT NOT NULL,
  final_url TEXT NOT NULL,
  issuer TEXT NOT NULL,
  title TEXT,
  text TEXT NOT NULL,
  links_json TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  http_status INTEGER,
  fetch_method TEXT NOT NULL,    -- fetch | browser
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_pages_requested ON source_pages(requested_url);

CREATE TABLE IF NOT EXISTS source_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- search | fetch
  target TEXT NOT NULL,          -- query or URL
  status TEXT NOT NULL,
  reason TEXT,
  method TEXT,
  result_count INTEGER,
  ms INTEGER,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_attempts_inv ON source_attempts(investigation_id);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investigation_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  url TEXT NOT NULL,
  issuer TEXT NOT NULL,
  quote TEXT NOT NULL,
  supports TEXT NOT NULL,
  independent INTEGER NOT NULL,
  scope_match INTEGER NOT NULL,
  satisfies_json TEXT NOT NULL DEFAULT '[]',
  retrieved_at TEXT NOT NULL,
  cached INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_evidence_inv ON evidence(investigation_id);

CREATE TABLE IF NOT EXISTS official_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT NOT NULL,
  claim_types TEXT NOT NULL,     -- comma list of ClaimType
  keywords TEXT NOT NULL,        -- comma list matched against claim text (lowercase)
  lookup_url_pattern TEXT,       -- {slug} = brand slug, {brand} = url-encoded brand
  independent INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS demo_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  input_url TEXT NOT NULL,
  expected TEXT NOT NULL,        -- expected regression outcome, never passed to agents
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recorded_runs (
  id TEXT PRIMARY KEY,
  input_url TEXT NOT NULL,
  result_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_config (
  role TEXT PRIMARY KEY,         -- extractor | certification | quantitative | sourcing | action
  model TEXT NOT NULL,
  fallback_model TEXT,
  reasoning TEXT,                -- none | low | high
  max_tokens INTEGER NOT NULL DEFAULT 2000,
  timeout_ms INTEGER NOT NULL DEFAULT 45000
);
