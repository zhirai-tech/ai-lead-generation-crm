-- =====================================================================
-- ZHIRAI Europe B2B AI Outreach Platform - initial schema
-- SQLite / node:sqlite. All business tables are scoped by workspace_id.
-- =====================================================================

CREATE TABLE workspaces (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  slug          TEXT NOT NULL UNIQUE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'deleted')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  deleted_at    TEXT
);

CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  email                TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash        TEXT NOT NULL,
  name                 TEXT NOT NULL,
  locale               TEXT NOT NULL DEFAULT 'zh-CN',
  is_active            INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at        TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);

CREATE TABLE memberships (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'suspended')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, user_id)
);
CREATE INDEX idx_memberships_user ON memberships(user_id);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_hash    TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT,
  expires_at   TEXT NOT NULL,
  revoked_at   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id, expires_at);

CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes_json  TEXT NOT NULL DEFAULT '[]',
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_api_keys_workspace ON api_keys(workspace_id);

CREATE TABLE settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key          TEXT NOT NULL,
  value_json   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- ---------------------------------------------------------------- products
CREATE TABLE products (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  category            TEXT,
  sku                 TEXT,
  description         TEXT,
  specs_json          TEXT NOT NULL DEFAULT '{}',
  applications_json   TEXT NOT NULL DEFAULT '[]',
  materials           TEXT,
  certifications_json TEXT NOT NULL DEFAULT '[]',
  capacity            TEXT,
  moq                 TEXT,
  pricing_terms       TEXT,
  samples             TEXT,
  lead_time           TEXT,
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  created_by          TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  deleted_at          TEXT
);
CREATE INDEX idx_products_workspace ON products(workspace_id, status);

CREATE TABLE product_files (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  mime_type    TEXT,
  size_bytes   INTEGER NOT NULL DEFAULT 0,
  storage_path TEXT NOT NULL,
  uploaded_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);

-- ------------------------------------------------------- ideal customer profile
CREATE TABLE icps (
  id                         TEXT PRIMARY KEY,
  workspace_id               TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id                 TEXT REFERENCES products(id) ON DELETE SET NULL,
  name                       TEXT NOT NULL,
  description                TEXT,
  target_countries_json      TEXT NOT NULL DEFAULT '[]',
  target_regions_json        TEXT NOT NULL DEFAULT '[]',
  target_company_types_json  TEXT NOT NULL DEFAULT '[]',
  target_sizes_json          TEXT NOT NULL DEFAULT '[]',
  target_roles_json          TEXT NOT NULL DEFAULT '[]',
  include_keywords_json      TEXT NOT NULL DEFAULT '[]',
  exclude_keywords_json      TEXT NOT NULL DEFAULT '[]',
  min_score                  INTEGER NOT NULL DEFAULT 60,
  is_active                  INTEGER NOT NULL DEFAULT 1,
  created_by                 TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at                 TEXT NOT NULL,
  updated_at                 TEXT NOT NULL
);
CREATE INDEX idx_icps_workspace ON icps(workspace_id, is_active);

-- --------------------------------------------------------------- companies
CREATE TABLE companies (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  normalized_name    TEXT NOT NULL,
  domain             TEXT,
  website            TEXT,
  country            TEXT,
  region             TEXT,
  city               TEXT,
  address            TEXT,
  company_type       TEXT,
  industry           TEXT,
  employee_range     TEXT,
  revenue_range      TEXT,
  description        TEXT,
  linkedin_url       TEXT,
  phone              TEXT,
  status             TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'qualified', 'contacted', 'replied', 'customer', 'disqualified', 'archived')),
  tags_json          TEXT NOT NULL DEFAULT '[]',
  icp_id             TEXT REFERENCES icps(id) ON DELETE SET NULL,
  owner_user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  data_quality_score INTEGER NOT NULL DEFAULT 0,
  confidence         TEXT NOT NULL DEFAULT 'unverified' CHECK (confidence IN ('unverified', 'low', 'medium', 'high')),
  last_verified_at   TEXT,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  deleted_at         TEXT
);
CREATE INDEX idx_companies_workspace ON companies(workspace_id, status, created_at);
CREATE INDEX idx_companies_name ON companies(workspace_id, normalized_name);
CREATE INDEX idx_companies_country ON companies(workspace_id, country);
CREATE UNIQUE INDEX idx_companies_domain ON companies(workspace_id, domain) WHERE domain IS NOT NULL AND domain <> '';

