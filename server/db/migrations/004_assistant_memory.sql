-- Assistant long-term memory (owner: lead).
-- One row per remembered preference/fact/instruction for a user in a workspace.
CREATE TABLE IF NOT EXISTS assistant_memories (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'preference',
  content       TEXT NOT NULL,
  source        TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assistant_memories_workspace_user
  ON assistant_memories(workspace_id, user_id, updated_at DESC);
