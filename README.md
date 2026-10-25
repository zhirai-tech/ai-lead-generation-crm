# ZHIRAI Europe B2B AI Outreach Platform

**智睿欧洲 B2B AI 外贸获客平台**

一个自托管的欧洲 B2B 获客工作台：产品资料 → 客户画像（ICP）→ 企业发现 → 可解释评分 → 个性化开发信 → 人工审批 → 邮件跟进 → 回复分类 → 销售管道。

> 默认不自动群发。桌面测试包默认全局发送暂停；真实发信前必须完成邮箱、合规、审批和抑制名单配置。

## 项目状态

`BETA`：Windows 完整版、Windows 基础版、macOS Apple Silicon 桌面包已完成本地启动验收；客户筛选准确率尚未建立真实人工标注基准。

## 核心功能

- 企业、联系人、来源和校验记录管理；联系人角色和邮箱可信度分级。
- 产品资料、图片/PDF、规格、认证、产能、MOQ、交期和关键词。
- ICP 客户画像：国家/地区、企业类型、规模、角色、关键词、排除词和最低分。
- 发现批次、网页/CSV 数据源、邮箱推断和 MX 校验。
- 规则评分 `rules-v1`：产品匹配、企业类型、地区、采购场景、信息可信度、联系方式可信度、近期信号，附因素和排除原因。
- 开发信模板、AI 草稿、质量/合规提示、人工审批、发送管线。
- 收件箱、回复分类、建议回复、人工接管和销售管道。
- 本地 SQLite（WAL）、备份、审计、任务队列和用量记录。

## 下载桌面版

GitHub Releases：

https://github.com/zhirai-tech/zhirai-europe-b2b-outreach/releases

- Windows 完整版：免安装 Node.js，解压后双击 `LAUNCH-ZHIRAI.bat`。
- Windows 基础版：需要 Node.js 22.5+，解压后双击 `START-WINDOWS-BASIC.bat`。
- macOS：仅 Apple Silicon，解压后打开 `ZHIRAI-Base.app`。

当前桌面版本：`1.1.0-1025`（2026-10-25）。

详细操作手册：

- [PDF](docs/manual/ZHIRAI-1.1.0-1025-桌面版操作手册.pdf)
- [Word](docs/manual/ZHIRAI-1.1.0-1025-桌面版操作手册.docx)

## 技术栈与要求

- Node.js **>=22.5**（使用内置 `node:sqlite`）。
- 原生 ES Modules 前端，无前端构建步骤。
- SQLite（WAL），数据默认在数据目录；不默认写入安装目录。
- 桌面壳 Electron 45（仅桌面打包使用）。
- 可选 Playwright 用于网页发现；外部站点访问受网络和配置影响。
- Windows 完整版不需要 Node.js；Windows 基础版需要 Node.js。

## 从源码启动

```bash
npm install
cp .env.example .env
npm run init-db
npm start
```

默认本地地址：`http://127.0.0.1:4173`。

迁移门禁要求显式配置 `MIGRATION_EXPECTED_DB_PATH` 和 `MIGRATION_ALLOWLIST`；不要使用空配置启动已有数据库。

## 测试

```bash
npm test
```

最近一次实际结果：**428 项，427 通过，1 跳过，0 失败**。

桌面版单独完成过：
- Windows 完整版启动、health、版本检查；
- Windows 基础版启动器、health 检查；
- macOS arm64 实机启动、窗口、health、强制退出无残留服务。

准确率测试尚未执行：目前没有真实人工标注样本。不得把本次功能验收描述为 60%/70% 准确率达标。

## 已知限制

- 真实企业发现、官网抓取、外部 API 和真实 SMTP/IMAP 发信未完成本版本全量验收。
- 客户筛选/线索资格准确率没有真实标注集，当前不能给出可靠百分比。
- macOS 包未做 Apple 公证/签名，Gatekeeper 可能提示；仅 arm64。
- Windows 基础版要求 Node.js 22.5+。
- 项目当前没有支付、订阅或商业计费模块。

## 安全与隐私

- 不提交 `.env`、数据库、密钥、日志、客户数据或上传文件。
- 桌面测试包默认 `GLOBAL_SEND_PAUSED=1`。
- 真实发信前必须配置 SPF/DKIM/DMARC、退订、抑制名单和人工审批。
- 详见 [安全说明](docs/SECURITY.md)。

## 项目文档

- [项目状态](PROJECT_STATUS.md)
- [功能状态](FEATURE_STATUS.md)
- [需求范围](REQUIREMENTS.md)
- [贡献规范](CONTRIBUTING.md)
- [项目规则](PROJECT_RULES.md)
- [变更记录](CHANGELOG.md)

## 规划

尚未实施，不包含在当前版本：真实人工标注准确率评测、更多外部数据源、安装器/签名/自动更新。以上仅为规划，不是当前功能。

## 许可证

见 [LICENSE](LICENSE)。未经授权不得复制、分发或商业使用。

## 联系

ZHIRAI · 智睿科技 · 独立开发者  
https://zhirai.cloud  
xtang3125@gmail.com
