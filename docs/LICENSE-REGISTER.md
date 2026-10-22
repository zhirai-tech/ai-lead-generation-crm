# 第三方依赖与素材许可证登记册（License Register）

> 项目：ZHIRAI Europe B2B AI Outreach Platform v1.0.0
> 版权：`© 2026 智睿科技 保留所有权利。`
> 维护者：ZHIRAI · 智睿科技 · 独立开发者 ｜ 联系方式：xtang3125@gmail.com
> 更新日期：2026-10-22（最终复核：`package.json` 无 `dependencies`/`devDependencies`；`assets/brand/**` 全部来自 ZHIRAI 自有源文件 `E:\images\logo\profile`）。

---

## 1. 结论速览

| 类别 | 数量 | 说明 |
| --- | --- | --- |
| 运行时 npm 依赖 | **0** | `package.json` 无 `dependencies` / `devDependencies` |
| 开发期 npm 依赖 | **0** | 无构建链、无测试框架依赖（使用 `node:test`） |
| 第三方代码（vendored / 复制源码） | **0** | 未复制任何参考项目代码 |
| 第三方字体文件 | **0**（随发行物分发） | 仓库内无 `*.woff2/*.ttf/*.otf` 文件，CSS 无外部字体 `@import`/`url(http…)`（2026-10-22 已核实） |
| 第三方图标库 | **0** | 图标为项目内自绘内联 SVG（`src/app/icons.mjs`，无图标库）（2026-10-22 已核实） |
| 第三方图片/插画 | **0** | 使用 ZHIRAI 自有品牌素材（源文件 `E:\images\logo\profile`，已复制至 `assets/brand/`） |
| 第三方脚本/构建工具 | **0** | `scripts/*.mjs` 全部为项目自写；无打包器/代码生成器 |
| 参考项目（仅研究） | 8 | 见 §5，不进入构建产物 |

> 本登记册的目的：证明本项目可以**闭源商业分发**，并在未来引入第三方时保留可审计记录。**任何新增第三方组件必须先登记，再合并代码。**

---

## 2. 本项目许可

| 项 | 内容 |
| --- | --- |
| 产品名 | ZHIRAI Europe B2B AI Outreach Platform（智睿欧洲 B2B AI 外贸获客平台） |
| 版权 | `© 2026 智睿科技 保留所有权利。` |
| 作者 | ZHIRAI · 智睿科技 · 独立开发者 |
| 许可类型 | **专有（Proprietary）/ UNLICENSED** |
| 许可文件 | 根目录 [`LICENSE`](../LICENSE) |
| 允许 | 经书面商业授权后的自托管使用；经书面授权的源码交付与二次开发；白标/OEM（另议） |
| 禁止（未获授权时） | 复制、修改、合并、发布、分发、再许可、出售、转售、出租、SaaS 化向第三方提供、创作衍生作品 |
| 商业授权联系 | xtang3125@gmail.com ｜ https://zhirai.cloud |

---

## 3. 运行时依赖：Node.js 内置模块

本项目**不随发行物分发 Node.js**，而是要求部署环境已安装 Node.js ≥ 22.5。以下为实际使用的内置模块（均为 Node.js 标准库，随 Node 运行时提供）：

| 模块 | 用途 | 归属 |
| --- | --- | --- |
| `node:http` | HTTP 服务器 | Node.js 标准库 |
| `node:fs` | 文件读写（数据目录、静态文件、备份、日志） | Node.js 标准库 |
| `node:path` | 路径处理 | Node.js 标准库 |
| `node:url` | URL 解析（`fileURLToPath`、`URL`） | Node.js 标准库 |
| `node:crypto` | 随机数、scrypt、AES-256-GCM、HKDF、HMAC、SHA-256 | Node.js 标准库 |
| `node:sqlite` | SQLite 数据库（`DatabaseSync`） | Node.js 标准库（实验特性） |
| `node:net` / `node:tls` | SMTP/IMAP 连接（自写邮件客户端） | Node.js 标准库 |
| `node:os` | 临时目录等 | Node.js 标准库 |
| `node:test` / `node:assert` | 测试（开发期，不随发行物） | Node.js 标准库 |
| `node:events` / `node:stream` / `node:buffer` | 事件、流、缓冲区（按需） | Node.js 标准库 |

