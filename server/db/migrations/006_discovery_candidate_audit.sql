-- Candidate-level discovery audit and final qualification state.
-- Additive only: existing discovery_runs rows get safe defaults.

ALTER TABLE discovery_runs ADD COLUMN qualification_status TEXT NOT NULL DEFAULT 'not_applicable';
ALTER TABLE discovery_runs ADD COLUMN qualified_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_runs ADD COLUMN rejected_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_runs ADD COLUMN insufficient_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_runs ADD COLUMN unclassified_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_runs ADD COLUMN qualification_finalized_at TEXT;
ALTER TABLE discovery_runs ADD COLUMN qualification_evaluation TEXT;

CREATE TABLE IF NOT EXISTS discovery_candidates (
  id                      TEXT PRIMARY KEY,
  workspace_id            TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id                  TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  query                   TEXT,
  raw_url                 TEXT,
  normalized_url          TEXT,
  title                   TEXT,
  stage                   TEXT NOT NULL,
  outcome                 TEXT NOT NULL,
  reason_code             TEXT,
  identity_keys_json      TEXT NOT NULL DEFAULT '[]',
  matched_company_id      TEXT REFERENCES companies(id) ON DELETE SET NULL,
  duplicate_of_candidate_id TEXT,
  website_check_status    TEXT,
  qualification           TEXT,
  qualification_reason    TEXT,
  evidence_urls_json      TEXT NOT NULL DEFAULT '[]',
  evidence_excerpt        TEXT,
  saved_company_id        TEXT REFERENCES companies(id) ON DELETE SET NULL,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discovery_candidates_run
  ON discovery_candidates(workspace_id, run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_discovery_candidates_outcome
  ON discovery_candidates(workspace_id, run_id, outcome);
