# 产品图片 / PDF 附件 / AI 关键词 — 实现契约（v1.1）

> **内部开发契约**：本文件供二次开发/维护参考，**不属于最终用户文档**，未收录进 README 用户文档索引；用户操作请以 [USER-GUIDE.md](./USER-GUIDE.md)、API 以 [API.md](./API.md) 为准。

> 目标：产品支持主图、PDF 资料（目录/规格书）；AI 发送时把 PDF 作为附件并把可公开访问的链接写进邮件；企业发现支持 AI 生成关键词、国家全选/随机。所有文件访问都要可撤销/不泄露其他租户数据。

## 0. 数据模型（Lead 已写入 `002_product_media_attachments.sql`）

- `products.keywords_json TEXT DEFAULT '[]'` — AI/人工关键词数组（字符串）。
- `products.main_image_file_id TEXT` — 主图，指向 `product_files.id`（仅图片）。
- `product_files.kind TEXT DEFAULT 'document'` — `image` | `document`。
- `message_drafts.attachments_json TEXT DEFAULT '[]'` — `[{productFileId, filename, mimeType, sizeBytes, publicUrl}]`。
- `email_messages.attachments_json TEXT DEFAULT '[]'` — 实际发送的附件快照。

`product_files` 既有列：`id, workspace_id, product_id, filename, mime_type, size_bytes, storage_path, uploaded_by, created_at`。文件真实路径：`<DATA_DIR>/uploads/products/<workspaceId>/<productId>/<fileId>.<ext>`（`storage_path` 存相对 uploadsDir 的路径）。

## 1. t-data：产品文件 API

新增 `server/services/product-files.mjs`（导出契约函数）、`server/routes/product-files.mjs`（**Lead 负责挂载**）、扩展 `services/products.mjs`、`routes/products.mjs`、`repositories/products.mjs`。

### 1.1 文件视图

```js
fileView = {
  id, filename, mimeType, sizeBytes, kind, isMain,
  url: `/api/v1/products/${productId}/files/${fileId}`,     // 登录态访问
  publicUrl: `/api/v1/public/product-files/${token}`,       // 仅 document；90-180 天签名
  createdAt
}
```

签名 token：`signToken(getSecret(), { t:'pfile', w:workspaceId, p:productId, f:fileId }, { expiresInDays: 180 })`。

### 1.2 路由（auth required，除 public）

- `GET /api/v1/products/:id/files` → `{ items: fileView[] }`（capability `data.read`）
- `POST /api/v1/products/:id/files` body `{ filename, mimeType, dataBase64, kind }`（capability `data.write`，route option `maxBodyBytes: 12_000_000`）
  - 允许：图片 `image/png|image/jpeg|image/webp`，文档 `application/pdf`
  - 单文件 ≤ 8 MB；base64 解码失败 → 422；文件名清洗（去路径、限 160 字符）
  - 第一张图片自动设为主图
  - 返回 `{ file: fileView }`
- `DELETE /api/v1/products/:id/files/:fileId`（`data.write`）→ `{ deleted:true }`；删除主图时清空 product.main_image_file_id
- `POST /api/v1/products/:id/files/:fileId/main`（`data.write`）→ 设为主图（仅 kind=image）
- `GET /api/v1/products/:id/files/:fileId`（**登录态**，`data.read`）→ 流式返回文件，`Content-Disposition: inline`，`X-Content-Type-Options: nosniff`
- `GET /api/v1/public/product-files/:token`（**public，no CSRF**）→ 验证 token 后流式返回文件；token 无效/过期 404；只允许 inline 显示 PDF/图片

### 1.3 产品响应扩展

`GET /products`、`GET /products/:id`、`POST/PATCH /products` 的 product 对象新增：

```js
keywords: string[],
files: fileView[],
mainImageUrl: string | null,
```

`PATCH /products/:id` 接受 `keywords: string[]`（每项 ≤ 80 字符，最多 30 个，去重）。

### 1.4 AI 关键词

`POST /api/v1/products/:id/generate-keywords`（`data.write`，body 可空）
- 动态 import `../agents/index.mjs` 调用 `generateProductKeywords({ workspaceId, product })`
- 把返回的 `keywords` 去重/限量后保存到 `products.keywords_json`
- 返回 `{ keywords, negativeKeywords, notes, provider }`；Agent 不可用时返回 503 `AGENT_UNAVAILABLE`，不得伪造关键词