**法律说明**：Node.js 本身以 MIT 许可发布，但本项目**不分发 Node.js 二进制**，因此不产生 Node.js 的再分发义务。客户的 Node.js 安装由其自行获取并遵守 Node.js 许可。

**SQLite**：`node:sqlite` 的底层 SQLite 属于公有领域（Public Domain），随 Node.js 分发，本项目不单独分发。

---

## 4. 前端与素材

| 资产 | 路径 | 来源 | 许可/权利 | 备注 |
| --- | --- | --- | --- | --- |
| 品牌 Logo | `assets/brand/logo.png` | ZHIRAI 自有品牌素材（源文件 `E:\images\logo\profile`） | © 2026 智睿科技 | 不授权第三方使用 |
| Favicon | `assets/brand/favicon.ico` | ZHIRAI 自有（源文件 `E:\images\logo\profile`） | © 2026 智睿科技 | |
| 应用图标 | `assets/brand/app-icons/32x32.png`、`64x64.png`、`128x128.png`、`icon-512.png` | ZHIRAI 自有（源文件 `E:\images\logo\profile`） | © 2026 智睿科技 | 用于 PWA/manifest |
| 字体 | 无随包字体文件 | 系统字体栈（`-apple-system`、`Segoe UI`、`Noto Sans CJK` 等） | 由用户操作系统提供 | ✅ 已核实（仓库无字体文件、CSS 无外链） |
| 图标 | 内联 SVG（`src/app/icons.mjs` 自绘） | 本项目 | © 2026 智睿科技 | ✅ 已核实（未使用图标库） |
| CSS/JS | `src/**` | 本项目 | © 2026 智睿科技 | 无框架、无 CDN 引用 |

> 原则：**不引用外部 CDN**（CSP `default-src 'self'` 已禁止），因此不存在运行时加载第三方脚本/字体/样式的许可问题，也不存在供应链风险。

---

## 5. 参考项目清单（仅研究，不进入构建产物）

> 以下项目**未被复制、未被链接、未被 vendored、未作为依赖安装**。它们只用于阅读公开 LICENSE/README/公开文档以理解功能与架构。
> 核验方式与证据见 [RESEARCH.md](./RESEARCH.md) §1、§4。核验日期 2026-10-22。

| # | 项目 | 地址 | 许可证（已核实） | 与本项目的关系 | 是否包含其代码/素材 |
| --- | --- | --- | --- | --- | --- |
| 1 | AgentSDR | https://github.com/Kandid-ai/AgentSDR | MIT | 研究 Agent 分工、审批、多组织 | 否 |
| 2 | OpenOutreach | https://github.com/eracle/OpenOutreach | GPL-3.0 | 研究"产品→ICP→评分→写信"流程与可解释理由 | 否 |
| 3 | Quick-Enrich-Tools | https://github.com/mattvinall/Quick-Enrich-Tools | MIT | 研究阶段化数据流水线 | 否 |
| 4 | OpenEnrich | https://github.com/openenrich/openenrich | AGPL-3.0 | 研究分级瀑布、成本控制、MCP 形态 | 否 |
| 5 | NakatomiCRM | https://github.com/mrdulasolutions/NakatomiCRM | MIT | 研究 Agent 友好 CRM 接口与审计 | 否 |
| 6 | Twenty CRM | https://github.com/twentyhq/twenty | AGPL-3.0（主体）+ 商业许可文件 + 部分 MIT 包 | 研究 CRM 数据模型与可扩展对象代价 | 否 |
| 7 | Mautic | https://github.com/mautic/mautic | GPL-3.0-or-later（含商标声明与第三方组件清单） | 研究分群/活动/触发 | 否 |
| 8 | n8n | https://github.com/n8n-io/n8n | Sustainable Use License v1.0 | 参考任务状态机通用模式 | 否 |

**独立性声明**：本项目的代码、数据模型、提示词、界面文案、文档均为独立创作；未使用上述项目的名称、logo、界面素材或原创文案。参考项目名称仅用于说明研究来源（合理使用/事实陈述）。

---

## 6. 未来引入第三方组件的登记模板

> 复制下表填写，提交给项目负责人审批后才能合并。**不允许"先用后补"**。

### 6.1 单条登记模板

