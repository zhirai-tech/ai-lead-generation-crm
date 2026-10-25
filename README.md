# ZHIRAI Europe B2B AI Outreach Platform / 智睿欧洲 B2B AI 外贸获客平台

**English** | [简体中文](#中文)

> A self-hosted European B2B outreach workspace: product data → ICP → company discovery → explainable scoring → personalized drafts → human approval → email follow-up → reply classification → pipeline.
>
> 自托管的欧洲 B2B 获客工作台：产品资料 → 客户画像（ICP）→ 企业发现 → 可解释评分 → 个性化开发信 → 人工审批 → 邮件跟进 → 回复分类 → 销售管道。

No automatic bulk sending by default. Desktop test builds ship with global sending paused.  
默认不自动群发；桌面测试包默认全局发送暂停。

**Latest version / 最新版本:** `1.1.0-1025` (2026-10-25)  
**Status / 状态:** `BETA`  
**License / 许可证:** MIT

---

## English

### Screenshot

![ZHIRAI desktop first-run](docs/screenshots/desktop-first-run.png)

### Download

[GitHub Releases](https://github.com/zhirai-tech/zhirai-europe-b2b-outreach/releases)

- Windows Full: no Node.js required; extract and run `LAUNCH-ZHIRAI.bat`.
- Windows Basic: requires Node.js 22.5+; extract and run `START-WINDOWS-BASIC.bat`.
- macOS: Apple Silicon (arm64) only; extract and open `ZHIRAI-Base.app`.

### Current capabilities

- Companies, contacts, sources and verification records; contact roles and email-confidence levels.
- Product data, images/PDF, specifications, certifications, capacity, MOQ, lead time and keywords.
- ICP: countries/regions, company types, sizes, roles, keywords, exclusions and minimum score.
- Discovery runs, web/CSV sources, email inference and MX validation.
- Rule-based `rules-v1` scoring: product match, company type, region, buying scenario, confidence, contact quality and recency, with factors and exclusion reasons.
- Outreach templates, AI drafts, quality/compliance notes, human approval and send pipeline.
- Inbox, reply classification, suggested replies, human takeover and sales pipeline.
- Local SQLite (WAL), backups, audit log, job queue and usage records.

### Stack

- Node.js >= 22.5 with built-in `node:sqlite`.
- Native ES Modules frontend; no frontend build step.
- SQLite WAL; Electron 45 desktop shell for packaged builds.
- Playwright for optional web discovery.
- Windows Full does not require Node.js; Windows Basic does.

### Run from source

```bash
npm install
cp .env.example .env
npm run init-db
npm start
```

Default URL: `http://127.0.0.1:4173`. The migration gate requires explicit `MIGRATION_EXPECTED_DB_PATH` and `MIGRATION_ALLOWLIST`.

### Tests and limitations

```bash
npm test
```

Latest actual result: 428 tests, 427 passed, 1 skipped, 0 failed.

Not yet fully validated: real-world company discovery, external search, website crawling and real SMTP/IMAP delivery. Customer-qualification accuracy has no real human-labelled benchmark, so no 60%/70% claim is made. The macOS build is unsigned/unnotarized and arm64-only.

### Security

- Do not commit `.env`, databases, keys, logs or customer data.
- Desktop test builds default to `GLOBAL_SEND_PAUSED=1`.
- Configure SPF/DKIM/DMARC, unsubscribe, suppression and human approval before real sending.

### Documentation

- [Project status](PROJECT_STATUS.md)
- [Feature status](FEATURE_STATUS.md)
- [Requirements](REQUIREMENTS.md)
- [Contributing](CONTRIBUTING.md)
- [Project rules](PROJECT_RULES.md)
- [Desktop manual (PDF, English filename / Chinese content)](docs/manual/ZHIRAI-1.1.0-1025-Desktop-Manual.pdf)
- [Desktop manual (Word, English filename / Chinese content)](docs/manual/ZHIRAI-1.1.0-1025-Desktop-Manual.docx)

### Roadmap

Not implemented yet: real human-labelled accuracy evaluation, more external sources, installer/signing/auto-update. These are plans, not current features.

### License

Project code is licensed under the [MIT License](LICENSE). Redistributions must retain the copyright and permission notice; see [NOTICE](NOTICE). Third-party dependencies, assets and trademarks remain under their respective rights.

---

## 中文

### 截图

![ZHIRAI 桌面版首次启动](docs/screenshots/desktop-first-run.png)

### 下载

[GitHub Releases](https://github.com/zhirai-tech/zhirai-europe-b2b-outreach/releases)

- Windows 完整版：免安装 Node.js，解压后双击 `LAUNCH-ZHIRAI.bat`。
- Windows 基础版：需要 Node.js 22.5+，解压后双击 `START-WINDOWS-BASIC.bat`。
- macOS：仅 Apple Silicon（arm64），解压后打开 `ZHIRAI-Base.app`。

### 当前能力

- 企业、联系人、来源、校验记录；联系人角色与邮箱可信度分级。
- 产品资料、图片/PDF、规格、认证、产能、MOQ、交期和关键词。
- ICP：国家/地区、企业类型、规模、角色、关键词、排除词、最低分。
- 发现批次、网页/CSV 数据源、邮箱推断、MX 校验。
- 规则评分 `rules-v1`：产品匹配、企业类型、地区、采购场景、可信度、联系方式、近期信号，附因素和排除原因。
- 开发信模板、AI 草稿、质量/合规提示、人工审批、发送管线。
- 收件箱、回复分类、建议回复、人工接管、销售管道。
- 本地 SQLite（WAL）、备份、审计、任务队列和用量记录。

### 技术栈

- Node.js >= 22.5，内置 `node:sqlite`。
- 原生 ES Modules 前端，无前端构建步骤。
- SQLite WAL；Electron 45 桌面壳（仅桌面包）。
- Playwright 用于可选的网页发现。
- Windows 完整版无需 Node.js；基础版需要 Node.js。

### 源码启动

```bash
npm install
cp .env.example .env
npm run init-db
npm start
```

默认地址：`http://127.0.0.1:4173`。迁移门禁要求显式配置 `MIGRATION_EXPECTED_DB_PATH` 和 `MIGRATION_ALLOWLIST`。

### 测试与限制

```bash
npm test
```

最近实际结果：428 项，427 通过，1 跳过，0 失败。

尚未完成：真实企业发现、外部搜索、官网抓取、真实 SMTP/IMAP 发信的全量验收；客户筛选准确率缺少真实人工标注基准，不能报告 60%/70% 达标。macOS 包未签名/公证，仅 arm64。

### 安全

- 不提交 `.env`、数据库、密钥、日志或客户数据。
- 桌面测试包默认 `GLOBAL_SEND_PAUSED=1`。
- 真实发信前配置 SPF/DKIM/DMARC、退订、抑制名单和人工审批。

### 文档

- [项目状态](PROJECT_STATUS.md)
- [功能状态](FEATURE_STATUS.md)
- [需求范围](REQUIREMENTS.md)
- [贡献规范](CONTRIBUTING.md)
- [项目规则](PROJECT_RULES.md)
- [操作手册 PDF](docs/manual/ZHIRAI-1.1.0-1025-Desktop-Manual.pdf)
- [操作手册 Word](docs/manual/ZHIRAI-1.1.0-1025-Desktop-Manual.docx)

### 规划

尚未实施：真实人工标注准确率评测、更多外部数据源、安装器/签名/自动更新。以上为规划，不是当前功能。

### 许可

项目代码采用 [MIT License](LICENSE)。再分发必须保留版权和许可声明；见 [NOTICE](NOTICE)。第三方依赖、素材和商标归各自权利人。

---