CREATE TABLE company_sources (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_type  TEXT NOT NULL,
  source_name  TEXT,
  source_url   TEXT,
  retrieved_at TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  confidence   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_company_sources_company ON company_sources(company_id);

-- ---------------------------------------------------------------- contacts
CREATE TABLE contacts (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  first_name       TEXT,
  last_name        TEXT,
  full_name        TEXT,
  title            TEXT,
  role_category    TEXT NOT NULL DEFAULT 'unknown' CHECK (role_category IN ('decision_maker', 'influencer', 'gatekeeper', 'technical', 'unknown')),
  email            TEXT,
  email_normalized TEXT,
  email_type       TEXT NOT NULL DEFAULT 'unknown' CHECK (email_type IN ('business', 'personal', 'role', 'inferred', 'unknown')),
  email_status     TEXT NOT NULL DEFAULT 'unverified' CHECK (email_status IN ('unverified', 'valid', 'risky', 'invalid', 'inferred')),
  phone            TEXT,
  linkedin_url     TEXT,
  country          TEXT,
  language         TEXT,
  department       TEXT,
  is_primary       INTEGER NOT NULL DEFAULT 0,
  confidence       TEXT NOT NULL DEFAULT 'unverified' CHECK (confidence IN ('unverified', 'low', 'medium', 'high')),
  last_verified_at TEXT,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_contacts_company ON contacts(company_id, is_primary);
CREATE INDEX idx_contacts_workspace ON contacts(workspace_id, email_status);
CREATE UNIQUE INDEX idx_contacts_email ON contacts(workspace_id, email_normalized) WHERE email_normalized IS NOT NULL AND email_normalized <> '';

CREATE TABLE contact_sources (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  contact_id   TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_type  TEXT NOT NULL,
  source_url   TEXT,
  method       TEXT NOT NULL DEFAULT 'manual' CHECK (method IN ('manual', 'import', 'crawl', 'inference', 'enrichment', 'provider')),
  retrieved_at TEXT NOT NULL,
  confidence   INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_contact_sources_contact ON contact_sources(contact_id);

CREATE TABLE data_verifications (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN ('company', 'contact')),
  entity_id    TEXT NOT NULL,
  check_type   TEXT NOT NULL,
  result       TEXT NOT NULL CHECK (result IN ('passed', 'failed', 'unknown')),
  confidence   INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}',
  verified_at  TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_verifications_entity ON data_verifications(workspace_id, entity_type, entity_id);

-- ------------------------------------------------------- matching / scoring
CREATE TABLE company_product_matches (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id   TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  match_score  INTEGER NOT NULL DEFAULT 0,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'rejected')),
  matched_by   TEXT NOT NULL DEFAULT 'rule' CHECK (matched_by IN ('rule', 'ai', 'user')),
  reviewed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (company_id, product_id)
);
CREATE INDEX idx_matches_workspace ON company_product_matches(workspace_id, status);

CREATE TABLE lead_scores (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  score         INTEGER NOT NULL DEFAULT 0,
  grade         TEXT NOT NULL DEFAULT 'C' CHECK (grade IN ('A', 'B', 'C', 'D')),
  factors_json  TEXT NOT NULL DEFAULT '[]',
  exclusions_json TEXT NOT NULL DEFAULT '[]',
  explanation   TEXT,
  model_version TEXT NOT NULL DEFAULT 'rules-v1',
  scored_at     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (workspace_id, company_id, product_id)
);
CREATE INDEX idx_scores_workspace ON lead_scores(workspace_id, score);

CREATE TABLE score_feedback (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id    TEXT REFERENCES products(id) ON DELETE SET NULL,
  field         TEXT NOT NULL,
  ai_value_json TEXT,
  user_value_json TEXT,
  reason        TEXT,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);

-- --------------------------------------------------------------- campaigns
CREATE TABLE campaigns (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  product_id       TEXT REFERENCES products(id) ON DELETE SET NULL,
  icp_id           TEXT REFERENCES icps(id) ON DELETE SET NULL,
  goal             TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'archived')),
  daily_limit      INTEGER NOT NULL DEFAULT 30,
  send_window_json TEXT NOT NULL DEFAULT '{}',
  require_approval INTEGER NOT NULL DEFAULT 1,
  created_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  deleted_at       TEXT
);
CREATE INDEX idx_campaigns_workspace ON campaigns(workspace_id, status);

