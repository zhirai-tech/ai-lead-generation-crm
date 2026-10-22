# 更新日志（CHANGELOG）

> 项目：ZHIRAI Europe B2B AI Outreach Platform（智睿欧洲 B2B AI 外贸获客平台）
> 格式参考 Keep a Changelog；版本号遵循语义化版本。
> 品牌：`ZHIRAI · 智睿科技 · 独立开发者` ｜ `© 2026 智睿科技 保留所有权利。`

---

## [1.0.0] - 2026-10-22

**首个正式版本。** 独立实现、零第三方运行时依赖、可自托管、可闭源商业分发。

### 新增 · 架构与基础设施

- **零依赖技术栈**：Node.js ≥ 22.5（内置 `node:sqlite`/`node:crypto`/`node:http`），纯 ESM，`package.json` 无 `dependencies`/`devDependencies`。
- **HTTP 框架**（`server/core/http.mjs`）：路由、Body 解析、Cookie、鉴权解析、CSRF 双提交 + Origin 校验、内存限流、静态文件白名单、安全响应头、统一 JSON 错误。
- **数据库层**（`server/core/db.mjs`）：单连接 SQLite（WAL、外键、`busy_timeout=5000`）、语句缓存、`all/get/run/tx`、编号迁移 + `schema_migrations`。
- **认证与授权**（`server/core/auth.mjs`）：scrypt 密码哈希、会话（HttpOnly + 仅存 SHA-256 哈希）、API Key（`zrk_`）、4 角色 × 25 capability 服务端矩阵、首次初始化 bootstrap。
- **密码学**（`server/core/crypto.mjs`）：scrypt、AES-256-GCM + HKDF（凭据加密，AAD 绑定工作空间/类型/供应商）、HMAC 签名 token（退订链接）、掩码。
- **审计**（`server/core/audit.mjs`）：append-only 审计，before/after 敏感键自动脱敏。
- **校验/时间/ID/日志/限流/密钥**：`validate.mjs`、`time.mjs`（含 Europe/Berlin 时区窗口）、`ids.mjs`（前缀 ULID）、`logger.mjs`（脱敏 JSON 日志）、`rate-limit.mjs`、`secrets.mjs`。
- **数据库 schema**：`server/db/migrations/001_init.sql` —— **40 张表**，所有业务表 `workspace_id` 隔离，唯一约束与索引覆盖主要查询。
- **应用装配**：`server/config.mjs`（`.env` + 环境变量）、`server/app.mjs`、`server/index.mjs`（迁移 → 监听 → Worker 生命周期 → 优雅退出）。

### 新增 · 业务功能

