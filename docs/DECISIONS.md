# 架构决策记录（ADR）

> 项目：ZHIRAI Europe B2B AI Outreach Platform v1.0.0
> 作者：ZHIRAI · 智睿科技 · 独立开发者
> 格式：每条记录包含 **背景 / 决定 / 理由 / 替代方案 / 代价 / 后果 / 状态**。
> 状态：`已采纳` = v1.0 已按此实现；`已采纳（部分）` = 设计已定、实现随模块推进。

| ADR | 标题 | 状态 |
| --- | --- | --- |
| [ADR-001](#adr-001运行时与数据库选用-node--sqlite-零依赖) | 运行时与数据库：Node + SQLite 零依赖 | 已采纳 |
| [ADR-002](#adr-002进程模型单体--内置-worker) | 进程模型：单体 + 内置 Worker | 已采纳 |
| [ADR-003](#adr-003队列数据库任务表而非-redis) | 队列：数据库任务表而非 Redis | 已采纳（部分） |
| [ADR-004](#adr-004前端原生-es-modules不引入构建链) | 前端：原生 ES Modules，无构建链 | 已采纳 |
| [ADR-005](#adr-005模型接入provider-抽象--默认-simulation) | 模型接入：Provider 抽象 + 默认 simulation | 已采纳（部分） |
| [ADR-006](#adr-006提示词只在服务端) | 提示词只在服务端 | 已采纳（部分） |
| [ADR-007](#adr-007发送默认人工审批) | 发送默认人工审批 | 已采纳 |
| [ADR-008](#adr-008人工接管的原子语义) | 人工接管的原子语义 | 已采纳（部分） |
| [ADR-009](#adr-009评分规则优先ai-只做解释增强) | 评分：规则优先，AI 只做解释增强 | 已采纳（部分） |
| [ADR-010](#adr-010专有许可--零第三方依赖的商业分发) | 专有许可 + 零第三方依赖的商业分发 | 已采纳 |
| [ADR-011](#adr-011数据模型显式表--json-扩展不做-eav) | 数据模型：显式表 + JSON 扩展，不做 EAV | 已采纳 |
| [ADR-012](#adr-012多租户共享库--workspace_id-行级隔离) | 多租户：共享库 + workspace_id 行级隔离 | 已采纳 |
| [ADR-013](#adr-013部署单机--反向代理不做-kubernetes) | 部署：单机 + 反向代理，不做 Kubernetes | 已采纳 |

---

## ADR-001：运行时与数据库选用 Node + SQLite 零依赖

**背景**
产品需要交付给欧洲中小外贸企业自托管，客户 IT 能力参差；同时本项目计划"卖软件 + 卖源码"。任何 npm 依赖都会带来：安装步骤、供应链攻击面、许可证登记工作量、离线环境部署困难。

**决定**
- 运行时：Node.js **≥ 22.5**（使用内置 `node:sqlite`）。
- 语言：纯 ESM JavaScript（`.mjs`），`package.json` 的 `"type": "module"`。
- 数据库：SQLite 单文件，WAL 模式，`foreign_keys=ON`，`busy_timeout=5000`，`synchronous=NORMAL`。
- `package.json` **不包含 `dependencies`**（也不含 devDependencies）。
- 数据库访问封装在 `server/core/db.mjs` 单点（`all/get/run/exec/tx` + 语句缓存 + 迁移）。

**理由**
1. 部署体验："解压 → `npm run init-db` → `npm start`"，没有 `npm install`。
2. 供应链：无第三方包 = 无 npm 投毒/许可证污染风险。
3. 备份：SQLite 单文件可用 `VACUUM INTO` 热备（`/api/v1/ops/backup` 已实现）。
4. 规模匹配：目标客户单工作空间数据量为万级企业、十万级联系人，SQLite 足够。
5. 商业分发：许可证登记册可以诚实地写"0 个第三方运行时依赖"。

**替代方案**
- PostgreSQL + Prisma/TypeORM：强并发、强类型，但引入 npm 依赖与数据库运维。
- MySQL/MariaDB：客户面板常见，但同样需要服务与驱动。
- DuckDB：分析强，OLTP 与并发写弱。
- 云数据库：违反"数据留在本地"的卖点，且跨境合规复杂。

**代价**
- SQLite 单写者，写并发受限（WAL 下读不阻塞写）。
- `node:sqlite` 目前仍标注实验特性；Node 升级可能带来 API 变更（已封装单点，便于替换）。
- 无 ORM：SQL 手写，迁移手写，需要纪律（仓储层强制 `workspace_id`）。
- 水平扩展困难：不支持多副本共享同一 SQLite 文件。

**后果**
- `engines.node >= 22.5.0` 必须在校验中保留；低版本启动会直接失败（`node:sqlite` 不存在）。
- 所有列表查询必须自己写分页 SQL 与索引；`001_init.sql` 已建 30+ 索引。
- 未来若需 PostgreSQL，只需重写 `core/db.mjs` 与仓储 SQL（业务层不动）。

---

## ADR-002：进程模型：单体 + 内置 Worker

**背景**
方案明确要求"不要仅为了复杂而引入消息队列或微服务"，并允许根据真实负载选择单体 + 后台 Worker。

**决定**
- 一个 Node 进程同时承担：HTTP API、静态前端、后台 Worker、定时调度。
- 启动入口 `server/index.mjs`：迁移 → 监听 → `startWorker()` → 信号处理优雅退出。
- Worker 可通过 `WORKER_ENABLED=0` 关闭（只跑 API，用于调试或分离部署的过渡期）。

**理由**
1. 真实负载：单客户日发送量 50–500 封，AI 调用数百次，单体完全够用。
2. 一致性：接管/退订时需要"更新状态 + 取消任务"在一个进程内完成，避免跨服务竞态。
3. 运维：客户只需守护一个进程；日志、备份、升级都简单。
4. 成本：最低 1 vCPU / 512MB 可运行（🔶 未压测）。

**替代方案**
- API + 独立 Worker 两进程：隔离更好，但需共享 SQLite（跨进程 WAL 可用但复杂度上升）或改用 PostgreSQL。
- 微服务（发现/写信/发送/CRM 各自服务）：运维与调试成本远超收益。
- Serverless：长连接（SMTP/IMAP）与本地文件系统不适合。

**代价**
- 不能水平扩展；单进程崩溃会同时中断 API 与 Worker（由进程守护重启恢复，租约机制回收任务）。
- CPU 密集任务可能影响 HTTP 响应（当前以网络 IO 为主，风险低）。

**后果**
- 文档必须明确"单实例"是支持拓扑（[SECURITY.md](./SECURITY.md) 已知限制）。
- Worker 必须实现租约（`lease_until`）与幂等（`dedupe_key`），否则崩溃会卡任务。

---

## ADR-003：队列：数据库任务表而非 Redis

**背景**
需要可靠地执行发现、抓取、补全、评分、写信、发送、同步、分类、跟进、活动推进、保留清理等异步任务，并要求重试、取消、去重、状态查询。

**决定**
- `background_jobs` 表 + 进程内轮询 Worker（`WORKER_POLL_MS` 默认 1000ms）。
- 字段：`type/payload_json/status/priority/attempts/max_attempts/run_at/lease_until/worker_id/dedupe_key/result_json/cost_estimate`。
- 状态机：`queued → running → succeeded | failed → (retry) → dead`，`cancelled` 为中断态。
- 幂等：`dedupe_key` 全局唯一索引 `(dedupe_key) WHERE dedupe_key IS NOT NULL AND dedupe_key <> ''`；建议 `${type}:${workspaceId}:${entityId}`。
- 取消：`cancelJobsForCompany(workspaceId, companyId, reason)`、`cancelJob(workspaceId, jobId)`。

**理由**
1. 零依赖：不需要 Redis/RabbitMQ 及其运维。
2. 事务一致：任务与业务数据同库，入队可与业务写在同一事务（或紧随其后），避免"数据已写、任务丢失"。
3. 可观测：任务状态可直接用 SQL 查询，`/api/v1/jobs` 暴露给前端。
4. 规模匹配：单机每秒数十任务足够。

**替代方案**
- Redis + BullMQ：吞吐高、生态好，但多一个服务 + npm 依赖。
- 内存队列：重启丢任务，不可接受。
- 数据库 + 外部队列混合：复杂度不划算。

**代价**
- 轮询有延迟（≤ pollMs）；高频任务需调小 `WORKER_POLL_MS`（最小 100ms）。
- 大量任务时 SQLite 写竞争增加；需要索引 `idx_jobs_claim(status, run_at, priority)`。
- 无原生"延迟队列"，用 `run_at` 模拟。

**后果**
- 任务处理必须幂等（同一任务可能因租约过期被重跑）。
- 接管/退订必须同时取消 `follow_up_tasks` 与 `background_jobs`，否则会出现"接管后仍发信"。

---

## ADR-004：前端：原生 ES Modules，不引入构建链

**背景**
方案建议 React/Next.js；但本项目同时要求"零依赖""可交付源码""无 source map 泄露风险"。

**决定**
- `index.html` + `src/app/**`（外壳/路由/状态）+ `src/pages/**`（页面）+ `src/components/**` + `src/styles/**`。
- 纯 ES Modules，浏览器直接加载；无打包、无转译、无 CSS 预处理器。
- 服务端只托管白名单静态根：`src/`、`assets/`、`admin/` + `index.html`、`favicon.ico`、`robots.txt`、`manifest.webmanifest`。
- 深色主题默认（遵循 ZHIRAI 品牌与 UI 规范）；响应式断点 640px。

**理由**
1. 源码即产物：客户可审计，无隐藏构建步骤。
2. 无依赖：不引入 React/打包器/PostCSS 等数十个包。
3. 安全：不存在 source map 泄露私有代码的问题；CSP 可用最严格的 `default-src 'self'`。
4. 部署：改前端只需改文件、刷新；不需要 CI 构建。

**替代方案**
- React + Vite：组件生态强、开发效率高，但引入依赖与构建产物。
- Next.js：SSR 强，但需要 Node 服务端渲染流程，与单体静态托管冲突。
- 服务端模板（EJS 等）：交互弱、前后端边界模糊。

**代价**
- 无组件库、无类型检查、无热更新；复杂交互（拖拽、虚拟滚动、富文本）需自研。
- 页面增多后需要严格的目录与命名规范（已写入 CONTRACTS 的文件所有权表）。
- 浏览器兼容以现代常青浏览器为准。

**后果**
- 前端不得包含任何密钥、提示词或服务端逻辑（全局安全规则 §8）。
- 所有权限判断必须在服务端重复执行，前端隐藏按钮不算安全。

---

## ADR-005：模型接入：Provider 抽象 + 默认 simulation

**背景**
方案要求"模型通过可配置 Provider 接口接入，允许 DeepSeek、其他兼容模型或本地模型；模型切换不得要求重写业务逻辑"。

**决定**
- `server/agents/**` 内定义 Provider 接口；实现两种：
  - `openai_compatible`：任意 OpenAI Chat Completions 兼容端点（DeepSeek、OpenAI、本地 vLLM/Ollama 等）。
  - `simulation`：确定性离线输出，用于演示、测试与无密钥环境。
- 选择顺序：工作空间 `integration_credentials(ai_provider)` → `.env` 的 `AI_*` 兜底 → `simulation`。
- 所有角色通过 `runAgent()` 执行；输出必须通过 JSON Schema 校验，失败重试 1 次。
- 每次执行写 `agent_executions` + `usage_records`（含 token 与成本估算）。

**理由**
1. 供应商中立：客户可用 DeepSeek 降本，也可用本地模型保数据。
2. 可测试：simulation 让 CI/离线环境可跑完整流程。
3. 可切换：换模型只改设置/凭据，不改业务代码。
4. 可审计：执行记录让"为什么这么写"可追溯。

**替代方案**
- 直接写死某供应商 SDK：锁定 + 依赖 + 密钥管理复杂。
- 前端直连模型：密钥泄露、提示词泄露（绝对禁止）。
- 只支持本地模型：客户门槛高、效果参差。

**代价**
- 适配层要吸收不同模型的 JSON 遵循度差异（重试 + 容错解析）。
- 成本估算只能是"估算"（价格表需维护）。
- simulation 输出不能代表真实质量，容易被误认为"AI 已可用"（文档必须标注）。

**后果**
- 提示词与输出 Schema 必须版本化（`promptVersion`），否则无法解释历史输出。
- 严禁把模型输出直接当作"支付成功/权限提升/事实确认"的依据。

---

## ADR-006：提示词只在服务端

**背景**
提示词是核心资产；同时用户输入可能包含注入指令，需要服务端统一隔离。

**决定**
- 提示词以服务端文件形式存在（`server/agents/prompts/**` 或等价结构，由 t-agents 实现）。
- 前端只发送"业务参数"（企业 ID、产品 ID、语言），**从不发送提示词**。
- 提示词版本号写入 `agent_executions.prompt_version`，与草稿关联，便于回溯。
- 输入隔离：用户/外部数据放入明确分隔的"数据区"，系统指令在"指令区"，并要求模型忽略数据区内的指令。

**理由**
1. 资产保护：前端代码视为公开代码，提示词放前端等于公开（全局安全规则 §8.5）。
2. 一致性：服务端拼装可保证变量替换、事实清单注入不被绕过。
3. 可审计：版本号 + 执行记录 = 可复现。

**替代方案**
- 提示词存数据库（可在线编辑）：灵活，但需额外版本管理，且增加被越权读取的风险；v1.x 可考虑"只读版本化"。
- 提示词写在前端：绝对禁止。

**代价**
- 修改提示词需要发版（或至少重启）；A/B 测试不便。
- 提示词文件本身需要防止被静态托管（静态根白名单已排除 `server/`，`/docs/` 也禁止访问）。

**后果**
- 任何"在浏览器里改提示词"的需求都应被拒绝或改为"服务端生成候选并人工选择"。

---

## ADR-007：发送默认人工审批

**背景**
欧洲 B2B 冷邮件误发成本极高（域名声誉、投诉、法律风险）；方案明确"初始版本默认人工审批发送""不得将系统设计成无限量自动群发工具"。

**决定**
- 工作空间默认 `outreach.requireApproval = true`、`outreach.autoSendEnabled = false`。
- 草稿状态机：`draft → pending_approval → approved → scheduled → sent | failed`，另有 `rejected/discarded`。
- 发送管线第一道闸校验 `status='approved'`。
- 批量审批可用，但批量审批仍是"人工动作"；自动发送必须由用户显式开启，并受限额/窗口/熔断约束。

**理由**
1. 安全：人是最可靠的最后一道闸。
2. 声誉：一封错发的邮件可能让整个域名进黑名单。
3. 合规：可解释、可撤回、可追责。
4. 商业：客户买的不是"群发量"，而是"有效沟通"。

**替代方案**
- 默认全自动：增长快但风险高，且与方案要求冲突。
- 全手工：无产品价值。

**代价**
- 每日需要人工投入（已提供批量审批与高意向提醒降低负担）。
- "自动发送"能力被刻意弱化，部分客户可能不满意。

**后果**
- 测试必须覆盖"未审批草稿不能发送"。
- 文档必须说明如何安全地逐步开启自动发送（先小批量、观察退信率）。

---

## ADR-008：人工接管的原子语义

**背景**
方案 §9 将"真人接管"列为最高优先级业务安全机制，并要求"必须通过真实任务队列、数据库状态和邮件发送路径测试"。

**决定**
接管是**一个原子操作**，包含（同一事务/紧邻步骤，任一失败需回滚或补偿）：
1. UPSERT `automation_states` → `HUMAN_TAKEOVER`（`UNIQUE(workspace_id, company_id)`）。
2. 将该客户 `follow_up_tasks` 中 `pending` → `cancelled`。
3. `cancelJobsForCompany(workspaceId, companyId, 'human_takeover')`。
4. 写 `audit_events`（`automation.takeover`）。
5. **发送管线在发送前再次读取状态**，不只依赖接管时的取消。
6. 历史数据全部保留（邮件、分类、草稿、任务记录）。
7. 恢复自动化受限：仅 `HUMAN_TAKEOVER/PAUSED/NEEDS_HUMAN_REVIEW → AUTOMATION_ACTIVE`；`DO_NOT_CONTACT` 只能通过删除 `suppression_records` 解除（admin/owner）。

**理由**
1. 竞态：任务可能已被 Worker 领取，仅"取消任务行"不够，必须在发送路径上再校验。
2. 业务：用户接管意味着"这条线索由我负责"，AI 任何自动动作都是事故。
3. 法务：退订/拒联是更高优先级，不能被普通"恢复"按钮绕过。

**替代方案**
- 只在 UI 层隐藏"发送"按钮：完全不安全（API 可直调）。
- 只取消任务不校验状态：存在竞态窗口。

**代价**
- 跨模块契约复杂（t-crm 的状态机 + t-worker 的发送管线 + 队列取消）。
- 测试成本高（需要模拟"任务已领取但未发送"的窗口）。

**后果**
- 发送管线必须有"状态检查"与"任务取消"双重保险。
- 退订链接（公开路由）也会触发 `DO_NOT_CONTACT` + 取消任务（`server/routes/public.mjs` 已实现）。

---

## ADR-009：评分：规则优先，AI 只做解释增强

**背景**
方案要求"建立可解释的客户评分系统""每项评分必须能追溯依据""不能无依据地宣称模型越用越准"。

**决定**
- 评分主体是**确定性规则**（`lead_scores.model_version = 'rules-v1'`）：产品匹配、企业类型、地区、采购场景、信息可信度、联系方式可信度、近期信号、排除规则。
- 输出：`score`（0–100）、`grade`（A/B/C/D）、`factors_json`（每项得分与依据）、`exclusions_json`（排除原因）、`explanation`（可读理由）。
- AI 仅用于"解释增强/原因改写"，不得改变分数。
- 用户修正写入 `score_feedback`（`ai_value_json` vs `user_value_json`），作为规则迭代依据；**不承诺**自动学习提升。

**理由**
1. 可解释：规则可读、可审计、可复现。
2. 稳定：同一输入同一输出，便于测试与客户信任。
3. 成本：评分不需要调用模型（省 token）。
4. 合规：可向客户解释"为什么这家企业分高"。

**替代方案**
- 纯模型打分：不可解释、不稳定、成本高。
- 规则 + 模型混合打分：解释困难，容易变成"黑箱"。

**代价**
- 规则维护靠人工（行业/地区差异需要配置）。
- 灵活度低于模型打分。

**后果**
- 前端必须展示 `factors_json` 与 `exclusions_json`（评分可解释是产品卖点）。
- `score_feedback` 只是数据收集，不能宣称"模型会越来越准"。

---

## ADR-010：专有许可 + 零第三方依赖的商业分发

**背景**
方案第二节要求"独立实现与知识产权边界"；目标包括"收费销售软件"与"销售完整源码"。

**决定**
- 代码许可：专有 / `UNLICENSED`（根目录 `LICENSE`）：禁止未经书面授权的复制、分发、转售、SaaS 化。
- 商业授权：软件授权（自托管份数/席位）、源码授权、白标/OEM 三种，均需合同。
- 第三方依赖：**0 个运行时 npm 依赖、0 行第三方代码**；未来引入必须登记（[LICENSE-REGISTER.md](./LICENSE-REGISTER.md)）。
- 参考项目：仅研究（[RESEARCH.md](./RESEARCH.md)），不进入构建产物。
- 品牌：ZHIRAI / 智睿科技；署名 `ZHIRAI · 智睿科技 · 独立开发者`。

**理由**
1. 法律边界清晰：自有代码 + 无 copyleft 污染 = 可以闭源商业分发。
2. 商业灵活：既能卖"部署授权"，也能卖"源码 + 二次开发权"。
3. 交付简单：无依赖清单争议（当前为空）。
4. 资产保护：提示词、数据模型、界面均为自有。

**替代方案**
- MIT/Apache 开源 + 商业支持：传播快，但竞品可直接复制，与"卖源码"冲突。
- 双许可（开源 + 商业例外）：需要 CLA 与社区治理，个人项目成本高。
- 直接使用 GPL 项目改品牌：违反方案要求，且有法律风险。

**代价**
- 无社区贡献、无生态效应；所有功能自研。
- 客户可能要求"开源审计"，需准备源码审计流程。
- 未来若引入 MIT 依赖，需附带版权声明与许可文本。

**后果**
- 发布物必须包含 `LICENSE`、`LICENSE-REGISTER.md`、`RESEARCH.md`（说明参考关系）。
- 任何第三方代码进入仓库前必须走登记与审批（方案 §2 第 9 条）。

---

## ADR-011：数据模型：显式表 + JSON 扩展，不做 EAV

**背景**
方案给出 31 个候选实体，并要求"根据实际需要合并或拆分，防止过度设计"；同时要求"可配置的通用 B2B 平台"。

**决定**
- 40 张显式表（见 [DATA-MODEL.md](./DATA-MODEL.md)），不做通用对象/字段引擎。
- 可扩展信息用 `*_json` 列：`products.specs_json`、`icps.target_*_json`、`companies.tags_json`、`company_product_matches.reasons_json`、`lead_scores.factors_json` 等。
- 产品规格不单开 `product_specifications` 表（合并进 `products.specs_json`）；`CampaignStep` 独立成表（有唯一 `step_no` 与执行语义）。
- 软删除：`deleted_at`（企业、联系人、产品、活动）；审计与用量长期保留。

**理由**
1. 简单：显式表易读、易索引、易迁移。
2. 性能：核心查询字段有列与索引；JSON 只承载非检索性扩展。
3. 迁移可控：加列比改 EAV schema 简单。
4. 符合"防止过度设计"。

**替代方案**
- EAV / 自定义对象（Twenty 路线）：灵活但查询复杂、类型弱、迁移难、UI 生成成本高。
- 全部 JSON 单表：查询与约束能力丧失。

**代价**
- 行业差异化字段需要改表（发版迁移）。
- JSON 列无法建普通索引（可用生成列，但暂未使用）。

**后果**
- 迁移必须"只增不改"（或提供数据迁移脚本），保证老客户可升级。
- 所有 JSON 列必须有默认值 `'{}'` / `'[]'`，避免 null 判断散落。

---

## ADR-012：多租户：共享库 + workspace_id 行级隔离

**背景**
方案要求"支持单用户自托管、团队用户、多工作空间""必须确保企业数据、联系人、邮件、凭据和商机严格隔离"。

**决定**
- 共享数据库、共享表，所有业务表带 `NOT NULL workspace_id`（外键到 `workspaces`）。
- 仓储层每个查询强制 `WHERE workspace_id = ?`；跨工作空间访问返回 null/空。
- 会话绑定单一工作空间（`sessions.workspace_id`）；切换工作空间需重新登录（v1.0）。
- API Key 同样绑定工作空间。
- 凭据密文 AAD 绑定 `workspaceId:kind:providerKey`，跨工作空间不可解密。

**理由**
1. 简单：单库单文件，备份/迁移最简单。
2. 成本：无需 schema-per-tenant 或 database-per-tenant。
3. 隔离可测：集成测试可建 A/B 两个工作空间验证越权。

**替代方案**
- 一租户一库：隔离最强，但备份/连接/迁移复杂，个人项目维护成本高。
- 一租户一 schema：SQLite 无 schema 概念。

**代价**
- 隔离依赖开发者纪律：任何漏写 `workspace_id` 都是越权漏洞。
- 无法按租户独立备份（需逻辑过滤导出）。

**后果**
- 代码评审必须专项检查"每个 SQL 是否带 workspace_id"。
- 测试必须覆盖跨租户访问（CONTRACTS §9 要求）。
- 未来若做"租户级物理隔离"，需重写仓储层与备份流程。

---

## ADR-013：部署：单机 + 反向代理，不做 Kubernetes

**背景**
客户是外贸企业/个人，不是平台型公司；部署越简单越好。

**决定**
- 支持形态：单机直跑、反向代理（nginx/Caddy）+ HTTPS、面板托管、systemd/pm2 守护。
- 数据目录 `DATA_DIR`（默认 `server/data`）：`outreach.sqlite`、`uploads/`、`logs/`、`backups/`、`secret.key`。
- 备份：`VACUUM INTO`（`/api/v1/ops/backup` 或 `scripts/backup.mjs`）。
- 升级：替换代码 + 重启（迁移自动执行），升级前备份。
- 打包：zip 根目录平铺（解压即得 `index.html`、`server/`、`src/` 等）。

**理由**
1. 运维成本最低；客户 IT 能理解"一个文件夹 + 一个进程"。
2. SQLite 文件不适合网络文件系统/多副本，K8s 反而危险。
3. 反向代理负责 TLS/限流/缓存，Node 进程只监听 127.0.0.1。

**替代方案**
- Docker Compose：方案提过，但会引入镜像维护与依赖；可作为 v1.x 可选发行形态。
- Kubernetes：过度设计，且与 SQLite 单写冲突。
- Serverless：长连接与文件系统不适合。

**代价**
- 无内置高可用；故障恢复依赖守护进程与备份。
- 多客户部署需各自维护实例（对个人开发者是可接受的商业模式，但规模受限）。

**后果**
- [DEPLOY.md](../DEPLOY.md) 必须给出 Windows/Linux 两套步骤、HTTPS、备份恢复、故障排查。
- 文档必须明确"不要用网络盘挂载 `DATA_DIR`"。

---

## 附：如何新增 ADR

1. 编号递增（ADR-014 起），标题用"领域：决定"。
2. 必填：背景、决定、理由、替代方案、代价、后果、状态。
3. 若推翻既有 ADR：旧 ADR 状态改为「已被 ADR-xxx 取代」，不要删除。
4. 涉及第三方代码/许可证的决定，必须同时更新 [LICENSE-REGISTER.md](./LICENSE-REGISTER.md)。

---
<div align="center">

**ZHIRAI · 智睿科技 · 独立开发者**
把想法变成现实 ｜ https://zhirai.cloud
© 2026 智睿科技 保留所有权利。

</div>