CREATE TABLE campaign_steps (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id      TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_no          INTEGER NOT NULL,
  name             TEXT NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'email',
  subject_template TEXT NOT NULL DEFAULT '',
  body_template    TEXT NOT NULL DEFAULT '',
  language         TEXT NOT NULL DEFAULT 'en',
  delay_days       INTEGER NOT NULL DEFAULT 0,
  conditions_json  TEXT NOT NULL DEFAULT '{}',
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  UNIQUE (campaign_id, step_no)
);

CREATE TABLE campaign_targets (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  campaign_id       TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id        TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'enrolled' CHECK (status IN ('enrolled', 'active', 'paused', 'completed', 'replied', 'unsubscribed', 'bounced', 'failed')),
  current_step      INTEGER NOT NULL DEFAULT 0,
  enrolled_at       TEXT NOT NULL,
  next_run_at       TEXT,
  last_contacted_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX idx_targets_next_run ON campaign_targets(workspace_id, status, next_run_at);

-- ------------------------------------------------------------ email layer
CREATE TABLE email_accounts (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  address        TEXT NOT NULL,
  display_name   TEXT,
  protocol       TEXT NOT NULL DEFAULT 'smtp_imap' CHECK (protocol IN ('smtp_imap', 'simulation')),
  smtp_host      TEXT,
  smtp_port      INTEGER,
  smtp_secure    INTEGER NOT NULL DEFAULT 1,
  imap_host      TEXT,
  imap_port      INTEGER,
  imap_secure    INTEGER NOT NULL DEFAULT 1,
  username       TEXT,
  credential_enc TEXT,
  signature      TEXT,
  daily_limit    INTEGER NOT NULL DEFAULT 50,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'error')),
  last_sync_at   TEXT,
  last_error     TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, address)
);

CREATE TABLE email_threads (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id      TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
  company_id      TEXT REFERENCES companies(id) ON DELETE SET NULL,
  contact_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  subject         TEXT,
  last_message_at TEXT,
  message_count   INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'replied', 'closed', 'archived')),
  classification  TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_threads_workspace ON email_threads(workspace_id, last_message_at);
CREATE INDEX idx_threads_company ON email_threads(company_id);

CREATE TABLE email_messages (
  id                 TEXT PRIMARY KEY,
  workspace_id       TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  account_id         TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
  thread_id          TEXT REFERENCES email_threads(id) ON DELETE SET NULL,
  company_id         TEXT REFERENCES companies(id) ON DELETE SET NULL,
  contact_id         TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  direction          TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_address       TEXT,
  from_name          TEXT,
  to_addresses_json  TEXT NOT NULL DEFAULT '[]',
  cc_json            TEXT NOT NULL DEFAULT '[]',
  bcc_json           TEXT NOT NULL DEFAULT '[]',
  subject            TEXT,
  body_text          TEXT,
  body_html          TEXT,
  message_id_header  TEXT,
  in_reply_to        TEXT,
  references_json    TEXT NOT NULL DEFAULT '[]',
  sent_at            TEXT,
  received_at        TEXT,
  status             TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'bounced', 'received')),
  error              TEXT,
  is_read            INTEGER NOT NULL DEFAULT 0,
  raw_headers_json   TEXT NOT NULL DEFAULT '{}',
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_messages_thread ON email_messages(thread_id, created_at);
CREATE INDEX idx_messages_company ON email_messages(company_id, created_at);
CREATE INDEX idx_messages_workspace ON email_messages(workspace_id, direction, received_at);
CREATE UNIQUE INDEX idx_messages_dedupe ON email_messages(workspace_id, account_id, message_id_header) WHERE message_id_header IS NOT NULL AND message_id_header <> '';