契约函数（供其它模块）：
```js
listProductFiles(workspaceId, productId) -> fileView[]           // 含 publicUrl
listProductFilesForEmail(workspaceId, productId) -> [{productFileId, filename, mimeType, sizeBytes, publicUrl}]
```

## 2. t-agents：`keyword_research` 角色

新增第 11 个角色：
- 提示词 `server/agents/prompts/keyword_research.md`（沿用现有 front matter：role/version/output: json）
- schema（`schemas.mjs`）：
  ```js
  keyword_research: object({
    keywords: list(text(80), 30),
    negativeKeywords: list(text(80), 15),
    searchQueries: list(text(200), 10),
    notes: text(1000)
  })
  ```
- catalog/roles/simulation 注册；simulation 必须基于产品名称/分类/规格/应用场景/材料扩展英文 B2B 关键词（如 supplier/manufacturer/importer/distributor/OEM/aftermarket + 产品词），不得编造认证或客户名；`notes` 标注“模拟 Provider 仅基于已填字段扩展”。
- 便捷函数：`generateProductKeywords({ workspaceId, product, actorType, actorId })` → 返回 output（并写 agent_executions/usage，与其它便捷函数一致）。

## 3. t-crm：草稿带附件

`generateDraft({workspaceId, draftId, ...})` 扩展：
1. 若草稿关联产品，动态 import t-data `../services/product-files.mjs > listProductFilesForEmail(workspaceId, productId)`；
2. 取最多 3 个 PDF（`mimeType === 'application/pdf'`）作为 attachments；
3. 把 `productFiles: [{filename, publicUrl}]` 放入 outreach writer 的 context（用于正文链接）；
4. 生成成功后把 attachments 写入 `message_drafts.attachments_json`（无 PDF 时 `[]`）；
5. draft 详情返回 `attachments: []`（从 `attachments_json` 解析）。
测试：有/无产品文件两种路径；失败时不写脏附件。

## 4. t-worker：MIME 附件与发送

- `buildMimeMessage({ ..., attachments: [{ filename, mimeType, content }] })` 扩展为 `multipart/mixed`（内层仍是 `multipart/alternative`）；附件 base64 按 76 字符换行；总附件 ≤ 8 MB、单文件 ≤ 5 MB，超限拒绝或跳过并记录。
- `sendDraft`：读 draft.attachments_json → 从 uploads 读取文件 → 传 attachments；若正文中没有该 PDF 的 publicUrl，则在正文末尾（合规退订段之前）追加一行 `Product catalogue (PDF): <publicUrl>`；发送成功把 attachments 快照写入 `email_messages.attachments_json`；模拟邮箱同样生成带附件的 MIME。
- 失败：附件文件丢失 → 记录 warning 并继续无附件发送（不要整封失败）；附件超限 → 记录 warning 跳过。
- 测试：MIME 附件结构/编码/大小限制；send-pipeline 附件写入；正文链接去重。

## 5. t-front-data：产品与发现页面

### products.js
- 新建/编辑弹窗增加：
  - 主图上传（file input，PNG/JPEG/WebP ≤8MB）→ base64 POST `/products/:id/files`，显示缩略图，可设主图/删除；
  - PDF 上传（application/pdf ≤8MB）→ 文件列表（文件名、大小、复制公开链接、删除）；
  - 关键词编辑（逗号/换行）与「AI 生成关键词」按钮（POST generate-keywords），生成后填入输入框，保存时随 PATCH 提交；
- 产品卡片显示主图缩略图（无图用占位图标）、关键词数量、PDF 数量。
- 文件接口未就绪时显示错误提示，不影响其余编辑。

### discovery.js
- 产品选择后：若关键词为空，自动加载该产品 `keywords` 填入；「AI 生成关键词」按钮（调用产品接口）生成并填入关键词；
- 国家：增加「全选欧洲」「随机 8 国」「清空」按钮；允许 0 个国家（= 全部市场，提交 `countries: []` 并在界面标注）；仍保持多选 chips；
- 提交成功/失败反馈不变；所有说明入 helpTip。

## 6. Lead

- 写 migration、挂载 `server/routes/product-files.mjs`、修复顶栏头像溢出、集成测试、同步 E:、更新文档/截图/zip。
- 任何契约变更先发消息。

## 7. 验收命令

- 后端：`node --test --test-force-exit "tests/**/*.test.mjs"` 全绿。
- 手工（Lead）：上传图片/PDF → 产品接口返回 files/mainImageUrl → 生成关键词 → 发现页自动带出 → 生成草稿包含 PDF 公开链接+附件 → 审批发送 → 模拟邮箱/收件箱验证附件快照。
