-- Phase 1: persisted read-only Agent tasks and append-only execution events.
-- Additive only: no existing table is altered or rewritten.

CREATE TABLE IF NOT EXISTS agent_tasks (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  goal           TEXT NOT NULL,
  mode           TEXT NOT NULL DEFAULT 'read_only',
  status         TEXT NOT NULL DEFAULT 'queued',
  step_count     INTEGER NOT NULL DEFAULT 0,
  model_calls    INTEGER NOT NULL DEFAULT 0,
  tool_calls     INTEGER NOT NULL DEFAULT 0,
  budget_tokens  INTEGER NOT NULL DEFAULT 16000,
  run_token      TEXT,
  run_lease_until TEXT,
  job_id         TEXT,
  result_json    TEXT NOT NULL DEFAULT '{}',
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  finished_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_workspace ON agent_tasks(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_status ON agent_tasks(workspace_id, status, created_at);

CREATE TABLE IF NOT EXISTS agent_events (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id        TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  step_no        INTEGER NOT NULL,
  type           TEXT NOT NULL,
  tool_name      TEXT,
  input_json     TEXT NOT NULL DEFAULT '{}',
  output_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'ok',
  error          TEXT,
  execution_id   TEXT,
  duration_ms    INTEGER,
  created_at     TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_task_step ON agent_events(task_id, step_no);
CREATE INDEX IF NOT EXISTS idx_agent_events_workspace ON agent_events(workspace_id, created_at);