```markdown
### 组件：<包名> @ <版本>

- 来源/主页：
- 引入方式：npm 依赖 / vendored 源码 / 复制片段 / 二进制 / 数据文件
- 实际许可证（读取仓库 LICENSE 原文）：
- 许可证 SPDX：
- 版权声明要求（是否需要随发行物附带 NOTICE/版权行）：
- 依赖树中的 copyleft 组件（GPL/AGPL/SSPL/Commons Clause 等）：
- 商标/品牌限制：
- 素材/字体/数据授权：
- 商业分发影响（能否闭源分发 / 能否 SaaS / 能否卖源码）：
- 替代方案：
- 审批人 / 日期：
- 触发同步更新的文件：package.json / THIRD-PARTY-NOTICES.md / 本登记册
```

### 6.2 登记汇总表（当前为空）

| 组件 | 版本 | 来源 | 许可证 | 引入方式 | 商用影响 | 审批 |
| --- | --- | --- | --- | --- | --- | --- |
| —（无） | — | — | — | — | — | — |

### 6.3 审批规则

1. **禁止引入**：GPL-2.0/3.0、AGPL-3.0、SSPL、Commons Clause、Fair-Code、Source-Available、Sustainable Use License、任何"仅非商业"许可。
2. **优先引入**：MIT、BSD-2/3-Clause、Apache-2.0、ISC、0BSD、CC0（素材）。
3. **Apache-2.0 注意**：需附带 `NOTICE`（若有）与许可证文本；专利授权条款需知悉。
4. **MIT/BSD 注意**：必须在发行物中保留版权声明与许可文本（可放 `THIRD-PARTY-NOTICES.md`）。
5. **前端依赖**：即使只在前端，也视为分发（源码交付会包含），同样要登记。
6. **数据集/模型权重**：另需确认数据来源合法性、是否允许商用、是否允许再分发。
7. **每次引入后**：更新本文件 §1 汇总、§6.2 表格，并在 [CHANGELOG.md](../CHANGELOG.md) 记录。

---

## 7. 商业分发注意事项

### 7.1 发行物必须包含

- [x] `LICENSE`（专有许可全文）
- [x] `docs/LICENSE-REGISTER.md`（本文件）
- [x] `docs/RESEARCH.md`（说明参考项目与独立性）
- [ ] `THIRD-PARTY-NOTICES.md`（当前无第三方，可暂不创建；引入后必须创建）
- [x] `README.md`（品牌、能力、许可与商业授权说明）

### 7.2 不得包含

- `server/data/**`（数据库、上传、日志、备份、`secret.key`）
- `.env` / `.env.local`
- 客户数据、真实密钥、内部测试数据
- 未获授权的参考项目代码或素材

### 7.3 分发形态与义务

| 形态 | 义务 |
| --- | --- |
| 自托管部署（软件授权） | 保留版权与许可；不得移除或修改版权声明；不得转售 |
| 源码交付（源码授权） | 同上 + 合同约定的保密/竞业/二次分发限制；交付物含文档与登记册 |
| 白标/OEM | 合同约定品牌替换范围；**不得**替换 `LICENSE` 中的版权归属（可加"Powered by ZHIRAI"要求） |
| SaaS 化对外服务 | **默认禁止**；需单独商业授权（否则等同于转售） |

### 7.4 商标

- "ZHIRAI"、"智睿科技"、Logo、`zhirai.cloud` 为项目所有者品牌资产；被授权方不得注册为商标或用作公司名。
- 本项目不在任何文件中使用参考项目的商标作为自身标识。

### 7.5 出口与制裁（提示，非法律意见）

- 产品使用加密（AES-256-GCM、TLS），属于常见商用加密；多数司法辖区允许，但个别国家有申报要求。**发布到特定市场前请咨询专业人士**（⚠️ 非法律意见）。

---

## 8. 复核清单（每次发版前）

- [ ] `package.json` 仍无 `dependencies`（或新增项已登记）
- [ ] `npm ls --all`（如有依赖）无 copyleft
- [ ] 前端无 CDN 引用、无外部字体/脚本
- [ ] `assets/**` 无未登记素材
- [ ] 发行 zip 不含 `server/data/**`、`.env`、`secret.key`
- [ ] `LICENSE`、`docs/LICENSE-REGISTER.md`、`docs/RESEARCH.md` 在包内
- [ ] `CHANGELOG.md` 记录了本次新增依赖/素材（如有）

---
<div align="center">

**ZHIRAI · 智睿科技 · 独立开发者**
把想法变成现实 ｜ https://zhirai.cloud
© 2026 智睿科技 保留所有权利。

</div>
