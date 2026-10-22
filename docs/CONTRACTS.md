# 内部开发契约（CONTRACTS）

> 本文件是团队并行开发的唯一接口契约。所有模块必须按本文件实现；需要变更时先通知 Lead，不得私自修改他人文件或共享核心。

## 0. 工作目录与硬性规则

- **唯一开发目录：`C:\zhirai-stage\platform`**（NTFS 暂存区）。
  - 最终交付会由 Lead 同步到 `E:\欧洲 B2B AI 外贸获客平台`。
  - **不要直接写 `E:\…`**：该盘为 exFAT，`write`/`edit` 会报 EISDIR。所有读写使用 `C:\zhirai-stage\platform\...` 绝对路径。
- 运行 `node server/index.mjs` 的 4173 服务由 Lead 持有；**不要启动/重启 4173**，需要跑服务时用临时端口与临时数据库（见 `tests/helpers.mjs`）。
- 技术约束：Node >= 22.5、纯 ESM、**零第三方运行时依赖**（只用 `node:*`）。不复制任何开源项目代码；参考项目只用于理解功能（见方案文档）。代码注释英文，界面文案中文。
- 只修改自己拥有的文件（见第 2 节）。共享文件（`server/core/**`、`server/config.mjs`、`server/app.mjs`、`server/index.mjs`、`server/routes/index.mjs`、`package.json`、`index.html`、`docs/CONTRACTS.md`、`src/app/**`、`src/components/**`、`src/styles/**`）由 Lead 维护；需要改动先给 Lead 发消息。
- 每个后端模块 **必须写测试**（`node:test`），至少覆盖正常路径 + 权限/租户隔离。
- 完成后向 Lead 汇报：新增/修改文件、已实现 API、测试命令与结果、未完成或风险。

## 1. 分层与目录

```
server/
  index.mjs app.mjs config.mjs
  core/            # Lead：基础设施（db/http/auth/crypto/audit/validate/...）
  db/migrations/   # Lead：数据库 schema
  repositories/    # 按实体：只做 SQL + 行映射，必须带 workspace_id
  services/        # 业务规则、事务、审计、通知、入队
  routes/          # HTTP 路由，薄层：校验输入 → 调 service → 返回数据
  agents/          # t-agents：模型 Provider、提示词、角色 Agent
  jobs/            # t-worker：任务队列、Worker、调度、发送管线
  mail/            # t-worker：SMTP / MIME / IMAP / 模拟邮箱
tests/
  helpers.mjs      # Lead：临时数据库 + 测试服务端
  unit/            # 纯函数/服务测试
  integration/     # HTTP 级测试（含权限、隔离）
src/               # 前端（Lead 外壳 + t-front-* 页面）
```

## 2. 文件所有权

| 范围 | Owner |
| --- | --- |
| `server/core/**`, `server/config.mjs`, `server/app.mjs`, `server/index.mjs`, `server/routes/index.mjs`, `server/db/**`, `scripts/init-db.mjs`, `scripts/seed-demo.mjs`, `tests/helpers.mjs`, `src/app/**`, `src/components/**`, `src/styles/**`, `src/utils/**`, `index.html`, `admin/**`, `manifest.webmanifest`, `docs/CONTRACTS.md`, 根目录文件 | Lead |
| `server/repositories/{companies,contacts,products,icps,discovery,scoring,imports}.mjs` `server/services/{companies,contacts,products,icps,discovery,enrichment,scoring,verification,imports,exports}.mjs` `server/routes/{companies,contacts,products,icps,discovery,imports}.mjs` `tests/**/data-*.test.mjs` | t-data |
| `server/repositories/{campaigns,email,drafts,deals,automation,suppression}.mjs` `server/services/{campaigns,drafts,inbox,replies,followups,deals,automation,suppression,email-accounts,dashboard}.mjs` `server/routes/{campaigns,drafts,inbox,deals,automation,suppression,email-accounts,dashboard}.mjs` `tests/**/crm-*.test.mjs` | t-crm |
| `server/agents/**` `server/routes/agents.mjs` `tests/**/agents-*.test.mjs` | t-agents |
| `server/jobs/**` `server/mail/**` `server/routes/jobs.mjs` `tests/**/jobs-*.test.mjs` `tests/**/mail-*.test.mjs` | t-worker |
| `src/pages/{dashboard,discovery,companies,company-detail,contacts,products,icps}.js` `src/styles/pages-data.css` `tests/**/frontend-data-*.test.mjs` | t-front-data |
| `src/pages/{campaigns,drafts,inbox,deals,automation,agents,jobs,settings}.js` `src/styles/pages-outreach.css` | t-front-outreach |
| `docs/**`（除 CONTRACTS.md） | t-docs |
| `README.md`, `DEPLOY.md`, `CHANGELOG.md` | t-docs + Lead 审核 |

