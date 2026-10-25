-- =====================================================================
-- 003: product-level email templates (one approved main template per product)
--
-- Flow: Agent drafts a template (pending_approval) -> user edits -> user
-- approves. Only the approved template may be used for batch outreach.
-- =====================================================================

CREATE TABLE product_email_templates (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id      TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL DEFAULT 1,
  subject         TEXT NOT NULL DEFAULT '',
  body_text       TEXT NOT NULL DEFAULT '',
  language        TEXT NOT NULL DEFAULT 'en',
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'pending_approval', 'approved', 'disabled')),
  variables_json  TEXT NOT NULL DEFAULT '[]',
  attachments_json TEXT NOT NULL DEFAULT '[]',
  generated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (workspace_id, product_id, version)
);

-- At most one approved template per product/workspace.
CREATE UNIQUE INDEX idx_product_templates_approved
  ON product_email_templates(workspace_id, product_id)
  WHERE status = 'approved';

CREATE INDEX idx_product_templates_product
  ON product_email_templates(workspace_id, product_id, status, version);