CREATE TABLE message_drafts (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id        TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  campaign_id       TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_step_id  TEXT REFERENCES campaign_steps(id) ON DELETE SET NULL,
  account_id        TEXT REFERENCES email_accounts(id) ON DELETE SET NULL,
  subject           TEXT NOT NULL DEFAULT '',
  body_text         TEXT NOT NULL DEFAULT '',
  language          TEXT NOT NULL DEFAULT 'en',
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected', 'scheduled', 'sent', 'failed', 'discarded')),
  generated_by      TEXT REFERENCES agent_executions(id) ON DELETE SET NULL,
  quality_json      TEXT NOT NULL DEFAULT '{}',
  guard_json        TEXT NOT NULL DEFAULT '{}',
  approved_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at       TEXT,
  scheduled_at      TEXT,
  sent_message_id   TEXT REFERENCES email_messages(id) ON DELETE SET NULL,
  rejection_reason  TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_drafts_workspace ON message_drafts(workspace_id, status, created_at);
CREATE INDEX idx_drafts_company ON message_drafts(company_id);

CREATE TABLE conversation_classifications (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  thread_id           TEXT REFERENCES email_threads(id) ON DELETE CASCADE,
  message_id          TEXT REFERENCES email_messages(id) ON DELETE CASCADE,
  company_id          TEXT REFERENCES companies(id) ON DELETE CASCADE,
  contact_id          TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  label               TEXT NOT NULL CHECK (label IN ('positive_interest', 'price_inquiry', 'quote_request', 'sample_request', 'technical_question', 'follow_up_needed', 'no_need_now', 'rejection', 'unsubscribe', 'auto_reply', 'unknown')),
  confidence          REAL NOT NULL DEFAULT 0,
  intent_score        INTEGER NOT NULL DEFAULT 0,
  evidence_json       TEXT NOT NULL DEFAULT '[]',
  rationale           TEXT,
  suggested_reply     TEXT,
  status              TEXT NOT NULL DEFAULT 'ai_suggested' CHECK (status IN ('ai_suggested', 'user_confirmed', 'user_corrected')),
  agent_execution_id  TEXT REFERENCES agent_executions(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_classifications_workspace ON conversation_classifications(workspace_id, label, created_at);

-- -------------------------------------------------------------------- CRM
CREATE TABLE deals (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id          TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  product_id          TEXT REFERENCES products(id) ON DELETE SET NULL,
  title               TEXT NOT NULL,
  stage               TEXT NOT NULL DEFAULT 'lead' CHECK (stage IN ('lead', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
  value_amount        REAL,
  currency            TEXT NOT NULL DEFAULT 'EUR',
  probability         INTEGER,
  expected_close_date TEXT,
  status              TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  lost_reason         TEXT,
  owner_user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  closed_at           TEXT
);
CREATE INDEX idx_deals_workspace ON deals(workspace_id, stage);

CREATE TABLE sales_activities (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id   TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  deal_id      TEXT REFERENCES deals(id) ON DELETE CASCADE,
  type         TEXT NOT NULL CHECK (type IN ('email', 'call', 'meeting', 'note', 'task', 'system')),
  subject      TEXT,
  body         TEXT,
  occurred_at  TEXT NOT NULL,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_activities_company ON sales_activities(company_id, occurred_at);

CREATE TABLE follow_up_tasks (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id   TEXT REFERENCES companies(id) ON DELETE CASCADE,
  contact_id   TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  campaign_id  TEXT REFERENCES campaigns(id) ON DELETE SET NULL,
  deal_id      TEXT REFERENCES deals(id) ON DELETE SET NULL,
  due_at       TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'follow_up' CHECK (type IN ('follow_up', 'email', 'call', 'review', 'reminder')),
  title        TEXT NOT NULL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'cancelled', 'skipped')),
  assigned_to  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_followups_due ON follow_up_tasks(workspace_id, status, due_at);
CREATE INDEX idx_followups_company ON follow_up_tasks(company_id);

-- ------------------------------------------------- automation & suppression
CREATE TABLE automation_states (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  state        TEXT NOT NULL DEFAULT 'AUTOMATION_ACTIVE' CHECK (state IN ('AUTOMATION_ACTIVE', 'NEEDS_HUMAN_REVIEW', 'HUMAN_TAKEOVER', 'PAUSED', 'DO_NOT_CONTACT', 'CLOSED')),
  reason       TEXT,
  changed_by   TEXT,
  changed_at   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  UNIQUE (workspace_id, company_id)
);
CREATE INDEX idx_automation_state ON automation_states(workspace_id, state);

CREATE TABLE suppression_records (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope            TEXT NOT NULL CHECK (scope IN ('email', 'domain')),
  value_normalized TEXT NOT NULL,
  reason           TEXT NOT NULL CHECK (reason IN ('unsubscribe', 'hard_bounce', 'complaint', 'manual', 'do_not_contact', 'gdpr_request')),
  source           TEXT,
  note             TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL,
  UNIQUE (workspace_id, scope, value_normalized)
);
CREATE INDEX idx_suppression_lookup ON suppression_records(workspace_id, scope, value_normalized);

-- ------------------------------------------------------ credentials/providers
CREATE TABLE integration_credentials (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('ai_provider', 'data_provider', 'email_api', 'webhook')),
  provider_key   TEXT NOT NULL,
  label          TEXT,
  credential_enc TEXT NOT NULL,
  config_json    TEXT NOT NULL DEFAULT '{}',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'error')),
  last_checked_at TEXT,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (workspace_id, kind, provider_key)
);

CREATE TABLE external_providers (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  name              TEXT NOT NULL,
  category          TEXT NOT NULL CHECK (category IN ('search', 'enrichment', 'verification', 'ai', 'email')),
  adapter           TEXT NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  cost_model        TEXT,
  config_json       TEXT NOT NULL DEFAULT '{}',
  is_enabled        INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE (workspace_id, key)
);

-- ---------------------------------------------------------- agent executions
CREATE TABLE agent_executions (
  id             TEXT PRIMARY KEY,
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_role     TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input_json     TEXT NOT NULL DEFAULT '{}',
  output_json    TEXT NOT NULL DEFAULT '{}',
  prompt_version TEXT,
  provider       TEXT,
  model          TEXT,
  tokens_in      INTEGER NOT NULL DEFAULT 0,
  tokens_out     INTEGER NOT NULL DEFAULT 0,
  cost_estimate  REAL NOT NULL DEFAULT 0,
  latency_ms     INTEGER,
  error          TEXT,
  job_id         TEXT,
  created_by     TEXT,
  started_at     TEXT,
  finished_at    TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_agent_exec_workspace ON agent_executions(workspace_id, created_at);

-- ------------------------------------------------------------ background jobs
CREATE TABLE background_jobs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'dead')),
  priority      INTEGER NOT NULL DEFAULT 100,
  attempts      INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  run_at        TEXT NOT NULL,
  started_at    TEXT,
  finished_at   TEXT,
  lease_until   TEXT,
  worker_id     TEXT,
  dedupe_key    TEXT,
  last_error    TEXT,
  result_json   TEXT NOT NULL DEFAULT '{}',
  cost_estimate REAL NOT NULL DEFAULT 0,
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_jobs_claim ON background_jobs(status, run_at, priority);
CREATE INDEX idx_jobs_workspace ON background_jobs(workspace_id, status, created_at);
CREATE UNIQUE INDEX idx_jobs_dedupe ON background_jobs(dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key <> '';

CREATE TABLE usage_records (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  category          TEXT NOT NULL CHECK (category IN ('ai_tokens', 'email_sent', 'data_lookup', 'agent_run', 'crawl')),
  agent_role        TEXT,
  provider          TEXT,
  model             TEXT,
  quantity          REAL NOT NULL DEFAULT 0,
  unit              TEXT NOT NULL DEFAULT 'count',
  cost_estimate     REAL NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'USD',
  job_id            TEXT,
  agent_execution_id TEXT,
  occurred_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_usage_workspace ON usage_records(workspace_id, occurred_at);

CREATE TABLE audit_events (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'agent', 'system', 'api_key', 'anonymous')),
  actor_id     TEXT,
  action       TEXT NOT NULL,
  entity_type  TEXT,
  entity_id    TEXT,
  before_json  TEXT,
  after_json   TEXT,
  ip           TEXT,
  user_agent   TEXT,
  request_id   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_audit_workspace ON audit_events(workspace_id, created_at);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);

CREATE TABLE legal_basis_records (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_id    TEXT REFERENCES companies(id) ON DELETE CASCADE,
  contact_id    TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  basis         TEXT NOT NULL CHECK (basis IN ('legitimate_interest', 'consent', 'contract', 'legal_obligation')),
  source        TEXT,
  note          TEXT,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  recorded_by   TEXT,
  recorded_at   TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_legal_contact ON legal_basis_records(contact_id);

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  body         TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'success', 'warning', 'critical')),
  read_at      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_notifications_workspace ON notifications(workspace_id, read_at, created_at);

CREATE TABLE import_runs (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('companies', 'contacts', 'suppression')),
  filename      TEXT,
  total_rows    INTEGER NOT NULL DEFAULT 0,
  created_count INTEGER NOT NULL DEFAULT 0,
  updated_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  errors_json   TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  finished_at   TEXT
);

CREATE TABLE discovery_runs (
  id               TEXT PRIMARY KEY,
  workspace_id     TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  query_json       TEXT NOT NULL DEFAULT '{}',
  provider         TEXT,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result_count     INTEGER NOT NULL DEFAULT 0,
  companies_created INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  started_at       TEXT,
  finished_at      TEXT,
  created_by       TEXT,
  created_at       TEXT NOT NULL
);
CREATE INDEX idx_discovery_workspace ON discovery_runs(workspace_id, created_at);