新增文件允许放在自己范围内；`server/repositories/helpers.mjs` 为 Lead 提供的通用工具。

## 3. 核心 API（Lead 已实现，直接使用）

### 3.1 数据库 `server/core/db.mjs`

```js
import { all, get, run, exec, tx, json, parseJson, upsertSetting } from '../core/db.mjs';
all(sql, params)  // 返回行数组
get(sql, params)  // 单行或 null
run(sql, params)  // {changes,lastInsertRowid}
tx(fn)            // 同步事务（BEGIN IMMEDIATE），fn 内不要 async
```

**租户规则**：任何业务表 SQL 必须同时过滤 `workspace_id = ?`；跨工作空间访问在 repository 层返回 null/空。

### 3.2 错误 `server/core/errors.mjs`

```js
import { badRequest, validationError, unauthorized, forbidden, notFound, conflict, tooManyRequests } from '../core/errors.mjs';
throw notFound('客户不存在');
```

### 3.3 校验 `server/core/validate.mjs`

`validateInput(body, schema)`、`asString/asInt/asBool/asEnum/asEmail/asDomain/asArray/asObject/asIsoDate/asCountry`、`parsePagination(query)`、`parseSort(query, allowMap, fallback)`、`normalizeEmail/normalizeDomain/normalizeName`、`escapeLike`。

### 3.4 时间 / ID / 加密

```js
import { nowIso, addDays, addHours, dayKey, zonedParts } from '../core/time.mjs';
import { id } from '../core/ids.mjs';              // id('cmp') -> cmp_…
import { sha256Hex, randomToken, signToken, verifyToken, encryptCredential, decryptCredential } from '../core/crypto.mjs';
import { getSecret } from '../core/secrets.mjs';   // 进程级密钥（已初始化）
```

### 3.5 审计 / 通知

```js
import { recordAudit } from '../core/audit.mjs';
recordAudit({ workspaceId, actorType:'user'|'agent'|'system'|'api_key', actorId, action:'company.update',
  entityType:'company', entityId, before:{}, after:{}, ip, userAgent, requestId });
```

`before/after` 会自动脱敏（password/token/secret/api_key）。

```js
import { createNotification, notifyHighIntent } from '../services/notifications.mjs';
```

### 3.6 设置 / 凭据 `server/services/settings.mjs`

```js
getSettings(workspaceId)         // 合并默认值的 6 组设置
getSetting(workspaceId, 'outreach'|'limits'|'retention'|'ai'|'compliance'|'enrichment')
updateSettings(workspaceId, patch, { actorId })
listProviders(workspaceId)       // 外部数据源目录（含 isEnabled/config）
getCredential(workspaceId, kind, providerKey)  // {record, secret:{}, config:{}} | null
saveCredential(workspaceId, kind, providerKey, {label, secret, config}, {actorId})
```

`kind ∈ ai_provider | data_provider | email_api | webhook`。**密钥只能服务端读取，任何 API 响应不得返回明文**。

### 3.7 HTTP 上下文 `ctx`

路由模块写法：

```js
export function mount(router) {
  router.get('/api/v1/things', async (ctx) => ({ items: [] }), { auth: 'required', capability: 'data.read' });
  router.post('/api/v1/things', async (ctx) => { const body = ctx.body || {}; ...; return { id }; }, { auth: 'required' });
}
```

- 返回值自动包成 `{ ok:true, data }`；`ctx.ok(data, status)` / `ctx.json(raw, status)`（公开页面用）。
- `ctx.params`, `ctx.query` (URLSearchParams), `ctx.body`, `ctx.user`, `ctx.workspace`, `ctx.membership`, `ctx.authType`, `ctx.ip`, `ctx.requestId`, `ctx.config`, `ctx.db`。
- 路由选项：`{ auth:'required'|'optional'|'public', capability:'data.read', csrf:false, rateLimit:{windowMs,max}, maxBodyBytes }`。
- 权限 capability 见 `server/core/auth.mjs`；`viewer` 只读，`member` 可写业务数据，`admin/owner` 管理设置/成员/凭据，`owner` 备份/删除工作空间。
- 角色/权限一律服务端校验，禁止信任前端传的 role/workspaceId。

### 3.8 任务入队 `server/jobs/queue.mjs`（t-worker 实现，其他模块按此调用）

```js
enqueueJob({ workspaceId, type, payload = {}, dedupeKey = null, runAt = null, priority = 100, maxAttempts = 3, createdBy = null })
// -> { id, deduped:boolean }
cancelJobsForCompany(workspaceId, companyId, reason)
cancelJob(workspaceId, jobId)
getJobStats(workspaceId)
```