- **工作空间与成员**：工作空间信息、成员增删改、角色变更、owner 唯一性保护、移除成员时吊销会话。
- **设置与凭据**：6 组工作空间设置（outreach/limits/retention/ai/compliance/enrichment）、外部数据源目录（8 个 Provider）、集成凭据 AES-GCM 加密存储与掩码读取。
- **产品与 ICP**：产品资料（规格/应用/材料/认证/产能/MOQ/报价条件/样品/交期/状态）、ICP（国家/地区/类型/规模/角色/关键词/排除词/最低分）。
- **企业与联系人**：CRUD、批量操作、来源记录（`company_sources`/`contact_sources`）、校验记录、邮箱类型与可信度分级（`unverified/valid/risky/invalid/inferred`）、邮箱推断（推测一律 `inferred`）、MX 校验、企业详情聚合与时间线。
- **发现与补全**：发现批次（`discovery_runs`）、模拟数据源/CSV 导入/可配置搜索 API 适配器、企业补全、公开网页抓取（适配器状态以页面 `implemented` 为准）。
- **评分与匹配**：确定性规则评分 `rules-v1`（产品匹配/企业类型/地区/采购场景/信息可信度/联系方式可信度/近期信号/排除规则），输出分数、等级、因素、证据、排除项、可读解释；人工反馈记录。
- **活动（Campaign）**：活动/步骤/目标、入组（自动跳过抑制/接管/无邮箱/重复）、暂停/恢复/归档、统计。
- **草稿与审批**：草稿 CRUD、AI 生成（服务端提示词）、状态机（draft→pending_approval→approved→scheduled→sent）、审批/驳回/批量审批、待审批列表。
- **发送管线**：五道闸检查（审批/抑制/自动化状态/全局暂停/窗口+限额+重复+熔断）、SMTP 发送、发送记录与用量、发送后推进活动。
- **邮件协议**：自写 SMTP 客户端、MIME 构建、IMAP 同步、模拟邮箱（用于离线演练与测试）。
- **收件箱与回复**：线程列表/详情、人工回复、已读、11 类意向分类（置信度/意向分/证据/理由/建议回复）、人工修正、高意向通知。
- **真人接管**：6 态自动化状态机；接管原子操作（状态 + 取消待办 + 取消任务 + 审计）；恢复限制；`DO_NOT_CONTACT` 保护。
- **CRM**：商机（阶段/金额/赢单输单）、销售活动时间线、跟进任务。
- **抑制名单**：邮箱/域名维度、6 种原因、发送前强制检查、公开退订链接写入抑制。
- **仪表盘**：企业/联系人/草稿/活动/收件箱/商机/发送/Agent/任务/待办/自动化统计、趋势、漏斗、警报、最近动态。
- **Agent 层**：10 个角色（orchestrator / market_research / company_qualification / contact_research / product_matching / outreach_writer / reply_classification / follow_up_planning / compliance_guard / quality_review）、Provider 抽象（OpenAI 兼容 + 内置 simulation）、服务端提示词文件化、结构化输出 Schema 校验与重试、执行记录（`agent_executions`）与用量记录（`usage_records`）、Provider 测试、目录元数据（不暴露提示词）。
- **任务队列**：数据库任务表、幂等（`dedupe_key` 唯一）、租约（`lease_until`）、重试/死信、取消（单任务/按企业批量）、优先级、全局暂停/恢复、统计、12 类任务 handler、调度器。
- **运维**：健康检查、系统状态、许可证与依赖信息、热备份（`VACUUM INTO`）、备份列表/下载、日志尾部读取、审计查询、用量报表、通知中心。

### 新增 · 前端（15 个页面模块 / 16 条路由，全部交付）

- 原生 ESM 工作台（无构建、零依赖）：启动/登录/初始化/退订页、Hash 路由、应用外壳（侧栏分组导航、顶栏搜索/刷新/通知/用户菜单）、API 客户端（CSRF 自动携带、401 统一处理）。
- 页面：全局总览、企业发现、潜在客户、企业详情、联系人库、产品资料、客户画像、开发信活动、邮件草稿、发送审批、统一收件箱、销售管道、自动化与接管、Agent 中心、任务队列、系统设置（11 个页签）。
- 深色主题设计系统（tokens/base/layout/components/pages）、通用组件（表格/分页/弹窗/抽屉/确认框/Toast/状态徽标/评分条/图表等）、自绘内联图标集（无图标库）。
- **系统维护台** `/admin`：系统概览、备份创建/下载、日志、许可证与依赖。

### 新增 · 文档

- `docs/ARCHITECTURE.md`：完整系统架构研究方案（方案第八节 19 项交付）。
- `docs/RESEARCH.md`：8 个开源项目研究报告（A/B/C/D 分类、许可证核验、借鉴点、外部依赖）。
- `docs/LICENSE-REGISTER.md`：第三方依赖与素材登记册（当前 0 依赖）。
- `docs/DATA-MODEL.md`：40 张表 ER、字段、唯一约束、索引、租户隔离、保留与迁移策略。
- `docs/API.md` + `docs/openapi.yaml`：REST API 文档与 OpenAPI 描述。
- `docs/SECURITY.md`：威胁模型、认证/CSRF/加密、多租户、发送与 Agent 安全、生产清单、已知限制。
- `docs/COMPLIANCE.md`：GDPR 与欧洲电子营销落地（**非法律意见**）。
- `docs/DECISIONS.md`：13 条 ADR。
- `docs/USER-GUIDE.md`：中文操作手册。
- `docs/ROADMAP.md`：v1.0 → v1.x 计划与"不自动化承诺"。
- `README.md`、`DEPLOY.md`、`CHANGELOG.md`（本文件）、`docs/CONTRACTS.md`（内部开发契约）。

### 新增 · 脚本

