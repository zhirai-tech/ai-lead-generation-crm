# REST API 文档（API Reference）

> 项目：ZHIRAI Europe B2B AI Outreach Platform v1.0.0
> 作者：ZHIRAI · 智睿科技 · 独立开发者
> 事实来源：`server/routes/**` 实际实现（2026-10-22 核对）。示例响应用隔离测试实例（临时数据库 + 临时端口）实跑采集，字段按实际返回整理；敏感值已用占位符替换。
> 机器可读描述：[openapi.yaml](./openapi.yaml)（覆盖核心端点；未覆盖范围见 §10）。

---

## 目录

- [1. 基础约定](#1-基础约定)
- [2. 认证与 CSRF](#2-认证与-csrf)
- [3. 错误格式与错误码](#3-错误格式与错误码)
- [4. 分页、排序、筛选](#4-分页排序筛选)
- [5. 权限矩阵](#5-权限矩阵)
- [6. 端点总览](#6-端点总览)
- [7. 认证与工作空间](#7-认证与工作空间)
- [8. 业务端点（按域）](#8-业务端点按域)
- [9. 公开端点](#9-公开端点)
- [10. 覆盖范围与已知差异](#10-覆盖范围与已知差异)

---

## 1. 基础约定

| 项 | 值 |
| --- | --- |
| Base URL | `https://<你的域名>`（本地 `http://127.0.0.1:4173`） |
| API 前缀 | `/api/v1` |
| 请求体 | `application/json`（导入支持 `text/csv`、`text/plain`） |
| 响应体 | `application/json; charset=utf-8`，`Cache-Control: no-store` |
| 成功信封 | `{ "ok": true, "data": ... }` |
| 失败信封 | `{ "ok": false, "error": { "code": "...", "message": "...", "details": ... } }` |
| 时间格式 | ISO-8601 UTC 字符串（`2026-10-22T19:08:45.347Z`） |
| ID 格式 | 前缀 ULID：`cmp_…` 企业、`ctc_…` 联系人、`prd_…` 产品、`icp_…` ICP、`drf_…` 草稿、`dr_…` 发现、`job_…` 任务、`acc_…` 邮箱、`sup_…` 抑制、`aut_…` 自动化、`usr_…` 用户、`wsp_…` 工作空间 |
| 请求体上限 | 默认 1.5 MB（`413 PAYLOAD_TOO_LARGE`） |
| CORS | **不启用**（同源专用） |
| 安全响应头 | CSP、`X-Frame-Options: DENY`、`nosniff` 等（见 [SECURITY.md](./SECURITY.md)） |

**列表响应**统一为：

```json
{ "ok": true, "data": { "items": [], "total": 0, "page": 1, "pageSize": 25, "hasMore": false } }
```

> 个别端点（`/automation/states`、`/campaigns/:id/targets` 等）返回 `{items,total,page,pageSize}` 但不含 `hasMore`；以本文各端点说明为准。

---

## 2. 认证与 CSRF

### 2.1 浏览器会话（主）

1. `POST /auth/setup`（首次）或 `POST /auth/login`。
2. 服务端 `Set-Cookie`：
   - `zr_session`：**HttpOnly**、`SameSite=Lax`、`Path=/`；`PUBLIC_BASE_URL` 为 https 时加 `Secure`。
   - `zr_csrf`：可被 JS 读取；`SameSite=Lax`。
3. 之后每个请求自动携带 Cookie（同源 `credentials: 'same-origin'`）。
4. **所有非 GET/HEAD/OPTIONS 请求**（除公开路径）必须带 `X-CSRF-Token: <zr_csrf 值>`。
5. 请求带 `Origin` 时，其 host 必须等于 `Host`（或 `X-Forwarded-Host`，当 `TRUST_PROXY=1`）。

### 2.2 API Key（自动化）

```http
Authorization: Bearer <你的 API Key（以 zrk_ 开头，仅在创建时显示一次）>
```

- 创建：`POST /api/v1/auth/api-keys`（需 `credentials.manage`），**明文只返回一次**。
- 权限等同所属用户在当前工作空间的角色；API Key 请求无需 CSRF。
- 仅存 SHA-256 哈希；可吊销。

### 2.3 公开路径（无需登录/CSRF）

`/api/v1/health`、`/auth/status`、`/auth/setup`、`/auth/login`、`/public/*`。
`POST /auth/logout` 允可选认证且 `csrf:false`。

---

## 3. 错误格式与错误码

```json
{
  "ok": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "企业名称不能为空",
    "details": { "field": "name" }
  }
}
```

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | 参数/格式错误 |
| 403 | `FORBIDDEN` | 无权限（capability 不足） |
| 403 | `CSRF_FAILED` | CSRF/Origin 校验失败 |
| 404 | `NOT_FOUND` | 资源不存在或不属于当前工作空间 |
| 405 | `METHOD_NOT_ALLOWED` | 方法不支持 |
| 409 | `CONFLICT` | 状态冲突（如活动未启用不能发送） |
| 413 | `PAYLOAD_TOO_LARGE` / `AGENT_INPUT_TOO_LARGE` | 请求体过大 |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | Content-Type 不支持 |
| 422 | `VALIDATION_ERROR` | 业务校验失败 |
| 429 | `RATE_LIMITED` | 触发限流（响应头 `Retry-After`） |
| 500 | `INTERNAL_ERROR` | 未预期异常（不返回堆栈） |
| 501 | `NOT_IMPLEMENTED` | 功能未实现 |

**冲突细节示例**（实跑采集）：

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "活动未启用，不能发送该草稿",
    "details": { "code": "CAMPAIGN_NOT_ACTIVE", "status": "draft" }
  }
}
```

---

## 4. 分页、排序、筛选

| 参数 | 说明 |
| --- | --- |
| `page` | 页码，从 1 开始（默认 1，上限 100000） |
| `pageSize` | 每页数量（默认 25，最大 100） |
| `sort` | 排序字段（各端点白名单不同，如 `createdAt`、`score`、`name`） |
| `order` | `asc` / `desc`（默认 `desc`） |
| `q` / `search` | 关键词搜索（企业名/联系人/标题等，具体见端点） |

- 排序字段不在白名单时回退默认排序；列名不会拼接进 SQL（服务层白名单映射）。
- 多值筛选使用逗号分隔（如 `?country=DE,FR&status=new,qualified`）。

---

## 5. 权限矩阵

角色与 capability 由服务端强制（`server/core/auth.mjs`）。端点所需 capability 见各节标注；角色 → capability 如下：

| capability | viewer | member | admin | owner | 主要端点 |
| --- | :-: | :-: | :-: | :-: | --- |
| `data.read` | ✅ | ✅ | ✅ | ✅ | 所有 GET 业务数据 |
| `data.write` | ❌ | ✅ | ✅ | ✅ | 企业/联系人/产品/ICP/草稿 CRUD、评分、抓取 |
| `data.delete` | ❌ | ❌ | ✅ | ✅ | 删除企业/联系人/产品/ICP/商机；批量归档 |
| `import.run` | ❌ | ✅ | ✅ | ✅ | `POST /imports` |
| `export.run` | ❌ | ✅ | ✅ | ✅ | `GET /export/companies` |
| `discovery.run` | ❌ | ✅ | ✅ | ✅ | 发现、补全、抓取、邮箱推断 |
| `agents.run` | ❌ | ✅ | ✅ | ✅ | `POST /agents/run` |
| `campaigns.write` | ❌ | ✅ | ✅ | ✅ | 活动与步骤 |
| `drafts.approve` | ❌ | ✅ | ✅ | ✅ | 审批/驳回/发送/批量审批 |
| `deals.write` | ❌ | ✅ | ✅ | ✅ | 商机/活动记录/跟进任务 |
| `automation.manage` | ❌ | ✅ | ✅ | ✅ | 接管/恢复/暂停/关闭 |
| `suppression.write` | ❌ | ✅ | ✅ | ✅ | 抑制名单、`do-not-contact` |
| `email.sync` | ❌ | ✅ | ✅ | ✅ | 手动同步邮箱 |
| `email.accounts.manage` | ❌ | ❌ | ✅ | ✅ | 邮箱账户增删改/测试连接 |
| `settings.read` | ✅ | ✅ | ✅ | ✅ | 设置读取、数据源目录、Agent 目录/执行记录 |
| `settings.manage` | ❌ | ❌ | ✅ | ✅ | 修改设置、数据源开关 |
| `credentials.manage` | ❌ | ❌ | ✅ | ✅ | 集成凭据、API Key |
| `members.manage` | ❌ | ❌ | ✅ | ✅ | 成员增删改 |
| `workspace.read` | ✅ | ✅ | ✅ | ✅ | `GET /workspace` |
| `workspace.update` | ❌ | ❌ | ✅ | ✅ | `PATCH /workspace` |
| `workspace.delete` | ❌ | ❌ | ❌ | ✅ | （v1.0 未开放 API） |
| `audit.read` | ❌ | ❌ | ✅ | ✅ | 审计、系统状态、日志 |
| `jobs.read` | ✅ | ✅ | ✅ | ✅ | 任务列表/详情/统计 |
| `jobs.manage` | ❌ | ❌ | ✅ | ✅ | 任务取消/重试/全局暂停 |
| `backup.run` | ❌ | ❌ | ❌ | ✅ | 备份创建/下载 |

> `auth: 'required'` 但未声明 capability 的端点（如 `GET /workspace`、`GET /auth/sessions`）只要求登录。

---

## 6. 端点总览

> 实测（2026-10-22，`buildRouter()` 导出的路由表）：**共 154 个「方法 × 路径」路由**。

| 域 | 端点数 | 路径前缀 |
| --- | --- | --- |
| 认证 | 11 | `/auth/*` |
| 工作空间 | 6 | `/workspace*` |
| 设置/凭据/数据源 | 7 | `/settings*`、`/providers` |
| 审计/通知/用量/运维 | 10 | `/audit`、`/notifications*`、`/usage`、`/ops/*` |
| 企业 | 14 | `/companies*` |
| 联系人 | 8 | `/contacts*` |
| 产品 | 5 | `/products*` |
| ICP | 5 | `/icps*` |
| 发现 | 5 | `/discovery/*` |
| 导入导出 | 4 | `/imports*`、`/export/companies` |
| 活动 | 14 | `/campaigns*` |
| 草稿/审批 | 10 | `/drafts*`、`/approvals/pending` |
| 收件箱 | 7 | `/inbox/*` |
| 商机/活动/跟进 | 12 | `/deals*`、`/activities`、`/follow-up-tasks*` |
| 自动化 | 7 | `/automation/*` |
| 抑制名单 | 3 | `/suppression*` |
| 邮箱账户 | 7 | `/email-accounts*` |
| 仪表盘 | 3 | `/dashboard/*` |
| Agent | 5 | `/agents*` |
| 任务 | 7 | `/jobs*` |
| 公开 | 4 | `/health`、`/public/*` |
| **合计** | **154** | — |

---

## 7. 认证与工作空间

### 7.1 `GET /api/v1/auth/status` ｜ 公开

返回系统是否已初始化与当前登录态。

```json
{ "ok": true, "data": { "initialized": true, "user": null, "workspace": null, "membership": null } }
```

已登录时额外返回 `user`、`workspace`、`membership`（含 `capabilities`）、`csrfToken`、`authType`。

### 7.2 `POST /api/v1/auth/setup` ｜ 公开（5 次/分钟/IP）

首次初始化（仅当系统无用户时可用，否则 `409 CONFLICT`）。

请求：

```json
{ "workspaceName": "我的外贸工作空间", "name": "张三", "email": "zhang@example.com", "password": "StrongPass123" }
```

- `workspaceName` 必填 ≤100；`name` ≤80；`email` 必填；`password` 必填 ≥10 且含字母与数字。
- 成功后创建：用户（owner）+ 工作空间 + 成员关系 + 默认设置 + 默认数据源目录，并直接下发会话 Cookie。
- 响应同 `auth/status`（登录态）；**`csrfToken` 会随响应返回**（与 `zr_csrf` Cookie 一致），API 客户端可直接使用响应值或从 Cookie 读取。

### 7.3 `POST /api/v1/auth/login` ｜ 公开（10 次/分钟/IP）

```json
{ "email": "zhang@example.com", "password": "StrongPass123", "workspaceId": null }
```

响应：

```json
{
  "ok": true,
  "data": {
    "initialized": true,
    "user": { "id": "usr_…", "email": "…", "name": "…", "locale": "zh-CN", "mustChangePassword": false, "lastLoginAt": null, "createdAt": "…" },
    "workspace": { "id": "wsp_…", "name": "…", "slug": "ws-…", "status": "active", "createdAt": "…" },
    "membership": { "workspaceId": "wsp_…", "userId": "usr_…", "role": "owner", "roleLabel": "拥有者", "status": "active", "capabilities": ["data.read", "…"] },
    "memberships": [{ "workspaceId": "wsp_…", "workspaceName": "…", "role": "owner" }],
    "csrfToken": "…"
  }
}
```

失败：`401 UNAUTHORIZED`（邮箱或密码不正确，审计记录 `auth.login_failed`）。

### 7.4 `GET /api/v1/auth/me` ｜ 需登录

返回当前会话信息（同 `auth/status` 登录态）。

### 7.5 `POST /api/v1/auth/logout` ｜ 可选登录

吊销当前会话并清除 Cookie。

```json
{ "ok": true, "data": { "loggedOut": true } }
```

### 7.6 `POST /api/v1/auth/password` ｜ 需登录

```json
{ "currentPassword": "OldPass123", "newPassword": "NewStrongPass456" }
```

- 新密码 ≥10 且含字母/数字，且不能与当前相同。
- 成功后**吊销该用户全部会话**并清除 Cookie，需重新登录：`{ "requiresRelogin": true }`。

### 7.7 会话管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/auth/sessions` | 当前用户有效会话：`{items:[{id,ip,userAgent,createdAt,lastSeenAt,expiresAt,current}]}` |
| DELETE | `/auth/sessions/:id` | 吊销指定会话（只能是自己的） |

### 7.8 API Key

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/auth/api-keys` | 登录 | 列表：`{items:[{id,name,prefix,scopes,lastUsedAt,expiresAt,revokedAt,createdAt}]}` |
| POST | `/auth/api-keys` | `credentials.manage` | `{name, scopes[]}` → `{id,name,token,scopes,note}`（`token` 仅出现一次） |
| DELETE | `/auth/api-keys/:id` | `credentials.manage` | 吊销 |

### 7.9 工作空间

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/workspace` | 登录 | 工作空间 + 当前成员 + 计数 `{members,companies,contacts,products}` |
| PATCH | `/workspace` | `workspace.update` | `{name}` |
| GET | `/workspace/members` | 登录 | `{items:[{userId,membershipId,email,name,role,roleLabel,status,lastLoginAt,createdAt}], roles:[{value,label}]}` |
| POST | `/workspace/members` | `members.manage` | `{email,name,role,password}`；`admin` 仅 owner 可加；新用户需初始密码（≥10） |
| PATCH | `/workspace/members/:userId` | `members.manage` | `{role?,status?}`；不能改 owner；不能停用自己；admin 调整仅 owner |
| DELETE | `/workspace/members/:userId` | `members.manage` | 不能移除 owner/自己；admin 移除仅 owner；同时吊销其会话 |

### 7.10 设置、数据源与凭据

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/settings` | `settings.read` | `{settings:{outreach,limits,retention,ai,compliance,enrichment}, providers:[], credentials:[]}` |
| PATCH | `/settings` | `settings.manage` | 分组深合并，如 `{ "outreach": { "requireApproval": true } }`；未知分组 → 400 |
| PATCH | `/settings/providers/:key` | `settings.manage` | `{isEnabled?, config?}` |
| GET | `/settings/credentials` | `settings.read` | 仅返回 `hasSecret` 与 `secretPreview`（掩码） |
| PUT | `/settings/credentials/:kind/:providerKey` | `credentials.manage` | `{label, secret:{apiKey/token/secret/password/webhookSecret/username}, config}`；密钥 AES-GCM 加密 |
| DELETE | `/settings/credentials/:id` | `credentials.manage` | 删除凭据 |
| GET | `/providers` | `settings.read` | 数据源目录（同 `settings.providers`） |

`kind ∈ ai_provider | data_provider | email_api | webhook`。

**设置分组结构**（默认值，实跑采集）：

```json
{
  "outreach": { "requireApproval": true, "autoSendEnabled": false, "dailySendLimit": 50, "sendWindow": { "start": 9, "end": 17, "weekdays": [1,2,3,4,5], "timezone": "Europe/Berlin" }, "signature": "", "defaultLanguage": "en" },
  "limits": { "dailyEmailLimit": 50, "dailyAiTokens": 500000, "hourlyJobLimit": 300, "maxCrawlPagesPerJob": 30, "maxCompaniesPerDiscovery": 100 },
  "retention": { "messageDays": 730, "contactDays": 1095, "jobDays": 30, "auditDays": 730, "usageDays": 730 },
  "ai": { "provider": "simulation", "model": "zhirai-sim-1", "temperature": 0.3, "maxTokensPerRun": 4096, "allowAutoSend": false, "language": "en" },
  "compliance": { "legalBasis": "legitimate_interest", "includeUnsubscribe": true, "senderCompanyName": "", "senderAddress": "", "privacyUrl": "", "doNotContactNote": "" },
  "enrichment": { "maxEmailsPerDomain": 5, "verifyMx": true, "crawlUserAgent": "ZHIRAI-Outreach/1.0 (+https://zhirai.cloud)", "crawlTimeoutMs": 12000, "maxPagesPerDomain": 4 }
}
```

### 7.11 通知、审计、用量、运维

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/notifications?unread=1&limit=30` | 登录 | `{items:[…], unread}` |
| POST | `/notifications/:id/read` | 登录 | 标记已读 |
| POST | `/notifications/read-all` | 登录 | 全部已读 `{updated}` |
| GET | `/audit?limit=50&page=1&action=&entityType=&entityId=` | `audit.read` | 审计列表（before/after 已脱敏） |
| GET | `/usage?days=30` | 登录 | `{days,since,now,totals,byCategory,byDay,byAgent}` |
| GET | `/ops/system` | `audit.read` | 应用/进程/存储/计数/Worker 状态/备份列表 |
| GET | `/ops/license` | `settings.read` | 产品许可与依赖信息（维护台用） |
| POST | `/ops/backup` | `backup.run` | `VACUUM INTO` 热备 → `{backup:{name,size,createdAt}}` |
| GET | `/ops/backup/:name` | `backup.run` | 下载备份（文件名白名单 `*.sqlite`） |
| GET | `/ops/logs?lines=200` | `audit.read` | 日志尾部 `{file,lines[]}` |

`/ops/system` 实跑返回示例（截断）：

```json
{
  "app": { "name": "ZHIRAI Outreach", "version": "1.0.0", "env": "development" },
  "process": { "uptimeSeconds": 0, "memoryMb": 81, "node": "v24.14.0", "pid": 48808 },
  "storage": { "dbFile": "outreach.sqlite", "dbSize": 4096, "dataDir": "…" },
  "counts": { "companies": 1, "contacts": 1, "messages": 0, "jobs": 0, "auditEvents": 6 },
  "worker": { "running": false, "processed": 0, "failed": 0, "activeJobs": 0 },
  "backups": []
}
```

---

## 8. 业务端点（按域）

### 8.1 企业 `/companies`

#### `GET /api/v1/companies` ｜ `data.read`

查询参数：

| 参数 | 说明 |
| --- | --- |
| `q` | 名称/域名/描述关键词（≤120） |
| `country` | 国家代码，逗号分隔（如 `DE,FR`，最多 3） |
| `status` | 状态，逗号分隔：`new,qualified,contacted,replied,customer,disqualified,archived` |
| `tag` | 标签 |
| `icpId` / `productId` / `ownerUserId` | 关联筛选 |
| `domain` / `companyType` / `industry` | 精确筛选 |
| `automationState` | `AUTOMATION_ACTIVE/NEEDS_HUMAN_REVIEW/HUMAN_TAKEOVER/PAUSED/DO_NOT_CONTACT/CLOSED` |
| `minScore` / `maxScore` | 评分区间（0–100） |
| `hasEmail` / `hasContacts` | 布尔 |
| `sort` | `name,createdAt,updatedAt,country,status,score,dataQualityScore,contactsCount` |
| `page` / `pageSize` / `order` | 分页排序 |

响应项字段（实跑采集，截断）：

```json
{
  "id": "cmp_01M5JG81X3XGCHGXJGSBY1JWG5",
  "workspaceId": "wsp_…",
  "name": "Auto Teile GmbH",
  "normalizedName": "auto teile",
  "domain": "auto-teile.example",
  "website": "https://auto-teile.example",
  "country": "DE",
  "companyType": "distributor",
  "status": "new",
  "tags": [],
  "confidence": "unverified",
  "dataQualityScore": 45,
  "contactsCount": 0,
  "contactCount": 0,
  "emailCount": 0,
  "latestScore": null,
  "score": null,
  "automationState": null,
  "lastActivityAt": null,
  "createdAt": "2026-10-22T19:08:45.347Z",
  "updatedAt": "2026-10-22T19:08:45.347Z"
}
```

#### `POST /api/v1/companies` ｜ `data.write`

```json
{
  "name": "Rhein Auto Teile GmbH",
  "domain": "rhein-auto.example",
  "website": "https://rhein-auto.example",
  "country": "DE",
  "city": "Köln",
  "companyType": "distributor",
  "industry": "automotive aftermarket",
  "description": "Distributor of automotive aftermarket parts in Germany.",
  "tags": ["tier-1"],
  "source": { "sourceType": "manual", "sourceUrl": "https://rhein-auto.example" }
}
```

- `name` 必填；`domain` 会在工作空间内唯一（重复 → 冲突）。
- `source` 可选，服务层写 `company_sources`。
- 返回完整企业对象（含 `id`、`dataQualityScore`、`normalizedName`、自动补全的 `website`）。

#### `GET /api/v1/companies/:id` ｜ `data.read`

聚合详情（实跑采集的键）：

```json
{
  "company": { "id": "cmp_…", "name": "…", "automationState": null, "…": "…" },
  "icp": null,
  "contacts": [],
  "sources": [],
  "matches": [],
  "scores": [],
  "scoreFeedback": [],
  "automation": null,
  "emailThreads": [],
  "threads": [],
  "recentMessages": [],
  "drafts": [],
  "deals": [],
  "activities": [],
  "followUpTasks": [],
  "verifications": [],
  "timeline": [{ "type": "company_created", "at": "…", "title": "企业创建", "entityType": "company", "entityId": "cmp_…", "summary": "Auto Teile GmbH" }],
  "stats": { "contacts": 0, "contactsWithEmail": 0, "verifiedContacts": 0, "inferredContacts": 0, "sources": 0, "scores": 0, "matches": 0, "threads": 0, "drafts": 0, "deals": 0, "maxScore": null, "timelineEvents": 1 }
}
```

> 兼容说明：`automation` 与 `automationState`、`threads` 与 `emailThreads` 同时存在（旧前端字段兼容），新代码建议用 `automation`/`emailThreads`。

#### 其它企业端点

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| PATCH | `/companies/:id` | `data.write` | 可改 `name,domain,website,country,region,city,address,companyType,industry,employeeRange,revenueRange,description,linkedinUrl,phone,status,tags,icpId,ownerUserId,confidence` |
| DELETE | `/companies/:id` | `data.delete` | 软删（`deleted_at`） |
| POST | `/companies/bulk` | `data.write`（`archive` 需 `data.delete`） | `{action:'score'|'archive'|'assign'|'status', ids[], productId?, ownerUserId?, status?}` |
| POST | `/companies/:id/score` | `data.write` | `{productId}` → 评分（见下） |
| POST | `/companies/:id/score-feedback` | `data.write` | `{productId?, field, aiValue, userValue, reason?}` |
| POST | `/companies/:id/enrich` | `discovery.run` | 企业补全（联系人/邮箱推断） |
| POST | `/companies/:id/crawl` | `discovery.run` | `{urls?}`（≤5）抓取官网 |
| GET | `/companies/:id/timeline` | `data.read` | `types`（逗号分隔）、`page`、`pageSize` |
| POST | `/companies/:id/contacts` | `data.write` | 在企业下创建联系人（body 同 `/contacts`） |
| GET | `/companies/:id/sources` | `data.read` | 来源记录 |
| GET | `/companies/:id/verifications` | `data.read` | 校验记录 |

**评分响应**（实跑采集，真实规则评分）：

```json
{
  "companyId": "cmp_…",
  "productId": "prd_…",
  "score": 56,
  "grade": "C",
  "factors": [
    { "key": "product_match", "label": "产品匹配度", "weight": 0.25, "score": 0.31, "reason": "…", "evidence": [{ "type": "buyer_profile", "matched": "distributor" }] },
    { "key": "company_type", "label": "企业类型匹配", "weight": 0.1, "score": 1, "reason": "企业类型（distributor）与 ICP 目标一致" },
    { "key": "region", "label": "目标地区匹配", "weight": 0.15, "score": 1, "reason": "企业所在国家（DE）属于 ICP 目标国家" },
    { "key": "buying_scenario", "label": "采购场景", "weight": 0.15, "score": 0.65, "reason": "采购/分销关键词：distributor" },
    { "key": "data_confidence", "label": "信息可信度", "weight": 0.1, "score": 0.25, "reason": "信息可信度为 unverified，资料完整度 38%" },
    { "key": "contact_confidence", "label": "联系方式可信度", "weight": 0.15, "score": 0.5, "reason": "已有联系人邮箱，但尚未校验" },
    { "key": "recent_signal", "label": "近期采购信号", "weight": 0.1, "score": 0.3, "reason": "暂无近期采购/沟通信号" }
  ],
  "exclusions": [],
  "explanation": "综合评分 56 分（C 级）；主要加分项：目标地区匹配、企业类型匹配、采购场景；最弱项：信息可信度…",
  "modelVersion": "rules-v1",
  "scoredAt": "2026-10-22T19:08:45.366Z"
}
```

### 8.2 联系人 `/contacts`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/contacts` | `data.read` | `q,companyId,emailStatus(逗号),roleCategory,country,emailType,hasEmail,page,pageSize,sort,order` |
| POST | `/contacts` | `data.write` | 见下 |
| GET | `/contacts/:id` | `data.read` | 详情（含企业信息、来源、校验） |
| PATCH | `/contacts/:id` | `data.write` | 可改姓名/职位/邮箱/邮箱类型与状态/角色/可信度/主联系人 |
| DELETE | `/contacts/:id` | `data.delete` | 软删 |
| POST | `/contacts/:id/verify` | `data.write` | 邮箱语法 + MX 校验 → `{emailStatus,mx,checkedAt}` |
| POST | `/contacts/infer-email` | `discovery.run` | `{companyId,firstName,lastName}` → `{candidates:[{email,status:"inferred",confidence}],items}` |
| GET | `/contacts/:id/sources` | `data.read` | 来源记录 |

创建请求：

```json
{
  "companyId": "cmp_…",
  "firstName": "Max",
  "lastName": "Muster",
  "title": "Purchasing Manager",
  "roleCategory": "decision_maker",
  "email": "max@rhein-auto.example",
  "emailType": "business",
  "emailStatus": "unverified",
  "isPrimary": true,
  "source": { "sourceType": "manual", "method": "manual" }
}
```

响应（实跑采集，截断）：

```json
{
  "id": "ctc_…", "workspaceId": "wsp_…", "companyId": "cmp_…",
  "firstName": "Max", "lastName": "Muster", "fullName": "Max Muster",
  "title": "Purchasing Manager", "roleCategory": "unknown",
  "email": "max@auto-teile.example", "emailNormalized": "max@auto-teile.example",
  "emailType": "business", "emailStatus": "unverified",
  "isPrimary": false, "confidence": "unverified",
  "companyName": "Auto Teile GmbH", "companyDomain": "auto-teile.example",
  "createdAt": "…", "updatedAt": "…"
}
```

> `roleCategory` 默认 `unknown`；`emailType` 会根据邮箱判断（如 `info@` → `role`）。推测邮箱必须 `emailStatus="inferred"` 且 `source.method="inference"`。

### 8.3 产品 `/products`

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/products` | `data.read`（`q,status,category,page,pageSize,sort`） |
| POST | `/products` | `data.write` |
| GET | `/products/:id` | `data.read` |
| PATCH | `/products/:id` | `data.write` |
| DELETE | `/products/:id` | `data.delete` |

请求字段：`name`（必填）、`category`、`sku`、`description`、`specs`（对象）、`applications[]`、`materials`、`certifications[]`、`capacity`、`moq`、`pricingTerms`、`samples`、`leadTime`、`status ∈ active|draft|archived`。

响应（实跑采集）：

```json
{
  "id": "prd_…", "workspaceId": "wsp_…", "name": "Battery Pack Bracket",
  "category": "EV parts", "sku": null, "description": null,
  "specs": { "material": "Al 6061" }, "applications": [],
  "materials": null, "certifications": ["IATF 16949"],
  "capacity": null, "moq": null, "pricingTerms": null, "samples": null, "leadTime": null,
  "status": "active", "createdAt": "…", "updatedAt": "…",
  "matchCount": 0, "scoreCount": 0
}
```

### 8.4 ICP `/icps`

| 方法 | 路径 | 权限 |
| --- | --- | --- |
| GET | `/icps` | `data.read`（`q,productId,isActive,page,pageSize,sort`） |
| POST | `/icps` | `data.write` |
| GET | `/icps/:id` | `data.read` |
| PATCH | `/icps/:id` | `data.write` |
| DELETE | `/icps/:id` | `data.delete` |

请求字段：`name`（必填）、`description`、`productId`、`targetCountries[]`（ISO2）、`targetRegions[]`、`targetCompanyTypes[]`、`targetSizes[]`、`targetRoles[]`、`includeKeywords[]`、`excludeKeywords[]`、`minScore`（0–100，默认 60）、`isActive`。

### 8.5 发现 `/discovery`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/discovery/runs` | `data.read` | `status,provider,page,pageSize` |
| POST | `/discovery/runs` | `discovery.run`（30/min） | 创建发现批次并入队 |
| GET | `/discovery/runs/:id` | `data.read` | 批次详情 |
| POST | `/discovery/runs/:id/cancel` | `discovery.run` | 取消 |
| GET | `/discovery/providers` | `data.read` | 可用发现源目录 |

创建请求（支持三种模式）：

```json
{ "provider": "simulation", "keywords": ["battery pack bracket"], "countries": ["DE"], "companyTypes": ["distributor"], "industry": "Automotive Aftermarket", "region": null, "limit": 3 }
```

或 `{ "provider": "csv_import", "csvText": "name,domain,country\n…" }` / `{ "provider": "csv_import", "rows": [{ "name": "…", "domain": "…" }] }` / `{ "provider": "public_web", "query": { … } }`。

响应（实跑采集）：

```json
{
  "id": "dr_…", "workspaceId": "wsp_…", "provider": "simulation", "status": "queued",
  "query": { "keywords": ["battery pack bracket"], "countries": ["DE"], "companyTypes": [], "industry": "Automotive Aftermarket", "region": null, "limit": 3, "csvText": null, "rows": null },
  "resultCount": 0, "companiesCreated": 0, "error": null,
  "createdAt": "…",
  "job": { "queued": true, "jobId": "job_…", "deduped": false }
}
```

`/discovery/providers` 响应项（实跑采集）：

```json
{ "key": "simulation", "name": "内置模拟数据源", "adapter": "simulation", "capabilities": ["search","offline"], "costModel": "免费", "isEnabled": true, "implemented": true, "offline": true }
```

### 8.6 导入与导出

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/imports` | `import.run` | `{kind:'companies'|'contacts'|'suppression', filename, text}`；`text` 为 CSV 文本 |
| GET | `/imports` | `data.read` | 批次列表（`kind,status,page`） |
| GET | `/imports/:id` | `data.read` | 批次详情（含 `errors_json`） |
| GET | `/export/companies?format=csv` | `export.run` | 返回 `{filename, content}`（前端用 `downloadText` 保存） |

导出支持的筛选与 `GET /companies` 一致（`status`、`country`、`minScore`、`maxScore`、`hasEmail` 等）。

### 8.7 活动 `/campaigns`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/campaigns` | `data.read` | 列表：`status,search,productId,page,pageSize`；每项含 `targetCount/sentCount/stepCount/repliedCount/pendingApprovalCount/productName/icpName` |
| POST | `/campaigns` | `campaigns.write` | 创建（默认 `status='draft'`） |
| GET | `/campaigns/:id` | `data.read` | 详情：`{campaign, steps[], stats{…}}` |
| PATCH | `/campaigns/:id` | `campaigns.write` | 更新（含 `status`） |
| DELETE | `/campaigns/:id` | `campaigns.write` | 归档（`archived`） |
| GET | `/campaigns/:id/steps` | `data.read` | `{items:[…]}` |
| POST | `/campaigns/:id/steps` | `campaigns.write` | 新增步骤 |
| PATCH | `/campaigns/:id/steps/:stepId` | `campaigns.write` | 更新步骤 |
| DELETE | `/campaigns/:id/steps/:stepId` | `campaigns.write` | 删除步骤 |
| POST | `/campaigns/:id/enroll` | `campaigns.write` | `{companyIds[], contactIds[]}` 入组 |
| POST | `/campaigns/:id/pause` | `campaigns.write` | 暂停 |
| POST | `/campaigns/:id/resume` | `campaigns.write` | 恢复 |
| GET | `/campaigns/:id/stats` | `data.read` | 统计 |
| GET | `/campaigns/:id/targets` | `data.read` | 目标列表（`status,page,pageSize`） |

列表响应（实跑采集，含聚合字段）：

```json
{
  "items": [{
    "id": "cmp_…", "name": "Probe campaign", "status": "draft",
    "productId": "prd_…", "icpId": null, "goal": "test",
    "dailyLimit": 30, "requireApproval": true,
    "sendWindow": { "start": 9, "end": 17, "weekdays": [1,2,3,4,5], "timezone": "Europe/Berlin" },
    "targetCount": 1, "sentCount": 0, "stepCount": 1, "repliedCount": 0, "pendingApprovalCount": 0,
    "productName": "Battery Pack Bracket", "icpName": null,
    "createdAt": "…", "updatedAt": "…"
  }],
  "total": 1, "page": 1, "pageSize": 25, "hasMore": false
}
```

详情响应（实跑采集，截断）：

```json
{
  "campaign": { "id": "cmp_…", "name": "Probe campaign", "status": "draft", "productId": "prd_…", "productName": null, "icpName": null, "…": "…" },
  "steps": [{ "id": "stp_…", "stepNo": 1, "name": "Intro", "subjectTemplate": "Hi {{company}}", "bodyTemplate": "Hello", "language": "en", "delayDays": 0, "isActive": true }],
  "stats": { "campaignId": "cmp_…", "targets": 1, "sent": 0, "replied": 0, "pendingApproval": 0, "enrolled": 1, "pending": 1, "byStatus": { "enrolled": 1 }, "replyRate": 0, "unsubscribeRate": 0 }
}
```

> 说明：列表项的 `productName`/`icpName` 已联表填充；详情 `campaign.productName` 在部分实现中可能为 `null`（以列表或企业/产品接口为准）。

创建请求示例：

```json
{ "name": "DE EV parts Q4", "productId": "prd_…", "icpId": null, "goal": "Book intro calls", "dailyLimit": 10, "requireApproval": true }
```

步骤示例：

```json
{ "stepNo": 1, "name": "Intro", "subjectTemplate": "Battery pack brackets for {{company}}", "bodyTemplate": "Hello {{first_name}}, …", "language": "en", "delayDays": 0 }
```

入组响应（实跑采集）：

```json
{ "enrolled": 1, "skipped": 0, "duplicate": 0, "noEmail": 0, "suppressed": 0, "automationBlocked": 0, "invalid": 0, "targetIds": ["ctc_…"] }
```

统计响应（实跑采集）：

```json
{ "campaignId": "cmp_…", "targets": 1, "total": 1, "sent": 0, "replied": 0, "unsubscribed": 0, "pendingApproval": 0, "completed": 0, "active": 0, "enrolled": 1, "bounced": 0, "pending": 1, "byStatus": { "enrolled": 1 }, "replyRate": 0, "unsubscribeRate": 0 }
```

> **重要**：发送草稿前活动必须 `status='active'`（否则 `409 CONFLICT / CAMPAIGN_NOT_ACTIVE`）；同时草稿必须 `approved`。

### 8.8 草稿与审批 `/drafts`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/drafts` | `data.read` | `status,campaignId,companyId,contactId,accountId,language,search,page,pageSize` |
| POST | `/drafts` | `data.write` | 创建草稿（手动） |
| GET | `/drafts/:id` | `data.read` | 详情：`{draft,guard,quality,company,contact,product?,campaign?,history?}` |
| PATCH | `/drafts/:id` | `data.write` | 更新主题/正文/语言/账户/排期 |
| POST | `/drafts/:id/generate` | `data.write`（30/min） | 调用 Agent 生成/重写，返回 `{draft}`（`status=pending_approval`） |
| POST | `/drafts/:id/approve` | `drafts.approve` | 审批通过 |
| POST | `/drafts/:id/reject` | `drafts.approve` | `{reason}` |
| POST | `/drafts/batch-approve` | `drafts.approve` | `{ids[]}` |
| POST | `/drafts/:id/send` | `drafts.approve`（60/min） | 入队发送（仍受五道闸检查） |
| GET | `/approvals/pending` | `data.read` | `{count,items,total,page,pageSize,hasMore}` |

创建草稿：

```json
{ "companyId": "cmp_…", "contactId": "ctc_…", "campaignId": "cmp_…", "accountId": null, "subject": "Battery pack brackets — Rhein Auto Teile", "bodyText": "Hello Max,", "language": "en" }
```

生成后的草稿（实跑采集，`simulation` Provider）：

```json
{
  "id": "drf_…", "status": "pending_approval", "language": "en",
  "subject": "Battery Pack Bracket for Rhein Auto Teile GmbH",
  "bodyText": "Hello,\n\nI am reaching out because Rhein Auto Teile GmbH operates in automotive aftermarket, and Battery Pack Bracket may be relevant to your procurement needs.\n\nWould you be open to a short online call to see whether this fits your roadmap?\n\nIf you prefer not to receive further emails, just reply \"unsubscribe\" and we will remove your address.\n\nBest regards,",
  "quality": {}, "guard": {},
  "companyName": "Rhein Auto Teile GmbH", "contactName": "Max Muster", "contactEmail": "max@rhein-auto.example",
  "createdAt": "…", "updatedAt": "…"
}
```

> 草稿详情中的 `guard`（合规检查）与 `quality`（质量审查）在生成后由 Agent 结果填充；当前模拟 Provider 下可能为空对象，真实模型下才产生有效内容。

### 8.9 收件箱 `/inbox`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/inbox/threads` | `data.read` | `unread=1,highIntent=1,companyId,classification,status,search,page,pageSize` |
| GET | `/inbox/high-intent` | `data.read` | 高意向线程 |
| GET | `/inbox/threads/:id` | `data.read` | `{thread,messages[],classification,company,contact,suggestedReply}` |
| POST | `/inbox/threads/:id/reply` | `data.write`（60/min） | `{bodyText}` 发送人工回复 |
| POST | `/inbox/threads/:id/read` | `data.read` | 标记已读 |
| POST | `/inbox/threads/:id/classification` | `data.write` | 人工修正分类 `{label,status:"user_corrected"}` |

### 8.10 商机、活动记录、跟进任务

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/deals` | `data.read` | `stage,status,companyId,ownerUserId,search,page,pageSize` |
| POST | `/deals` | `deals.write` | `{companyId,contactId?,productId?,title,stage,valueAmount,currency,probability,expectedCloseDate}` |
| GET | `/deals/pipeline` | `data.read` | 管道看板 |
| GET | `/deals/:id` | `data.read` | 详情 |
| PATCH | `/deals/:id` | `deals.write` | 更新（含阶段/金额/赢单/丢单） |
| DELETE | `/deals/:id` | `data.delete` | 删除 |
| GET | `/activities` | `data.read` | `companyId,contactId,dealId,type,from,to,page,pageSize` |
| POST | `/activities` | `deals.write` | `{companyId,contactId?,dealId?,type,subject,body,occurredAt}` |
| GET | `/follow-up-tasks` | `data.read` | `status,companyId,contactId,campaignId,assignedTo,dueBefore,type,includeCancelled,page,pageSize` |
| POST | `/follow-up-tasks` | `deals.write` | `{companyId,contactId?,dueAt,type,title,notes,assignedTo?}` |
| PATCH | `/follow-up-tasks/:id` | `deals.write` | 更新状态/时间/标题 |
| DELETE | `/follow-up-tasks/:id` | `deals.write` | 删除 |

管道响应（实跑采集；**固定 6 阶段**，含 `lost`，每阶段带 `items[]`）：

```json
{
  "stages": [
    { "stage": "lead", "label": "线索", "count": 0, "totalValue": 0, "weightedValue": 0, "items": [] },
    { "stage": "qualified", "label": "合格", "count": 1, "totalValue": 12000, "weightedValue": 3600, "items": [
      { "id": "deal_…", "title": "Probe deal", "companyId": "cmp_…", "companyName": "Probe GmbH", "contactId": "ctc_…", "contactName": "Anna Schmidt", "valueAmount": 12000, "currency": "EUR", "probability": 40, "expectedCloseDate": "2027-01-31T00:00:00.000Z", "ownerUserId": "usr_…", "updatedAt": "…" }
    ] },
    { "stage": "proposal", "label": "方案/报价", "count": 0, "totalValue": 0, "weightedValue": 0, "items": [] },
    { "stage": "negotiation", "label": "谈判", "count": 0, "totalValue": 0, "weightedValue": 0, "items": [] },
    { "stage": "won", "label": "赢单", "count": 0, "totalValue": 0, "weightedValue": 0, "items": [] },
    { "stage": "lost", "label": "丢单", "count": 0, "totalValue": 0, "weightedValue": 0, "items": [] }
  ],
  "totals": { "openCount": 1, "totalValue": 12000, "weightedValue": 3600, "wonValue": 0 },
  "currency": "EUR"
}
```

### 8.11 自动化状态与接管 `/automation`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/automation/states` | `data.read` | `state,companyId,page,pageSize` → `{items,total,page,pageSize}` |
| GET | `/automation/:companyId` | `data.read` | 详情：`{company,state,reason,changedBy,changedAt,canSend,canAutoSend,suppressed,label,recordId}` |
| POST | `/automation/:companyId/takeover` | `automation.manage` | `{reason?}` 人工接管（原子：状态+取消待办+取消任务+审计） |
| POST | `/automation/:companyId/resume` | `automation.manage` | `{reason?}` 恢复自动化（`DO_NOT_CONTACT` 不允许） |
| POST | `/automation/:companyId/pause` | `automation.manage` | `{reason?}` 暂停 |
| POST | `/automation/:companyId/do-not-contact` | `suppression.write` | `{reason?, note?}` 加入禁止联系 + 抑制名单 |
| POST | `/automation/:companyId/close` | `automation.manage` | `{reason?}` 关闭客户 |

接管响应（实跑采集）：

```json
{ "company": { "id": "cmp_…", "name": "Rhein Auto Teile GmbH" }, "state": "HUMAN_TAKEOVER", "previousState": "AUTOMATION_ACTIVE", "cancelledTasks": 0, "cancelledJobs": 0 }
```

详情响应中的 `canSend`/`canAutoSend` 为 `false` 表示当前不允许发送。

### 8.12 抑制名单 `/suppression`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/suppression` | `data.read` | `scope(email|domain),reason,search,page,pageSize` |
| POST | `/suppression` | `suppression.write` | `{scope,value,reason,note?}` |
| DELETE | `/suppression/:id` | `suppression.write` | 删除（仅 admin/owner 具备该 capability） |

创建响应（实跑采集）：

```json
{
  "record": { "id": "sup_…", "scope": "domain", "valueNormalized": "rhein-auto.example", "reason": "manual", "source": "manual", "note": "客户要求不再联系", "createdAt": "…", "reasonLabel": "人工添加" },
  "created": true
}
```

### 8.13 邮箱账户 `/email-accounts`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/email-accounts` | `data.read` | `{items:[…]}` |
| POST | `/email-accounts` | `email.accounts.manage` | 创建 |
| GET | `/email-accounts/:id` | `data.read` | 详情（凭据只返回 `hasCredential`/掩码） |
| PATCH | `/email-accounts/:id` | `email.accounts.manage` | 更新 |
| DELETE | `/email-accounts/:id` | `email.accounts.manage` | 删除 |
| POST | `/email-accounts/:id/test-connection` | `email.accounts.manage`（10/min） | 测试 SMTP/IMAP |
| POST | `/email-accounts/:id/sync` | `email.sync`（10/min） | 立即同步收件 |

创建请求：

```json
{
  "name": "Sales mailbox",
  "address": "sales@example.com",
  "displayName": "ZHIRAI Sales",
  "protocol": "smtp_imap",
  "smtpHost": "smtp.example.com",
  "smtpPort": 465,
  "smtpSecure": true,
  "imapHost": "imap.example.com",
  "imapPort": 993,
  "imapSecure": true,
  "username": "sales@example.com",
  "password": "••••••••",
  "dailyLimit": 50,
  "signature": "Best regards\n…"
}
```

响应（实跑采集，`simulation` 协议，凭据不回传）：

```json
{
  "id": "acc_…", "name": "Simulation inbox", "address": "sales@zhirai.example",
  "protocol": "simulation", "smtpHost": "", "smtpPort": null, "smtpSecure": true,
  "imapHost": "", "imapPort": null, "imapSecure": true,
  "username": "sales@zhirai.example", "hasCredential": false,
  "signature": null, "dailyLimit": 20, "status": "active",
  "lastSyncAt": null, "lastError": null, "credentialPreview": null
}
```

### 8.14 仪表盘 `/dashboard`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/dashboard/summary` | `data.read` | 汇总（企业/联系人/草稿/活动/收件箱/商机/发送/Agent/任务/待办/自动化/趋势/漏斗/警报/最近） |
| GET | `/dashboard/activity?limit=8` | `data.read` | 最近动态 |
| GET | `/dashboard/alerts` | `data.read` | 警报列表 |

`summary` 关键字段（实跑采集，截断）：

```json
{
  "companies": { "total": 1, "new7d": 1, "qualified": 0, "contacted": 0, "replied": 0, "customer": 0 },
  "contacts": { "total": 1, "withEmail": 1 },
  "drafts": { "pendingApproval": 0, "approved": 0, "total": 0, "sent": 0 },
  "campaigns": { "active": 0, "total": 0 },
  "inbox": { "unreadThreads": 0, "highIntent": 0, "replies7d": 0 },
  "deals": { "open": 0, "pipelineValue": 0, "won30d": 0 },
  "sends": { "sent7d": 0, "sent30d": 0, "totalSent": 0, "dailyUsed": 0, "dailyLimit": 50, "autoSendEnabled": false, "replyRate": 0 },
  "agents": { "runs7d": 0, "tokens7d": 0, "cost7d": 0 },
  "jobs": { "queued": 0, "running": 0, "failed": 0, "succeeded": 0, "cancelled": 0, "dead": 0 },
  "tasks": { "pending": 0, "due": 0, "overdue": 0 },
  "automation": { "AUTOMATION_ACTIVE": 0, "NEEDS_HUMAN_REVIEW": 0, "HUMAN_TAKEOVER": 0, "PAUSED": 0, "DO_NOT_CONTACT": 0, "CLOSED": 0 },
  "trend": [{ "day": "2026-10-22", "emails": 0, "replies": 0 }],
  "funnel": [{ "stage": "new", "label": "新增", "count": 1 }],
  "alerts": [],
  "recent": []
}
```

### 8.15 Agent `/agents`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/agents` | `settings.read` | `{items:[AGENT_CATALOG × 10], provider:{provider,model,isSimulation,source,configured,baseUrlHost,timeoutMs,pricing,warning}, roles:[…], limits:{maxInputBytes}}` |
| GET | `/agents/executions` | `settings.read` | `role,status,page,pageSize` |
| GET | `/agents/executions/:id` | `settings.read` | 执行详情 |
| POST | `/agents/test-provider` | `settings.read`（10/min） | `{ok,provider,model,latencyMs,sample,isSimulation}`；失败返回 `error:{code,message}` |
| POST | `/agents/run` | `agents.run`（60/min） | `{role, input}` → `{executionId, output, usage}` |

`provider` 状态（实跑采集；**不包含密钥**）：

```json
{
  "provider": "simulation",
  "model": "zhirai-sim-1",
  "isSimulation": true,
  "source": "simulation",
  "configured": false,
  "baseUrlHost": null,
  "timeoutMs": null,
  "pricing": { "inputPer1k": 0, "outputPer1k": 0 },
  "warning": "未配置模型 API Key，当前使用内置离线模拟 Provider；模拟输出不会调用任何外部模型。"
}
```

10 个角色：`orchestrator`、`market_research`、`company_qualification`、`contact_research`、`product_matching`、`outreach_writer`、`reply_classification`、`follow_up_planning`、`compliance_guard`、`quality_review`（每个含 `nameZh/description/promptVersion/capabilities/inputFields`）。

`AGENT_CATALOG` 项（实跑采集，截断）：

```json
{
  "role": "outreach_writer",
  "name": "Outreach Writer",
  "nameZh": "开发信撰写",
  "description": "生成个性化开发信，只引用输入中的事实，并列出 claims 与风险提示。",
  "promptVersion": "outreach_writer@1",
  "capabilities": ["writing", "personalization"],
  "inputFields": ["company", "contact", "product", "icp", "language", "facts"]
}
```

> **安全**：`/agents` 只返回目录元数据与 Provider 状态，**永不返回提示词正文或任何密钥**。`input` 上限按字节计（`MAX_INPUT_BYTES`，超出返回 413 `AGENT_INPUT_TOO_LARGE`）。

### 8.16 任务 `/jobs`

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/jobs` | `jobs.read` | `status,type,q,page,pageSize` |
| GET | `/jobs/stats` | `jobs.read` | 统计 + 类型 + 已注册 handler |
| GET | `/jobs/:id` | `jobs.read` | 详情 |
| POST | `/jobs/:id/cancel` | `jobs.manage` | `{reason?}` |
| POST | `/jobs/:id/retry` | `jobs.manage` | 仅失败/取消/死信可重试，否则 400 |
| POST | `/jobs/pause` | `jobs.manage` | 全局暂停（工作空间级） |
| POST | `/jobs/resume` | `jobs.manage` | 恢复 |

统计响应（实跑采集）：

```json
{
  "queued": 0, "running": 0, "succeeded": 0, "failed": 0, "cancelled": 0, "dead": 0,
  "total": 0, "paused": false, "oldestQueuedAt": null,
  "last24h": { "succeeded": 0, "failed": 0 }, "now": "…",
  "types": ["discovery.search","company.crawl","company.enrich","contact.verify","lead.score","draft.generate","email.send","email.sync","reply.classify","followup.plan","campaign.tick","maintenance.retention"],
  "registeredHandlers": ["campaign.tick","company.crawl","…"]
}
```

任务对象（实跑采集）：

```json
{
  "id": "job_…", "type": "discovery.search",
  "payload": { "discoveryRunId": "dr_…" },
  "status": "queued", "priority": 100, "attempts": 0, "maxAttempts": 3,
  "runAt": "…", "startedAt": null, "finishedAt": null, "leaseUntil": null, "workerId": null,
  "dedupeKey": "discovery.search:wsp_…:dr_…",
  "lastError": null, "result": {}, "costEstimate": 0, "createdAt": "…", "updatedAt": "…"
}
```

---

## 9. 公开端点

### 9.1 `GET /api/v1/health` ｜ 公开（120 次/分钟/IP）

```json
{ "ok": true, "data": { "status": "ok", "version": "1.0.0", "initialized": true, "uptimeSeconds": 0, "time": "2026-10-22T19:08:45.408Z" } }
```

数据库不可用时 `status="degraded"`。

### 9.2 `GET /api/v1/public/meta`

品牌元数据（应用名、版本、品牌/口号/版权），用于未登录页脚。

### 9.3 `GET /api/v1/public/unsubscribe/:token`（30 次/分钟/IP）

退订链接预览（**无需登录**）：

```json
{ "ok": true, "data": { "valid": true, "workspaceName": "我的工作空间", "email": "m***@example.com", "contactName": "Max Muster", "alreadyUnsubscribed": false } }
```

### 9.4 `POST /api/v1/public/unsubscribe/:token`（30 次/分钟/IP）

执行退订（无需登录）：

```json
{ "ok": true, "data": { "unsubscribed": true, "alreadyUnsubscribed": false } }
```

副作用：写 `suppression_records(reason='unsubscribe')` → 该客户 `DO_NOT_CONTACT` → 取消待办与任务 → 审计（`actor_type='anonymous'`）。**幂等**：重复提交返回 `alreadyUnsubscribed:true`。

---

## 10. 覆盖范围与已知差异

### 10.1 本文覆盖

- 全部已实现路由（`server/routes/index.mjs` 挂载的 25 个模块 / 154 条「方法 × 路径」）。
- 示例字段来自隔离测试实例实跑（临时数据库 + 临时端口），**未使用生产数据**。
- 端到端验收（发布负责人 2026-10-22）：`node scripts/verify-safety.mjs` **15/15 通过**（审批→队列→Worker 发送、接管拦截、抑制拦截、公开退订、发送窗口恢复）；`npm test` 274 项（273 通过 / 1 跳过 / 0 失败）。

### 10.2 openapi.yaml 覆盖

`docs/openapi.yaml` 覆盖：认证、工作空间、设置/凭据、企业、联系人、产品、ICP、发现、导入导出、活动、草稿审批、收件箱、商机、自动化、抑制、邮箱账户、仪表盘、Agent、任务、公开端点。**未覆盖**：`/ops/*`（运维端点）、`/notifications`、`/audit`、`/usage`（在本文档中有说明，但未写入 OpenAPI，避免与内部运维接口混淆）。

### 10.3 已知差异与注意事项

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | 活动详情 `campaign.productName` 可能为 `null` | 列表已联表返回 `productName/icpName`；详情以 `productId` 查询产品接口，或以列表为准 |
| 2 | 列表 `hasMore` 一致性 | 大部分列表含 `hasMore`；`/automation/states`、`/campaigns/:id/targets` 只返回 `{items,total,page,pageSize}` |
| 3 | 草稿发送前置条件 | 活动必须 `active`（`CAMPAIGN_NOT_ACTIVE`）+ 草稿 `approved` + 过五道闸；否则 409/拒绝 |
| 4 | 模拟 Provider 的 `guard`/`quality` | 生成时可能为空对象（无真实模型）；真实模型下由 Agent 返回 |
| 5 | `POST /drafts/:id/send` 只入队 | 实际发送由 Worker 执行；Worker 未启动（`WORKER_ENABLED=0`）时任务停留 `queued` |
| 6 | 公开退订 token | 签名但未加密（payload 可解码出邮箱与工作空间 ID）；链接本身即凭证 |
| 7 | 时区 | 所有时间为 UTC；发送窗口按 `Europe/Berlin` 计算 |
| 8 | 错误 `details` | 结构因错误类型而异；客户端应以 `code`/`message` 为主 |

### 10.4 快速自测

```bash
# 健康检查
curl -s http://127.0.0.1:4173/api/v1/health

# 登录（保存 Cookie）
curl -s -c cookies.txt -X POST http://127.0.0.1:4173/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"YourPassword123"}'

# 读取企业列表（Cookie 认证）
curl -s -b cookies.txt "http://127.0.0.1:4173/api/v1/companies?page=1&pageSize=5"

# 写操作需 CSRF（从 cookies.txt 读取 zr_csrf）
curl -s -b cookies.txt -X POST http://127.0.0.1:4173/api/v1/products \
  -H "Content-Type: application/json" -H "X-CSRF-Token: <zr_csrf>" \
  -d '{"name":"Battery Pack Bracket"}'
```

---
<div align="center">

**ZHIRAI · 智睿科技 · 独立开发者**
把想法变成现实 ｜ https://zhirai.cloud
© 2026 智睿科技 保留所有权利。

</div>