`dedupeKey` 全局唯一（建议 `${type}:${workspaceId}:${entityId}`）。任务类型固定列表见第 6 节。

## 4. 数据库约束（由 Lead 维护，字段名以此为准）

- 表清单见 `server/db/migrations/001_init.sql`。所有业务表：`id TEXT PK`、`workspace_id`、`created_at`/`updated_at`（ISO 字符串）。
- 关键唯一约束：
  - `companies(workspace_id, domain)` 唯一（domain 非空）
  - `contacts(workspace_id, email_normalized)` 唯一（非空）
  - `suppression_records(workspace_id, scope, value_normalized)` 唯一
  - `automation_states(workspace_id, company_id)` 唯一
  - `campaign_targets(campaign_id, contact_id)` 唯一
  - `email_messages(workspace_id, account_id, message_id_header)` 唯一（非空）
  - `background_jobs(dedupe_key)` 唯一（非空）
  - `settings(workspace_id, key)` 主键
- JSON 列以 `_json` 结尾；服务层用 `JSON.parse`/`JSON.stringify`。
- 时间统一 ISO UTC 字符串（`nowIso()`）。

## 5. 业务不变量（必须实现）

1. **人工接管**：`automation_states` 为 `HUMAN_TAKEOVER` / `DO_NOT_CONTACT` / `PAUSED` / `CLOSED` 时，**发送管线必须拒绝发送**；接管时原子更新状态 + 取消该客户未发送的 `follow_up_tasks` 与 `background_jobs`（调用 `cancelJobsForCompany`）+ 审计。恢复自动化只允许从 `HUMAN_TAKEOVER`/`PAUSED`/`NEEDS_HUMAN_REVIEW` → `AUTOMATION_ACTIVE`；`DO_NOT_CONTACT` 必须先由 admin/owner 删除 suppression 记录。
2. **退订/拒绝联系**：suppression 命中（邮箱或域名）时禁止任何发送；退订写入 `suppression_records(reason='unsubscribe')` 并置 `DO_NOT_CONTACT`。
3. **发送前检查**（t-worker）：草稿已审批、退订/抑制名单、自动化状态、全局发送暂停（`settings.outreach.autoSendEnabled` 与 `config.globalSendPaused`）、发送时间窗（Europe/Berlin 默认）、账号/工作空间日限额、重复发送、退信熔断。人工审批默认开启。
4. **不伪造事实**：产品认证/产能/价格/案例只能来自产品资料库或用户输入；Agent 提示词必须约束；草稿保存 `guard_json`/`quality_json` 以便追溯。
5. **邮箱可信度**：推测邮箱只能标记 `email_status='inferred'`，不得标记 valid；MX 校验结果单独记录在 `data_verifications`。
6. **来源可追溯**：企业/联系人外部数据必须写 `company_sources` / `contact_sources`（source_type、url、retrieved_at、confidence）。
7. **AI 输出必须结构化校验**（t-agents），失败重试一次后报错；每次执行写 `agent_executions` + `usage_records`。

## 6. 任务类型（t-worker 实现，其他模块只入队）

| type | payload | 说明 |
| --- | --- | --- |
| `discovery.search` | `{ discoveryRunId }` | t-data 执行发现搜索 |
| `company.crawl` | `{ companyId, urls? }` | 抓取企业官网并抽取信息 |
| `company.enrich` | `{ companyId }` | 补全企业/联系人（含邮箱推断） |
| `contact.verify` | `{ contactId }` | 邮箱语法 + MX 校验 |
| `lead.score` | `{ companyId, productId }` | 规则评分 + 匹配原因 |
| `draft.generate` | `{ draftId }` | t-crm 生成开发信草稿（调用 t-agents） |
| `email.send` | `{ draftId }` | 发送管线（审批/抑制/窗口/限额/接管检查） |
| `email.sync` | `{ accountId }` | IMAP/模拟收件箱同步 |
| `reply.classify` | `{ messageId }` | 回复分类 + 意向 + 通知 + 自动化状态 |
| `followup.plan` | `{ threadId, messageId }` | 生成跟进建议/任务 |
| `campaign.tick` | `{ campaignId }` | 推进活动目标 |
| `maintenance.retention` | `{}` | 数据保留清理 |

## 7. 跨模块服务函数契约

其他模块只通过以下函数调用（签名固定）：

### 7.1 t-data