- `scripts/init-db.mjs`：建目录 + 迁移 + 表数量报告。
- `scripts/seed-demo.mjs`：演示工作空间与样例数据（用于体验/验收）。
- `scripts/reset-password.mjs`：本地重置管理员密码（无需邮箱）。
- `scripts/backup.mjs`：`VACUUM INTO` 热备。
- `scripts/verify-safety.mjs`：端到端安全验收（审批→发送、接管拦截、抑制拦截、公开退订，共 15 项检查）。

### 验收结果（2026-10-22）

- **自动化测试**：`npm test`（`node --test --test-force-exit "tests/**/*.test.mjs"`，Node v24.14.0）→ **274 项：273 通过、1 跳过、0 失败**（约 3.8s）。
- **端到端安全验收**：`node scripts/verify-safety.mjs` → **15/15 通过**（含审批后 Worker 发送、接管后发送被拒、抑制名单拦截、公开退订写入抑制、发送窗口恢复）。
- **前端浏览器验收**：15 个页面模块 / 16 条路由在真实浏览器中完成列表→详情→操作→反馈→空态验收。
- **静态一致性**：154 条 API 路由、40 张表；`docs/openapi.yaml` 通过 YAML 解析（101 路径 / 138 操作 / 32 schema）。

### 安全

- 会话 HttpOnly + SameSite=Lax + HTTPS 下 Secure；改密吊销全部会话。
- CSRF 双提交 + Origin 校验；同源专用，无 CORS。
- 严格 CSP（`default-src 'self'`）、`X-Frame-Options: DENY`、`nosniff`、`Referrer-Policy`、`Permissions-Policy`。
- 集成凭据 AES-256-GCM 加密，密钥 HKDF 派生，AAD 绑定上下文；API 只返回掩码。
- 审计与日志敏感键自动脱敏；错误响应不泄露堆栈/SQL。
- 发送安全：默认人工审批、抑制名单、接管拦截、发送窗口、限额、重复检测、全局暂停。
- 公开退订链接 HMAC 签名 + 过期；退订写抑制 + `DO_NOT_CONTACT` + 取消任务。
- 静态文件白名单，禁止访问 `server/`、`docs/`、`..`。

### 已知限制 / 未实现（如实说明）

- **单实例**：限流为内存实现、SQLite 单写者，不支持多副本；`node:sqlite` 仍为 Node 实验特性。
- **未端到端验证的项**：真实外网 SMTP/IMAP 收发（协议层有单测与受控发送验证）、真实付费模型 API 的质量评估、退订链接在真实邮件客户端中的表现、备份恢复演练、大流量/长时间运行表现（见 `docs/SECURITY.md` §15.2）。
- **未实现**：MFA/SSO、自助找回密码（用本地脚本）、robots.txt 自动解析、数据库整库加密、彻底删除/匿名化工具、MCP Server/Webhook 出站、LinkedIn/WhatsApp 通道、多副本高可用、内置 WAF、许可证服务端校验。
- **模拟 Provider 的输出仅供演练**，不代表真实模型质量；`guard_json`/`quality_json` 在模拟模式下可能为空。
- **法律审查**：GDPR/ePrivacy 各国规则未由律师复核；`docs/COMPLIANCE.md` 明确为"非法律意见"。
- **许可**：专有软件（UNLICENSED），商业使用需书面授权；参考项目仅研究，未复制代码/素材（见 `docs/RESEARCH.md`、`docs/LICENSE-REGISTER.md`）。

### 升级说明

- 初始版本，无需从旧版本升级。
- 首次部署：`npm run init-db` → `npm start` → 浏览器初始化。

---

## [Unreleased]

计划内容见 [docs/ROADMAP.md](docs/ROADMAP.md)：

- v1.1：robots.txt 与抓取限速、退信/投诉自动抑制、占位符校验、DSAR 工具、保留清理任务、测试发送、域名认证指引、多语言模板、批量操作增强、报表。
- v1.2：搜索/补全适配器实装、官网站点抽取增强、角色推断、企业合并、数据质量看板、XLSX 导入评估。
- v1.3：工作空间切换、权限细化、通知渠道、Webhook、MCP Server、OpenAPI 完善、附件发送。
- v2.0（条件触发）：PostgreSQL 支持、独立 Worker、多副本、插件机制、多租户 SaaS。

---
<div align="center">

**ZHIRAI · 智睿科技 · 独立开发者**
把想法变成现实 ｜ https://zhirai.cloud
© 2026 智睿科技 保留所有权利。

</div>
