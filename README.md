# ZHIRAI Europe B2B AI Outreach Platform

**智睿欧洲 B2B AI 外贸获客平台** ｜ 自托管 · 零第三方运行时依赖 · 可闭源商业分发

> 从「产品资料 → 理想客户画像（ICP）→ 欧洲目标企业 → 可解释评分 → 个性化开发信 → 人工审批 → 发送 → 回复识别 → 真人接管 → CRM 成交」的一体化工作台。
> 默认**不自动群发**：每条外发邮件都经过人工审批；真人接管后 AI 立即停止自动动作。

[![Node](https://img.shields.io/badge/Node-%E2%89%A522.5-339933?style=flat-square)](#环境要求)
[![Dependencies](https://img.shields.io/badge/runtime%20deps-0-blue?style=flat-square)](docs/LICENSE-REGISTER.md)
[![License](https://img.shields.io/badge/license-Proprietary-lightgrey?style=flat-square)](LICENSE)

> **v1.1.0 状态**：15 个前端页面模块 / 16 条路由、11 个 Agent 角色、161 条 API 路由；产品图片/PDF 资料、AI 关键词、邮件 PDF 附件与公开签名链接已集成。自动化测试 **309 项（308 通过 / 1 跳过 / 0 失败）**，安全与媒体 E2E **16/16**，详见 [CHANGELOG.md](CHANGELOG.md) 与 [docs/VERIFICATION.md](docs/VERIFICATION.md)。

---

## 目录

- [这是什么](#这是什么)
- [核心能力](#核心能力)
- [架构简述](#架构简述)
- [环境要求](#环境要求)
- [快速开始](#快速开始)
- [目录结构](#目录结构)
- [配置说明](#配置说明)
- [常用命令](#常用命令)
- [数据与备份](#数据与备份)
- [文档索引](#文档索引)
- [许可证与商业授权](#许可证与商业授权)
- [安全与合规](#安全与合规)
- [免责声明](#免责声明)

---

## 这是什么

一个面向**欧洲 B2B 市场**的 AI 外贸获客系统，第一批场景是汽车零部件与新能源汽车供应链（如电池包支架），但行业、国家、产品、企业类型全部可配置，**不写死**。

它解决的问题：

| 痛点 | 本产品的做法 |
| --- | --- |
| 客户从哪来 | 公开网页发现 + CSV 导入 + 可配置数据源适配器，每条记录带来源与抓取时间 |
| 谁值得跟 | 规则评分（`rules-v1`）+ 匹配原因 + 排除原因，**可解释、可复现** |
| 开发信怎么写 | 服务端提示词 + 产品事实库约束，**不允许编造认证/产能/价格/案例** |
| 会不会乱发 | 默认人工审批 + 发送窗口 + 日限额 + 退订/抑制 + 接管拦截 |
| 回复怎么看 | 11 类意向标签 + 置信度 + 原文依据 + 建议回复，高意向即时提醒 |
| 人接手后 AI 还发吗 | 接管是原子状态：取消待办与后台任务，且**发送前再次校验** |
| 数据在哪 | 全部在客户自己的服务器（SQLite 单文件），不上传第三方 SaaS |

**不是**：邮件群发器、通用 CRM、开源项目拼装包、LinkedIn/WhatsApp 自动化工具。

---

## 核心能力

- **企业与联系人主数据**：企业/联系人/来源/校验记录/去重（域名、邮箱唯一约束），支持角色分类与邮箱可信度分级（`unverified/valid/risky/invalid/inferred`）。
- **产品与 ICP**：产品规格/认证/产能/MOQ/交期；**主图与 PDF 资料上传、AI 生成 B2B 关键词**；ICP 支持目标国家、地区、企业类型、规模、角色、关键词与排除词、最低分。
- **发现与补全**：发现批次（`discovery_runs`）、网页抓取、CSV 导入、邮箱推断（推测邮箱一律标记 `inferred`）、DNS MX 校验；目标国家支持「全选欧洲 / 随机 8 国 / 清空」，**不选国家 = 全部市场**。
- **评分与匹配**：规则评分、A/B/C/D 分级、因素与排除项、人工修正反馈。
- **开发信与审批**：模板 + AI 草稿 + 合规检查 + 质量审查；**自动附加产品 PDF 并在正文写入公开签名链接**；草稿状态机 `draft → pending_approval → approved → scheduled → sent`。
- **发送安全**：五道闸（审批/抑制/接管/窗口/限额）+ 全局暂停 + 重复发送检测 + 退信熔断（契约）。
- **回复与收件箱**：IMAP 同步、线程关联、意向分类、建议回复、高意向通知。
- **真人接管**：6 态自动化状态机；接管后取消待办与任务；`DO_NOT_CONTACT` 不可用普通恢复解除。
- **CRM**：商机管道、销售活动时间线、跟进任务。
- **运维**：任务队列/Worker/重试/取消/统计、审计日志、用量与成本、热备份、系统维护台（`/admin`）。
- **零依赖**：`package.json` 无 `dependencies`，只用 Node 内置模块。

---

## 架构简述

```text
浏览器（原生 ES Modules，无构建）
        │  HTTPS + Cookie 会话 + CSRF
        ▼
Node.js 单进程（≥22.5）
  ├─ server/core        基础设施：HTTP/鉴权/加密/审计/校验/限流/日志
  ├─ server/routes      路由（薄层：校验 → service）
  ├─ server/services    业务规则、事务、审计、通知、入队
  ├─ server/repositories SQL + 行映射（强制 workspace_id）
  ├─ server/agents      11 个角色 Agent + Provider 抽象 + 服务端提示词
  ├─ server/jobs        数据库任务表 + Worker + 发送管线（含 PDF 附件）
  ├─ server/mail        SMTP / MIME / IMAP / 模拟邮箱
  └─ server/db          SQLite（WAL）迁移
        │
        ▼
DATA_DIR：outreach.sqlite · uploads/products（图片/PDF）· logs/ · backups/ · secret.key
```

**关键取舍**（详见 [docs/DECISIONS.md](docs/DECISIONS.md)）：
Node + SQLite 零依赖（ADR-001）、单体 + 内置 Worker（ADR-002）、数据库任务表（ADR-003）、原生前端（ADR-004）、Provider 抽象（ADR-005）、提示词只在服务端（ADR-006）、默认人工审批（ADR-007）、接管原子语义（ADR-008）、规则优先评分（ADR-009）、专有许可（ADR-010）。

---

## 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | **≥ 22.5**（使用内置 `node:sqlite`；建议 22 LTS 最新版） |
| 操作系统 | Windows 10/11、Linux（Debian/Ubuntu/CentOS 等）、macOS |
| 内存 | 建议 ≥ 512 MB 可用（🔶 未压测） |
| 磁盘 | 建议 ≥ 2 GB（数据库 + 备份 + 上传） |
| 浏览器 | 近两年的 Chrome / Edge / Firefox / Safari |
| npm | 仅用于运行脚本，**不需要 `npm install`**（无依赖） |

---

## 快速开始

### Windows

```powershell
# 1) 进入目录（解压后的根目录）
cd C:\zhirai-outreach

# 2) 初始化数据库（创建目录 + 应用迁移，可重复执行）
npm run init-db

# 3) 启动
npm start
```

### Linux / macOS

```bash
cd /opt/zhirai-outreach
npm run init-db
npm start
```

### 首次访问

1. 浏览器打开 **http://127.0.0.1:4173**（默认端口 **4173**）。
2. 首次打开会自动进入**初始化向导**：填写工作空间名称、管理员姓名、邮箱、密码（≥10 位，含字母与数字）。
3. 初始化完成后自动登录，进入工作台。
4. 建议立即按以下顺序配置：
   - **系统设置 → 合规**：填写发件公司名、地址、隐私政策 URL；
   - **系统设置 → AI 模型**：选择模型 Provider（默认内置模拟，可离线试用）；
   - **系统设置 → 邮箱账户**：添加发件邮箱（或先用模拟邮箱体验完整流程）；
   - **产品资料 → 客户画像 → 企业发现**：录入一个真实产品（含主图/PDF/关键词）与目标客户画像，跑一次发现。

> 默认监听 `127.0.0.1:4173`，只允许本机访问。生产环境请用反向代理 + HTTPS，见 [DEPLOY.md](DEPLOY.md)。
> 系统维护台：**http://127.0.0.1:4173/admin**（需 owner/admin 登录，可查看系统状态、备份、日志、许可证信息）。

---

## 目录结构

```text
.
├─ index.html                 # 工作台入口（原生 ESM 加载 src/app/main.mjs）
├─ manifest.webmanifest       # PWA 清单
├─ package.json               # 脚本与元信息（无 dependencies）
├─ .env.example               # 环境变量示例（复制为 .env）
├─ LICENSE                    # 专有许可（商业授权）
├─ README.md
├─ DEPLOY.md                  # 部署、HTTPS、备份恢复、故障排查
├─ CHANGELOG.md
├─ admin/                     # 系统维护台（静态页面，走同一服务端 API）
│  ├─ index.html
│  ├─ admin.css
│  └─ admin.js
├─ assets/brand/              # ZHIRAI 品牌素材（logo / favicon / app-icons）
├─ src/                       # 前端（原生 ESM，无构建）
│  ├─ app/                    # 启动、路由、外壳、API 客户端、状态、图标
│  ├─ components/             # UI 组件与图表
│  ├─ pages/                  # 各功能页面
│  ├─ styles/                 # tokens/base/layout/components/pages
│  └─ utils/                  # DOM 与格式化工具
├─ server/                    # 服务端（Node ESM）
│  ├─ index.mjs               # 启动入口：迁移 → 监听 → Worker
│  ├─ app.mjs / config.mjs
│  ├─ core/                   # db/http/auth/crypto/audit/validate/ids/time/logger/rate-limit
│  ├─ db/migrations/          # 001_init.sql + 002_product_media_attachments.sql（40 张业务表，含迁移表共 41）
│  ├─ repositories/           # SQL + 行映射
│  ├─ services/               # 业务规则
│  ├─ routes/                 # HTTP 路由
│  ├─ agents/                 # Provider、提示词、11 个角色
│  ├─ jobs/                   # 队列、Worker、调度、发送管线
│  ├─ mail/                   # SMTP / MIME / IMAP / 模拟邮箱
│  └─ data/                   # 运行时数据（不提交，需备份）
├─ scripts/                   # init-db / seed-demo / reset-password / backup / verify-safety
├─ tests/                     # node:test（临时库 + 随机端口）
└─ docs/                      # 架构/研究/API/安全/合规/数据模型等
```

---

## 配置说明

复制 `.env.example` 为 `.env` 后按需修改（**不要提交 `.env`**）。所有变量都有默认值，不配置也能启动。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `NODE_ENV` | `development` | 设为 `production` 时打开生产语义 |
| `HOST` | `127.0.0.1` | 监听地址；生产建议保持 127.0.0.1 + 反向代理 |
| `PORT` | `4173` | 端口 |
| `APP_NAME` | `ZHIRAI Outreach` | 界面/邮件中显示的应用名 |
| `TRUST_PROXY` | `0` | 仅当前面是可信反向代理时设 `1`（用于读取 `X-Forwarded-*`） |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:4173` | 对外地址；**必须**设置为真实 HTTPS 地址，否则退订链接、邮件中的产品 PDF 公开链接与 Secure Cookie 都会不正确 |
| `DATA_DIR` | `server/data` | 数据目录（数据库/上传/日志/备份/密钥） |
| `LOG_LEVEL` | `info` | `debug/info/warn/error/silent` |
| `SESSION_TTL_HOURS` | `168` | 会话有效期（1–8760） |
| `WORKER_ENABLED` | `1` | 是否启动后台 Worker |
| `WORKER_POLL_MS` | `1000` | Worker 轮询间隔（100–60000） |
| `GLOBAL_SEND_PAUSED` | `0` | 设为 `1` 全局暂停所有发送（紧急刹车） |
| `AI_PROVIDER` / `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` | 空 | 可选兜底模型配置；**正常应通过界面保存（加密存储）** |

**敏感信息**：API Key / 邮箱密码请在「设置 → 密钥」中录入（服务端 AES-256-GCM 加密）；不要写进 `.env` 或提交到仓库。

---

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run init-db` | 初始化/升级数据库（建目录 + 应用迁移，可重复执行） |
| `npm start` | 启动服务（HTTP + Worker） |
| `npm run dev` | 开发模式（`node --watch`，改动自动重启） |
| `npm test` | 运行测试（`node:test`，覆盖单元/集成/安全与租户隔离） |
| `npm run backup` | 备份数据库（`VACUUM INTO` 到 `DATA_DIR/backups`） |
| `npm run seed` | 写入演示数据（可选，便于体验） |
| `npm run reset-password` | 本地重置管理员密码（忘记密码时在服务器执行） |
| `node scripts/verify-safety.mjs [baseUrl]` | 对**运行中的服务**做端到端安全验收（审批→发送、接管拦截、抑制拦截、公开退订） |

> 说明：本项目无 `dependencies`，因此**不需要** `npm install`；`npm` 只用于执行脚本。

---

## 数据与备份

| 路径 | 内容 | 是否入 Git |
| --- | --- | --- |
| `server/data/outreach.sqlite` | 全部业务数据（WAL 模式） | ❌ |
| `server/data/uploads/` | 产品图片 / PDF 资料（`uploads/products/<workspace>/<product>/`） | ❌ |
| `server/data/logs/app.log` | 应用日志 | ❌ |
| `server/data/backups/` | 备份文件（仅数据库，不含 uploads） | ❌ |
| `server/data/secret.key` | 加密主密钥（凭据解密依赖它） | ❌ |

**备份**：维护台「创建备份」或 `npm run backup`，生成 `backups/outreach-<时间戳>.sqlite`；恢复步骤见 [DEPLOY.md](DEPLOY.md)。
**重要**：数据库备份**不包含** `uploads/` 中的产品图片/PDF（邮件附件依赖这些文件）。备份时需同时复制整个 `server/data/uploads/` 目录。
**注意**：`secret.key` 丢失后已保存的模型/邮箱凭据无法解密（需重新录入）；请与备份分开安全保存。

---

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 完整系统架构研究方案（19 项交付、业务流程图、模块/Agent 职责、风险、商业化） |
| [docs/RESEARCH.md](docs/RESEARCH.md) | 开源项目研究报告（A/B/C/D 分类、许可证核验、借鉴点、外部依赖） |
| [docs/LICENSE-REGISTER.md](docs/LICENSE-REGISTER.md) | 第三方依赖与素材登记册（当前 0 依赖） |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | 40 张业务表（含迁移表 41）ER、唯一约束/索引、保留与迁移策略 |
| [docs/API.md](docs/API.md) + [docs/openapi.yaml](docs/openapi.yaml) | REST API 文档与 OpenAPI 描述（产品文件/关键词/附件） |
| [docs/SECURITY.md](docs/SECURITY.md) | 威胁模型、认证/CSRF/加密、发送与 Agent 安全、公开 PDF 链接与上传限制、生产清单、已知限制 |
| [docs/COMPLIANCE.md](docs/COMPLIANCE.md) | GDPR 与欧洲电子营销落地（**非法律意见**） |
| [docs/DECISIONS.md](docs/DECISIONS.md) | 14 条 ADR（选择/理由/替代/代价） |
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | 中文操作手册（初始化 → 产品/ICP → 发现 → 评分 → 审批 → 发送 → 收件箱 → 接管 → CRM → 设置 → 备份） |
| [docs/ROADMAP.md](docs/ROADMAP.md) | v1.0 → v1.x 阶段计划与不自动化承诺 |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | 验证报告（自动化测试、安全 E2E、真实浏览器验收；由发布负责人维护） |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | 内部开发契约（模块接口，供二次开发参考） |
| [DEPLOY.md](DEPLOY.md) | 自托管部署（Windows/Linux）、nginx/HTTPS、备份恢复、升级、排障 |
| [CHANGELOG.md](CHANGELOG.md) | 版本记录 |

---

## 许可证与商业授权

本项目为**专有软件**（Proprietary / UNLICENSED），版权归 **ZHIRAI（智睿科技）** 所有：

```text
© 2026 智睿科技 保留所有权利。
```

- 未经书面商业授权，**不得**复制、修改、分发、转售、出租、SaaS 化向第三方提供或创作衍生作品。
- 商业授权形式：① 自托管软件授权（份数/席位）；② 源码授权（含二次开发权）；③ 白标/OEM。均需签署合同。
- 本项目**不使用任何第三方运行时依赖**；参考的开源项目仅用于研究，未复制代码或素材（见 [docs/RESEARCH.md](docs/RESEARCH.md)、[docs/LICENSE-REGISTER.md](docs/LICENSE-REGISTER.md)）。
- 授权咨询：**xtang3125@gmail.com** ｜ https://zhirai.cloud

完整条款见根目录 [LICENSE](LICENSE)。

---

## 安全与合规

- 密钥只在服务端；集成凭据 **AES-256-GCM + HKDF** 加密；日志/审计自动脱敏。
- 会话 HttpOnly + CSRF 双提交 + Origin 校验；服务端 capability 权限矩阵；多工作空间行级隔离。
- 默认人工审批；接管/退订/抑制在发送管线强制拦截；公开退订链接（HMAC 签名）。
- 产品 PDF 的邮件公开链接为 **HMAC 签名、180 天有效、按租户校验**；上传限制 8 MB、MIME 白名单、路径遍历防护；**链接持有者无需登录即可打开 PDF，请勿上传敏感资料**。
- 详细威胁模型与已知限制见 [docs/SECURITY.md](docs/SECURITY.md)。
- **GDPR / 欧洲电子营销**：产品提供合法依据记录、来源记录、退订/抑制、保留策略、导出与审计，但**合法性由使用者（数据控制者）负责**；本文档不构成法律意见，商用前请专业复核，见 [docs/COMPLIANCE.md](docs/COMPLIANCE.md)。

---

## 免责声明

本软件按「现状」提供，不附带任何明示或暗示的担保。使用者应自行确保：数据来源合法、营销行为符合目标国家法律、邮箱与域名配置正确、备份有效。因使用本软件产生的业务、法律或数据后果由使用者承担。

---
<div align="center">

**ZHIRAI · 智睿科技 · 独立开发者**

把想法变成现实 ｜ [zhirai.cloud](https://zhirai.cloud) ｜ xtang3125@gmail.com

© 2026 智睿科技 保留所有权利。

</div>