```js
// server/services/discovery.mjs
executeDiscoveryRun(workspaceId, discoveryRunId, { actorId }) -> { companiesCreated, resultCount }
// server/services/enrichment.mjs
enrichCompany({ workspaceId, companyId, actorId }) -> { updated, contactsCreated, emailsFound }
// server/services/verification.mjs
verifyContactEmail({ workspaceId, contactId, actorId }) -> { emailStatus, mx, checkedAt }
inferEmails({ workspaceId, companyId, firstName, lastName }) -> [{ email, status:'inferred', confidence }]
// server/services/scoring.mjs
scoreCompany({ workspaceId, companyId, productId, actorId }) -> { score, grade, factors, exclusions, explanation }
// server/services/companies.mjs
getCompanyDetail(workspaceId, companyId) -> 聚合详情对象（见路由）
```

### 7.2 t-crm

```js
// server/services/drafts.mjs
generateDraft({ workspaceId, draftId, actorType, actorId }) -> { draft }
// server/services/replies.mjs
classifyInboundMessage({ workspaceId, messageId, actorType }) -> { classification, automationState }
// server/services/followups.mjs
planFollowUpForThread({ workspaceId, threadId, messageId, actorType }) -> { taskId }
// server/services/campaigns.mjs
advanceAfterSend({ workspaceId, campaignId, contactId, draftId }) -> void   // 发送成功后推进步骤
getCampaignSendContext(workspaceId, draft) -> { campaign, step, target } | null
// server/services/email-accounts.mjs
loadSendAccount(workspaceId, accountId) -> { account, secret, config } | null
markAccountSynced(workspaceId, accountId, { error })
```

### 7.3 t-agents

```js
// server/agents/index.mjs
AGENT_CATALOG                                   // [{ role, name, nameZh, description, promptVersion, capabilities, inputFields }]
runAgent({ workspaceId, role, input, actorType, actorId, jobId, createdBy }) -> { executionId, output, usage }
testProvider({ workspaceId }) -> { ok, provider, model, latencyMs, sample }
generateOutreachDraft({ workspaceId, context, language }) -> output
qualifyCompany({ workspaceId, context }) -> output
classifyReply({ workspaceId, context }) -> output
planFollowUp({ workspaceId, context }) -> output
companyResearch({ workspaceId, context }) -> output
matchProduct({ workspaceId, context }) -> output
complianceCheck({ workspaceId, context }) -> output
reviewQuality({ workspaceId, context }) -> output
```

## 8. API 路径约定（后端 owner 实现）

统一前缀 `/api/v1`。列表响应 `{ items, total, page, pageSize }`；详情返回对象。

- **t-data**：`/companies`（GET/POST）、`/companies/:id`（GET/PATCH/DELETE）、`/companies/:id/score|enrich|crawl|timeline|contacts`、`/companies/bulk`、`/contacts`…、`/products`…、`/icps`…、`/discovery/runs`…、`/imports`…、`/export/companies`。
- **t-crm**：`/dashboard/summary|activity|alerts`、`/campaigns`…（含 steps/enroll/pause/resume/stats）、`/drafts`…（generate/approve/reject/send/batch-approve）、`/inbox/threads`、`/threads/:id`、`/threads/:id/reply|classification|takeover`、`/deals`、`/deals/pipeline`、`/activities`、`/follow-up-tasks`、`/automation/...`、`/suppression`、`/email-accounts`…
- **t-agents**：`/agents`、`/agents/executions`、`/agents/executions/:id`、`/agents/test-provider`、`/agents/run`。
- **t-worker**：`/jobs`、`/jobs/:id`、`/jobs/:id/cancel`、`/jobs/:id/retry`、`/jobs/stats`、`/jobs/pause`、`/jobs/resume`。

所有写操作必须在 service 层写审计（关键动作）：创建/更新/删除企业、联系人、产品、ICP、活动、草稿审批、发送、接管、恢复、退订、导入、评分、Agent 执行。
所有列表必须支持 `page/pageSize`（默认 25，最大 100）。

## 9. 测试约定

- 运行：`node --test tests`（或 `node --test tests/unit/xxx.test.mjs`）。
- 使用 `tests/helpers.mjs`：

```js
import { createTestContext } from '../helpers.mjs';
const ctx = await createTestContext();          // 临时数据目录 + 迁移 + 初始化工作空间 + 启动随机端口服务
await ctx.close();
const res = await ctx.request('POST', '/api/v1/companies', { body: {...}, csrf: true });
// res.status, res.body, res.cookies；ctx.login()/ctx.user/ctx.workspace
```

- 测试不得依赖 4173 服务、不得写 `server/data`；使用临时目录。
- 必须测试租户隔离：工作空间 A 的用户不能读到 B 的企业/草稿。

## 10. 汇报格式

1. 完成内容（按文件/API）。
2. 测试命令 + 通过数量 + 失败/跳过原因。
3. 已知缺口、需要 Lead 协调的事项。
4. 不要声称未验证的功能已完成；不要伪造测试结果。
