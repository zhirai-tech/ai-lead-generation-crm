# 开源项目研究报告（Open-Source Reference Research）

> 项目：ZHIRAI Europe B2B AI Outreach Platform（智睿欧洲 B2B AI 外贸获客平台）
> 作者：ZHIRAI · 智睿科技 · 独立开发者 ｜ 版本 v1.1.0
> 本文是**研究记录**，不是代码来源。本项目**未复制任何参考项目的源码、文案、素材或品牌**。
> 核验日期：**2026-10-22**（通过 GitHub REST API 读取仓库默认分支 LICENSE 与仓库元数据；未逐文件、未逐依赖、未运行任何参考项目）。

---

## 目录

1. [研究方法与证据等级](#1-研究方法与证据等级)
2. [结论摘要](#2-结论摘要)
3. [A/B/C/D 分类总表](#3-abcd-分类总表)
4. [逐项目研究](#4-逐项目研究)
5. [能力矩阵对比](#5-能力矩阵对比)
6. [值得借鉴的设计点（以及本项目的落地方式）](#6-值得借鉴的设计点以及本项目的落地方式)
7. [外部付费依赖与替代方案](#7-外部付费依赖与替代方案)
8. [商标、数据与授权限制](#8-商标数据与授权限制)
9. [证据缺口与后续核验步骤](#9-证据缺口与后续核验步骤)
10. [最终结论](#10-最终结论)

---

## 1. 研究方法与证据等级

### 1.1 已执行的动作

| 动作 | 说明 | 可复现命令 |
| --- | --- | --- |
| 读取默认分支 LICENSE | 用 GitHub REST `/repos/{owner}/{repo}/license`；该接口返回 `license.spdx_id` 与 LICENSE 文件原文/摘要 | `curl -s https://api.github.com/repos/OWNER/REPO/license` |
| 读取仓库元数据 | `/repos/{owner}/{repo}`：语言、创建时间、最近 push、star/fork、是否归档 | `curl -s https://api.github.com/repos/OWNER/REPO` |
| 交叉核对方案描述 | 与 `欧洲 B2B AI 外贸获客平台.md` 第三节列出的研究重点逐条对照 | — |

### 1.2 证据等级（全文统一标注）

| 标记 | 含义 |
| --- | --- |
| **【已核实】** | 2026-10-22 通过 GitHub API 直接读取仓库默认分支 LICENSE / 仓库元数据得到 |
| **【仓库描述】** | 仓库 description、topics 或 README 的自述；未经运行验证 |
| **【公开资料】** | 广为人知的公开信息（官网、文档、生态常识），本次未逐项读取源码 |
| **【待核实】** | 尚未确认，不得作为事实使用 |
| **【未验证】** | 需要实际安装/运行才能确认 |

### 1.3 明确不做的事

- 不 clone、不构建、不运行任何参考项目（本阶段只做架构研究）。
- 不根据 README 描述推断"功能一定可用"。
- 不因 GitHub 首页显示 MIT 就认定仓库内所有文件、素材、依赖都可无条件商用。
- 不把参考项目的产品文案、界面设计、图标、提示词复制进本项目。

---

## 2. 结论摘要

1. **没有任何一个候选项目适合作为本项目的代码基座。** 最有参考价值的是功能边界与数据流，而不是实现。
2. **许可证层面可分为三档**：
   - 宽松许可、理论可商用：AgentSDR（MIT）、Quick-Enrich-Tools（MIT）、NakatomiCRM（MIT）。
   - 强 copyleft、仅研究：OpenOutreach（GPL-3.0）、OpenEnrich（AGPL-3.0）、Twenty（AGPL-3.0 + 商业企业版文件）、Mautic（GPL-3.0）。
   - 非 OSI 开源、商业分发受限：n8n（Sustainable Use License v1.0 + `.ee.` 文件单独商业授权）。
3. **本项目的最终决定：0 个第三方运行时依赖、0 行第三方源码**（见 [LICENSE-REGISTER.md](./LICENSE-REGISTER.md)）。所有参考项目只进入研究清单，不进入构建产物。
4. **商业分发最需要警惕的不是 MIT，而是"看起来像 MIT"的组合仓库**：Twenty 的仓库根 LICENSE 明确写了"大部分 AGPL-3.0 + 部分商业许可文件 + 部分 MIT 包"；n8n 的 `LICENSE.md` 明确写了"master 以外的分支不受许可"。
5. **产品差异化方向**（由研究反推）：本项目不做"群发器"，把"发送前人工审批 + 真人接管 + 可追溯来源 + 可解释评分"作为一等公民，这是多数参考项目最薄弱、也最适合欧洲 B2B 市场的点。

---

## 3. A/B/C/D 分类总表

分类定义沿用方案第四节：

- **A 类**：可以优先考虑实际使用的宽松许可组件。
- **B 类**：适合研究设计，但需要进一步核实许可证或依赖条件。
- **C 类**：仅作功能参考，未经额外批准不得直接采用其代码。
- **D 类**：存在不清楚的授权、商业限制或高风险依赖，暂不采用。

> **重要**：下表 A 类仅表示"许可证条件允许，若未来需要引入可以作为候选"，**不表示本项目已采用**。截至目前，本项目 `package.json` 无 `dependencies`，`server/**`、`src/**` 全部为独立实现。

| # | 项目 | 地址 | 仓库标示/已核实许可证 | 分类 | 本项目用法 |
| --- | --- | --- | --- | --- | --- |
| 1 | AgentSDR | https://github.com/Kandid-ai/AgentSDR | **MIT【已核实】**（LICENSE sha `45ca1885…`） | **A**（候选，未采用） | 仅研究 Agent 分工、审批与多组织模型 |
| 2 | OpenOutreach | https://github.com/eracle/OpenOutreach | **GPL-3.0【已核实】**（`LICENCE.md` sha `f288702d…`） | **C** | 仅研究 ICP→发现→评分→写信的流程 |
| 3 | Quick-Enrich-Tools | https://github.com/mattvinall/Quick-Enrich-Tools | **MIT【已核实】**（LICENSE sha `f339578e…`） | **A**（候选，未采用） | 仅研究 Discover→Resolve→Crawl→Extract→Enrich→Deliver 编排 |
| 4 | OpenEnrich | https://github.com/openenrich/openenrich | **AGPL-3.0【已核实】**（LICENSE sha `be3f7b28…`） | **C** | 仅研究"多数据源分级瀑布 + 成本控制" |
| 5 | NakatomiCRM | https://github.com/mrdulasolutions/NakatomiCRM | **MIT【已核实】**（LICENSE sha `64f9cf88…`） | **A**（候选，未采用） | 仅研究 Agent 友好 CRM 的接口边界 |
| 6 | Twenty CRM | https://github.com/twentyhq/twenty | **AGPL-3.0（主体）+ 商业许可文件 + 部分 MIT 包【已核实】**（LICENSE sha `7f79939e…`；SPDX 返回 NOASSERTION） | **C**（代码层面接近 **D**） | 仅研究通用 CRM 数据模型与可扩展对象 |
| 7 | Mautic | https://github.com/mautic/mautic | **GPL-3.0-or-later【已核实】**（读取 `7.x` 分支 `LICENSE.txt`；含商标声明与第三方组件清单） | **C** | 仅研究分群、线索评分与触发式跟进 |
| 8 | n8n | https://github.com/n8n-io/n8n | **Sustainable Use License v1.0【已核实】**（`LICENSE.md` sha `f85f59ba…`；SPDX 返回 NOASSERTION；`.ee.` 文件另有商业授权） | **D** | 仅参考工作流编排/重试的表象设计 |

> 说明：Twenty、Mautic、n8n 本次只核验了 LICENSE 文件；star 数、最近提交等元数据未逐仓读取（第二、三批只读取了前 6 个仓库的元数据），因此下文中这三项的维护状态标注为"未逐版本核实"。

---

## 4. 逐项目研究

### 4.1 AgentSDR（Kandid-ai/AgentSDR）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/Kandid-ai/AgentSDR ｜ 官网 https://agentsdr.ai |
| 许可证 | **MIT【已核实】**。LICENSE 文本为 MIT License，`Copyright (c) 2026 Kandid`。GitHub API `license.spdx_id = MIT` |
| 维护状态 | **活跃【已核实】**：仓库创建 2026-10-02，最后一次 push 2026-10-21；53 stars / 14 forks；未归档 |
| 技术栈 | **TypeScript【已核实】**（仓库主语言）。完整框架、数据库、依赖清单**未核实** |
| 核心功能 | 【仓库描述】"Open-source AI SDR：邮件序列、LinkedIn 与 WhatsApp 触达、enrichment tables，以及一个能对每封回复分类并起草答复的 AI CRM。自托管，自带 AI key。"【已核实：description 原文】 |
| 商业分发适配性 | 许可证本身允许闭源商用与再分发，**但必须保留版权与许可声明**。真正风险在：① 其依赖树的许可证（本次未核验）；② 其界面素材、图标、插图来源（未核验）；③ 产品名/logo 的商标（未核验）。若未来引入代码，必须做"固定 tag + 逐依赖 + 逐素材"三项核查 |
| 值得借鉴 | ① 10 个逻辑 Agent 的**职责切分**而不是一个巨型提示词；② 多组织（workspace）隔离；③ 回复分类 + 草稿建议的产品闭环；④ "人工审批"作为默认安全阀；⑤ 自带 AI key（BYO key）降低平台方成本与合规责任 |
| 外部付费依赖 | 【仓库描述】自带 AI key，说明模型为付费第三方（具体服务商未核实）。LinkedIn/WhatsApp 通道在合规与 ToS 上风险高，**本项目 v1.0 不实现**（见 [ROADMAP.md](./ROADMAP.md)） |
| 商标/数据限制 | 名称 "AgentSDR"、logo、域名属其所有者；**本项目不得使用其名称或视觉识别**。其内置模板文案不可复制 |
| 本项目落地方式 | 参考其角色划分，但提示词、数据模型、API、界面 100% 独立设计与实现。**未复制任何代码或文案** |

### 4.2 OpenOutreach（eracle/OpenOutreach）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/eracle/OpenOutreach ｜ 官网 https://openoutreach.app |
| 许可证 | **GPL-3.0【已核实】**（文件名 `LICENCE.md`，内容为 GNU GPL v3 全文；SPDX `GPL-3.0`） |
| 维护状态 | **高活跃【已核实】**：创建于 2016-10-07，最后 push 2026-10-21；3377 stars / 613 forks；未归档 |
| 技术栈 | **Python【已核实】**。具体框架/爬虫库/数据库**未核实** |
| 核心功能 | 【仓库描述】"开源 B2B 线索生成 AI agent：描述你的产品，它找到匹配的人、解释为什么匹配，并从你的邮箱发信。自托管 CLI，一次安装。"【已核实：description 原文】。方案关注点还包括 ICP、候选评分、匹配原因解释 |
| 商业分发适配性 | **不适合作为代码依赖**：GPL-3.0 传染性会使本项目整体需要以 GPL 分发，与"闭源商业授权 + 源码商业分发"的商业模式直接冲突。仅作研究 |
| 值得借鉴 | ① "产品描述 → ICP → 候选 → 评分 → 解释理由"的单向流水线，比"大而全 CRM"更适合作为 MVP 主路径；② **每条推荐必须给出理由**（可解释性），这直接对应本项目的 `lead_scores.explanation` 与 `company_product_matches.reasons_json`；③ CLI 形态证明"单机自托管"可以跑通完整闭环 |
| 外部付费依赖 | 【仓库描述】提到"从你的邮箱发信"，说明至少需要邮箱账号；模型与搜索 API 是否付费**未核实** |
| 商标/数据限制 | 名称与品牌属作者；GPL 代码不得复制；其提示词文本受版权保护 |
| 本项目落地方式 | 借鉴"可解释评分"的产品理念；评分规则、权重、字段、解释文案全部本项目自研（`server/services/scoring.mjs`，规则版本 `rules-v1`）。**未复制任何代码** |

### 4.3 Quick-Enrich-Tools（mattvinall/Quick-Enrich-Tools）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/mattvinall/Quick-Enrich-Tools ｜ 演示 https://quick-enrich-tools.vercel.app |
| 许可证 | **MIT【已核实】**（LICENSE sha `f339578e…`，`Copyright (c) 2026 QuickEnrich`） |
| 维护状态 | **低频【已核实】**：创建 2026-03-16，最后 push 2026-04-29（距今约半年）；4 stars / 1 fork；1 个 open issue；未归档 |
| 技术栈 | **Python【已核实】**为主语言；topics 显示 FastAPI、Next.js、Supabase、web-scraping【已核实：topics 原文】 |
| 核心功能 | 【仓库描述】"开源线索补全工具套件——6 个可克隆、可定制、可自托管的免费工具。" 方案关注点：企业网站发现、公司信息提取、类别/地区筛选、联系人补全，以及 `Discover → Resolve → Crawl → Extract → Enrich → Deliver` 的流水线 |
| 商业分发适配性 | MIT 允许商用；但**外部数据提供商接口通常有独立 ToS**（费用、缓存、再分发限制），这些条款不随 MIT 授权。**未核实**其实际接入哪些付费 provider |
| 值得借鉴 | ① 把"发现"拆成可独立重试的阶段，每阶段落库（本项目对应 `discovery_runs` + `background_jobs` 的任务类型）；② 每个阶段可替换数据源（adapter 思路），对应本项目的 `external_providers.adapter`；③ 明确"免费工具"与"付费 provider"的边界，这与本项目"零依赖 + 可选 BYO 数据源"的定位一致 |
| 外部付费依赖 | 线索补全类项目通常接 Apollo / Hunter / Clearbit / 搜索引擎 API；具体清单**未核实**。本项目默认**不接任何付费数据源**，只提供可配置适配器槽位 |
| 商标/数据限制 | 名称属作者；其演示站与截图不可复用；抓取行为须遵守目标站点 robots/ToS（本项目在 `settings.enrichment.crawlUserAgent` 中声明 UA，并在 [COMPLIANCE.md](./COMPLIANCE.md) 给出约束） |
| 本项目落地方式 | 借鉴阶段化流水线；实现为本项目自写的 `server/services/discovery.mjs` + `jobs` 任务类型（`discovery.search`/`company.crawl`/`company.enrich`/`contact.verify`）。**未复制任何代码** |

### 4.4 OpenEnrich（openenrich/openenrich）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/openenrich/openenrich ｜ 官网 https://openenrich.dev |
| 许可证 | **AGPL-3.0【已核实】**（LICENSE sha `be3f7b28…`，AGPL v3 全文） |
| 维护状态 | **中等/趋缓【已核实】**：创建 2026-07-20，最后 push 2026-08-29；10 stars / 1 fork；0 open issues；未归档 |
| 技术栈 | **TypeScript【已核实】**（主语言）。依赖清单**未核实** |
| 核心功能 | 【仓库描述】"开源线索补全瀑布流。免费本地引擎，自带 provider key（约 $0.01/lead），面向 AI agent 的 MCP server。AGPL-3.0。"【已核实：description 原文】。方案关注：邮箱模式推断、邮箱验证、多数据源分级查询、数据成本控制、MCP 接口 |
| 商业分发适配性 | **AGPL-3.0 不适合作为闭源产品依赖**：网络服务条款（§13）要求向远程用户提供对应源码，与商业闭源分发冲突。仅研究 |
| 值得借鉴 | ① **分级瀑布（waterfall）**：先用免费/低成本源，命中即停；本项目在 `enrichment` 设置中用 `maxEmailsPerDomain`、`verifyMx`、`maxPagesPerDomain` 控制成本上限；② **成本可见**：本项目用 `usage_records`（`data_lookup`/`crawl` 分类）+ `cost_estimate` 记录每次外部消耗；③ MCP 作为对外接口的形态，本项目 v1.0 只做 REST + API Key，MCP 列入 [ROADMAP.md](./ROADMAP.md) |
| 外部付费依赖 | 【仓库描述】"bring your own provider keys（~$0.01/lead）"，说明其价值依赖多个付费数据源。本项目**不捆绑**任何数据源 |
| 商标/数据限制 | AGPL 代码不可复制；其 provider 集成代码同样受 AGPL 约束 |
| 本项目落地方式 | 借鉴"分级 + 命中即停 + 成本上限"的设计原则；邮箱推断与校验由本项目自写（语法 + 域名规范化 + 可选 MX 查询），**推测邮箱一律标记 `inferred`，不得标记 `valid`**（见 [DATA-MODEL.md](./DATA-MODEL.md) §4 不变量） |

### 4.5 NakatomiCRM（mrdulasolutions/NakatomiCRM）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/mrdulasolutions/NakatomiCRM |
| 许可证 | **MIT【已核实】**（LICENSE sha `64f9cf88…`，`Copyright (c) 2026 Nakatomi contributors`） |
| 维护状态 | **活跃【已核实】**：创建 2026-04-18，最后 push 2026-10-02；12 stars / 4 forks；10 open issues；未归档 |
| 技术栈 | **Python【已核实】**；topics 含 FastAPI、MCP【已核实：topics 原文】 |
| 核心功能 | 【仓库描述】"Open-source, agent-first CRM。通过 MCP、REST、A2A 为 AI agent 提供持久业务状态。可自托管。MIT。"【已核实】 |
| 商业分发适配性 | MIT 允许商用；仍需核查依赖与素材。**其"agent-first"接口设计是研究重点，不是代码来源** |
| 值得借鉴 | ① 把 CRM 数据设计成"Agent 可安全读写"的接口，而不是让 Agent 直接连数据库——这正是本项目"所有 Agent 通过统一业务接口、禁止绕过权限系统"的原则来源之一（见 [ARCHITECTURE.md](./ARCHITECTURE.md) §5）；② 操作记录（audit）作为一等公民；③ 小体量项目却把 `REST + MCP + A2A` 三种入口并列，说明"接口层可插拔"是可行路线 |
| 外部付费依赖 | 未发现强制付费依赖（**未核实**） |
| 商标/数据限制 | 名称属作者；"Nakatomi" 为影视文化引用，商用命名需谨慎（本项目不使用） |
| 本项目落地方式 | 借鉴"Agent 通过受限接口访问业务数据"的原则；本项目实现为 `capability` 权限矩阵 + `recordAudit` + API Key（`zrk_…`）。**未复制任何代码** |

### 4.6 Twenty CRM（twentyhq/twenty）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/twentyhq/twenty ｜ 官网 https://twenty.com |
| 许可证 | **混合授权【已核实】**。仓库根 LICENSE 原文要点：① 项目**大部分**为 AGPLv3；② 文件头标注 `/* @license Enterprise */` 的文件**不属于 AGPLv3**，适用文末的商业许可条款；③ 部分包（CLI、SDK、`twenty-ui`、`packages/twenty-apps` 等）为 **MIT**；④ 针对 AGPLv3 §7 附加了一条"Twenty Application Exception"（通过官方 Application Interfaces 构建的应用不因自身而被 AGPL 覆盖），但**修改 Twenty 本体仍适用 AGPLv3 含 §13**；⑤ 该附加许可不授予商标权（见其 `TRADEMARK.md`）。GitHub API 的 `license.spdx_id` 返回 `NOASSERTION`，即官方也不认为它是单一标准许可证 |
| 维护状态 | 大型活跃商业开源项目；**本次未读取仓库元数据**，star/提交频率**未逐版本核实** |
| 技术栈 | 【公开资料】TypeScript 全栈（NestJS + React + PostgreSQL + GraphQL/REST），可自托管。本次未核验具体版本 |
| 核心功能 | 【公开资料】通用 CRM：公司、联系人、商机、任务、自定义对象、权限、API/Webhook。方案关注：可扩展业务对象、权限系统 |
| 商业分发适配性 | **不能把整个仓库视为 MIT**。若要复用其代码：主体须遵守 AGPL-3.0（含网络条款），企业版文件须另行商业授权，MIT 包可单独使用但仍需保留声明。**对本项目结论：只研究数据模型，不引入任何代码** |
| 值得借鉴 | ① 公司/联系人/商机/活动四张主表 + 自定义字段扩展的建模思路；② 权限粒度（对象级 + 字段级）的取舍；③ "可扩展对象"的代价（schema 演进复杂、查询成本上升）——本项目选择**显式表 + JSON 扩展列**，不做通用 EAV |
| 外部付费依赖 | 【公开资料】其托管版与企业版为付费产品；自托管本体不强制付费 |
| 商标/数据限制 | "Twenty" 名称与 logo 受商标保护，其 LICENSE 明确不授予商标权；不得使用其品牌 |
| 本项目落地方式 | 参考 CRM 实体关系，但本项目 ER 由 `001_init.sql` + `002_product_media_attachments.sql` 独立设计（40 张业务表，见 [DATA-MODEL.md](./DATA-MODEL.md)）。**未复制任何代码、schema 或界面** |

### 4.7 Mautic（mautic/mautic）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/mautic/mautic ｜ 官网 https://www.mautic.org |
| 许可证 | **GPL-3.0-or-later【已核实】**（读取 `7.x` 分支 `LICENSE.txt`：正文为 GPLv3，并写明 "Mautic is released under the GPL v3"）。同文件还列出大量第三方组件（Bootstrap、jQuery、Symfony、Doctrine、mPDF 等）及其各自许可证，其中 mPDF 为 GPL、Joomla HTTP 为 GPL2+ |
| 维护状态 | 老牌开源营销自动化项目，长期维护；**本次未读取仓库元数据**，具体版本节奏**未逐版本核实** |
| 技术栈 | 【公开资料】PHP（Symfony）+ MySQL/MariaDB。本次未核验具体版本 |
| 核心功能 | 【公开资料】客户分群、营销活动、自动化流程、线索评分、触发式跟进、邮件模板与落地页 |
| 商业分发适配性 | **GPL-3.0 不适合作为本项目依赖**。仅研究。另注意其 LICENSE 本身就提示"捆绑了 GPL 兼容但不同许可的第三方组件"——这正是"仓库级许可证 ≠ 全仓库可用"的典型例证 |
| 值得借鉴 | ① 分群（segment）+ 活动（campaign）+ 触发（trigger）三件套的心智模型；② 线索评分需要**可配置规则**而非硬编码；③ 邮件模板变量替换的工程做法（本项目用 `campaign_steps.subject_template/body_template` + 草稿生成，而非在前端拼字符串） |
| 外部付费依赖 | 本体免费；邮件送达依赖自有 SMTP/第三方 ESP（费用由用户承担） |
| 商标/数据限制 | LICENSE 明文："Mautic is a trademark of the Mautic project of the Open Source Collective"——商标与代码授权分离，**本项目不得使用该名称/logo** |
| 本项目落地方式 | 借鉴"分群 + 活动 + 触发"的概念，映射为 `icps` + `campaigns`/`campaign_steps`/`campaign_targets` + `follow_up_tasks`。**未复制任何代码** |

### 4.8 n8n（n8n-io/n8n）

| 项目 | 内容 |
| --- | --- |
| 地址 | https://github.com/n8n-io/n8n ｜ 官网 https://n8n.io |
| 许可证 | **Sustainable Use License v1.0【已核实】**（`LICENSE.md` sha `f85f59ba…`）。原文要点：① 非 master 分支的内容**不受许可**；② 文件名含 `.ee.` 或目录名含 `.ee` 的源码**不属于 SUL**，需有效的 n8n Enterprise License；③ 第三方组件按各自原许可；④ SUL 仅允许"内部业务用途或非商业/个人用途"，对外分发仅限**免费、非商业**目的；⑤ 不得移除许可/版权声明；⑥ 含专利条款与商标条款。GitHub API 返回 `NOASSERTION` |
| 维护状态 | 大型活跃商业开源项目；**本次未读取仓库元数据**，未逐版本核实 |
| 技术栈 | 【公开资料】TypeScript / Node.js，节点式工作流引擎。本次未核验具体版本 |
| 核心功能 | 【公开资料】可视化工作流编排、外部系统连接、事件触发、重试与错误处理、定时任务 |
| 商业分发适配性 | **D 类**：SUL 明确限制商业分发（不能把 n8n 或其衍生作品作为付费产品分发），部分目录还需企业授权。对本项目而言不仅"不能复制代码"，也"不能把 n8n 打包进付费发行物" |
| 值得借鉴 | ① 节点/步骤的可视化与可重试语义；② 失败重试与死信（dead）状态机；③ 定时触发的调度分层。**本项目不引入其运行时**，而是用数据库任务表 + 内置 Worker 实现等价能力（见 [ARCHITECTURE.md](./ARCHITECTURE.md) §6） |
| 外部付费依赖 | 【公开资料】云版与企业版付费；企业版节点（`.ee.`）需授权 |
| 商标/数据限制 | SUL 含商标条款；"n8n" 名称与 logo 不得使用 |
| 本项目落地方式 | 只参考"任务状态机 + 重试 + 死信"的通用工程模式（这属于通用编程模式，不受版权保护）；实现完全自写（`server/jobs/queue.mjs`、`server/jobs/worker.mjs`）。**未复制任何代码** |

---

## 5. 能力矩阵对比

> 符号：✅ 明确具备；◐ 部分具备/需配置；— 不具备或未发现。所有判定基于【仓库描述】与【公开资料】，**未运行验证**。

| 能力 | AgentSDR | OpenOutreach | Quick-Enrich | OpenEnrich | NakatomiCRM | Twenty | Mautic | n8n | **本项目 v1.0** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 企业/联系人主数据 | ✅ | ◐ | ◐ | — | ✅ | ✅ | ◐ | — | ✅ |
| ICP / 目标客户画像 | ◐ | ✅ | ◐ | — | — | ◐ | ◐ | — | ✅ |
| 企业发现（搜索/抓取） | ◐ | ✅ | ✅ | ◐ | — | — | — | ◐ | ✅（公开网页 + 可配置适配器） |
| 数据补全 / 邮箱推断 | ◐ | ◐ | ✅ | ✅ | — | — | — | ◐ | ✅（`inferred` 状态隔离） |
| 可解释评分 | ◐ | ✅ | — | — | — | — | ◐ | — | ✅（规则评分 `rules-v1`） |
| 多语言开发信生成 | ✅ | ◐ | — | — | — | — | ◐ | — | ✅（服务端提示词 + 审批） |
| 发送前人工审批 | ✅ | ◐ | — | — | — | — | — | — | ✅（默认强制） |
| 真人接管（AI 停止自动回复） | ◐ | — | — | — | — | — | — | — | ✅（原子状态 + 取消任务） |
| 退订 / 抑制名单 | ◐ | ◐ | — | — | — | — | ✅ | — | ✅（邮箱/域名双维度） |
| 回复分类 + 意向 | ✅ | ◐ | — | — | — | — | ◐ | — | ✅（11 类标签 + 置信度） |
| CRM 商机/管道 | ✅ | — | — | — | ✅ | ✅ | ◐ | — | ✅ |
| 多工作空间隔离 | ✅ | — | — | — | ◐ | ✅ | ◐ | ◐ | ✅（所有业务表 `workspace_id`） |
| Agent 工具化接口（MCP 等） | — | — | — | ✅ | ✅ | ◐ | — | ◐ | ◐（REST + API Key；MCP 列入路线图） |
| 零第三方运行时依赖 | — | — | — | — | — | — | — | — | ✅（本项目特有） |
| 可闭源商业分发 | ✅ | ❌ GPL | ✅ | ❌ AGPL | ✅ | ❌ AGPL | ❌ GPL | ❌ SUL | ✅（自有版权） |

---

## 6. 值得借鉴的设计点（以及本项目的落地方式）

| # | 借鉴点 | 来源 | 本项目落地 | 对应文件 |
| --- | --- | --- | --- | --- |
| 1 | Agent 按职责拆分，避免单一巨型提示词 | AgentSDR、方案 §6 | 11 个角色 Agent（含 `keyword_research`），服务端提示词文件化，统一 `runAgent()` 入口 | `server/agents/**` |
| 2 | 每条推荐必须给理由 | OpenOutreach | `lead_scores.factors_json` + `explanation`；`company_product_matches.reasons_json` | `server/services/scoring.mjs` |
| 3 | 阶段化数据流水线、可重试 | Quick-Enrich-Tools | `discovery_runs` + `background_jobs` 任务类型 | `server/jobs/**` |
| 4 | 分级数据源、命中即停、成本上限 | OpenEnrich | `settings.enrichment` 上限 + `usage_records.cost_estimate` | `server/services/settings.mjs` |
| 5 | Agent 只能通过受限接口访问业务数据 | NakatomiCRM | capability 矩阵 + 服务层封装 + 审计 | `server/core/auth.mjs`、`server/routes/**` |
| 6 | 通用 CRM 四实体 + 可扩展字段 | Twenty | 显式表 + `*_json` 扩展列，不做 EAV | `001_init.sql` |
| 7 | 分群 + 活动 + 触发 | Mautic | `icps` + `campaigns/steps/targets` + `follow_up_tasks` | `001_init.sql` |
| 8 | 任务状态机 + 重试 + 死信 | n8n（通用模式） | `background_jobs.status ∈ queued/running/succeeded/failed/cancelled/dead` | `001_init.sql` |
| 9 | 退订是一等公民 | Mautic、方案 §7/§9 | 公开退订链接（HMAC token）+ `suppression_records` + 自动置 `DO_NOT_CONTACT` | `server/routes/public.mjs` |
| 10 | BYO key 降低平台成本 | AgentSDR、OpenEnrich | 凭据服务端 AES-256-GCM 加密存储；默认离线模拟 Provider | `server/services/settings.mjs`、`server/core/crypto.mjs` |

> 以上均为**设计理念**层面的借鉴。理念、通用业务流程、公开协议不受版权保护；本项目所有表达（代码、提示词、界面、文档）均为独立创作。

---

## 7. 外部付费依赖与替代方案

> 本项目**不强制任何外部付费服务**。默认离线可用（内置 simulation Provider + 模拟邮箱）。下表为"若用户希望接入"的候选，费用为量级参考，**未逐项核实最新价格**，需以供应商官网为准。

| 类别 | 候选服务 | 用途 | 计费模式（量级，待核实） | 可替代方案 | 本项目当前状态 |
| --- | --- | --- | --- | --- | --- |
| AI 模型 | DeepSeek / OpenAI 兼容接口 / 本地模型 | 写信、分类、评分解释、质量审查 | 按 token 计费 | 任何 OpenAI 兼容端点；本地 vLLM/Ollama | ✅ 已支持 OpenAI 兼容适配器 + 内置模拟；具体端点由用户填 |
| 搜索 API | Bing/Brave/SerpAPI 等 | 企业发现 | 按查询计费 | 用户 CSV 导入；公开网页抓取 | ✅ 适配器槽位（`search_api`，默认关闭） |
| 企业数据 | Apollo / Clearbit / 类似 | 企业信息补全 | 按条计费 | 用户导入；公开网页 | ✅ 适配器槽位（`company_enrichment`，默认关闭） |
| 邮箱验证 | ZeroBounce / 类似 | 邮箱可达性 | 按条计费 | 自建语法 + MX 查询（免费） | ✅ 内置 DNS MX 校验（`mx_verification`） |
| 邮件发送 | 自有 SMTP / 企业邮箱 / ESP API | 发送与收件 | 免费（自有）或按量 | 任意 SMTP/IMAP 提供商 | ✅ 自写 SMTP/IMAP 客户端 + 模拟邮箱 |
| 托管 | 任意 VPS / 面板 | 部署 | 按月 | 本机自托管 | ✅ 单进程、SQLite，最低 1 vCPU / 512MB 量级可跑（**未压测**） |

**成本控制机制（本项目已实现）**：`usage_records` 记录 `ai_tokens/email_sent/data_lookup/agent_run/crawl`；`settings.limits` 提供日 token/日邮件/小时任务上限；`agent_executions.cost_estimate` 记录单次估算成本；`/api/v1/usage` 提供汇总。

---

## 8. 商标、数据与授权限制

| 类型 | 风险点 | 本项目处置 |
| --- | --- | --- |
| 代码许可证 | GPL/AGPL/SUL 传染或限制商业分发 | 一律不引入；`package.json` 无运行时依赖；见 [LICENSE-REGISTER.md](./LICENSE-REGISTER.md) |
| 商标 | 参考项目名称、logo、域名 | 不使用；本项目品牌为 ZHIRAI / 智睿科技 |
| 界面素材 | 截图、图标、插图、字体 | 不复用；本项目使用自有品牌素材（`assets/brand/`）与系统字体栈 |
| 文案/提示词 | README 文案、邮件模板、系统提示词 | 不复用；提示词为本项目独立撰写 |
| 数据集 | 抓取到的企业数据、联系人数据 | 每条企业/联系人必须写 `company_sources`/`contact_sources`（来源、URL、抓取时间、置信度） |
| 目标站点 ToS | 抓取公开网页可能违反站点条款 | 只抓公开页面；声明 UA；遵守 robots（**v1.0 未实现 robots.txt 自动解析，见风险表**）；限速 |
| 个人数据 | 联系人邮箱/姓名属个人数据 | 见 [COMPLIANCE.md](./COMPLIANCE.md)：合法依据、最小化、退订、保留期限 |
| 模型输出 | 可能复述受版权保护的文本 | 提示词约束"不得编造事实"；草稿保存 `guard_json`/`quality_json` 以便追溯 |

---

## 9. 证据缺口与后续核验步骤

以下事项在本次研究中**未完成**，发布商用版本前必须补齐（括号内为建议执行人/方式）：

1. **逐依赖许可证扫描**：对任何未来引入的第三方包运行许可证扫描（如 `license-checker` / `pip-licenses`），确认无 GPL/AGPL/SSPL/Commons Clause。（工程）
2. **逐文件许可证核对**：AgentSDR、Quick-Enrich-Tools、NakatomiCRM 虽然根 LICENSE 为 MIT，但需确认是否存在子目录独立许可证（参考 Mautic/Twenty 的反例）。（工程）
3. **素材来源审计**：确认参考项目内的图片/图标/字体不被复用；本项目 `assets/brand/**` 需保留自有版权说明。（设计 + 法务）
4. **商标检索**：对 "ZHIRAI / 智睿" 在目标市场（EU）的商标可用性做检索；对参考项目名称仅做"不使用"确认。（法务）
5. **数据源 ToS**：若未来接入任何企业数据/搜索 API，逐家确认是否允许缓存、是否允许再分发、是否允许用于 AI 训练。（法务 + 产品）
6. **robots.txt / 抓取合规**：v1.0 未自动解析 robots.txt，需在 v1.x 补齐或在使用文档中明确人工责任。（工程）
7. **参考项目运行验证**：本文所有功能均未运行验证；若某功能被列为"借鉴"，只表示其**存在**，不表示"可以照搬"。（工程）
8. **价格核验**：第 7 节费用均为量级参考，需按供应商当期定价更新。（产品）

---

## 10. 最终结论

- **最适合本项目的架构**：单体 Node.js 服务 + SQLite（WAL）+ 数据库任务表 + 内置 Worker + 原生前端 + 服务端提示词。理由见 [ARCHITECTURE.md](./ARCHITECTURE.md) §2 与 [DECISIONS.md](./DECISIONS.md) ADR-001/003。
- **最值得研究的项目**：AgentSDR（Agent 分工与审批）、OpenOutreach（可解释评分的产品理念）、Quick-Enrich-Tools（阶段化流水线）、OpenEnrich（分级瀑布与成本控制）、NakatomiCRM（Agent 友好接口）、Twenty（CRM 建模与可扩展对象的代价）、Mautic（分群/活动/触发）、n8n（任务状态机，仅通用模式）。
- **仅参考设计**：OpenOutreach、OpenEnrich、Twenty、Mautic、n8n（GPL/AGPL/SUL）。
- **可考虑实际采用的组件（本次未采用）**：AgentSDR、Quick-Enrich-Tools、NakatomiCRM（MIT），但必须先完成 §9 的第 1–3 项核查。**本项目当前选择 0 依赖。**
- **需要特别谨慎的许可证/商业条款**：AGPL-3.0（网络条款）、GPL-3.0（传染）、Sustainable Use License（禁止商业分发）、Twenty 的"AGPL + 企业文件 + MIT 包"混合结构、Mautic 的"GPL + 商标声明 + 第三方组件清单"。
- **如何确保以自己的品牌商业销售并分发源码**：自有代码 + 自有数据模型 + 自有提示词 + 自有界面 + 0 第三方运行时依赖 + 明确的专有许可（见根目录 `LICENSE`）+ 第三方登记册（[LICENSE-REGISTER.md](./LICENSE-REGISTER.md)）+ 发布前法律核查。
- **发布前必须进一步核查的问题**：见 §9 全部 8 项。
- **建议的第一项实际开发工作**：已完成——数据库 schema（`server/db/migrations/001_init.sql`）与核心基础设施（`server/core/**`），因为它们是所有模块的契约基座。

---
<div align="center">

**ZHIRAI · 智睿科技 · 独立开发者**
把想法变成现实 ｜ https://zhirai.cloud
© 2026 智睿科技 保留所有权利。

</div>
