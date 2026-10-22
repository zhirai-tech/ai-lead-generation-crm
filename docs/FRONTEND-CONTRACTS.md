# 前端开发契约（FRONTEND CONTRACTS）

> 与 `docs/CONTRACTS.md` 配套。前端外壳、设计系统、路由、API 客户端、通用组件由 Lead 维护，页面由 t-front-data / t-front-outreach / t-front-system 并行实现。

## 0. 工作目录与环境

- **唯一开发目录：`C:\zhirai-stage\platform`**。不要写 `E:\…`（exFAT 会让 write 工具报 EISDIR），最终由 Lead 同步。
- 4173 端口的服务由 Lead 持有，**不要启动/重启服务，也不要使用浏览器 MCP**（Lead 统一做实机验收）。页面完成后由 Lead 在真实浏览器中检查，你只需保证代码结构/语法正确。
- 纯原生 ESM + 原生 DOM，**零第三方依赖**。禁止引入任何 UI/图表/请求库。
- 只修改自己拥有的页面文件与自己的 `src/styles/pages-*.css`；不要修改：
  - `src/app/**`（main/router/shell/api/state/icons/auth）
  - `src/components/**`（ui/charts）
  - `src/styles/{tokens,base,layout,components,pages}.css`
  - `src/utils/**`、`index.html`、`server/**`、`docs/FRONTEND-CONTRACTS.md`
  - 其他 owner 的页面文件
- 页面文案中文；代码注释英文。所有解释性说明必须放进 `helpTip()` 或页面标题旁 `?`，**不要**在页面上铺大段说明文字。
- 完成前用 `node --check src/pages/<file>.js` 做语法检查；不要伪造浏览器验证结果。

## 1. 页面模块结构

```js
import { append, clear, el } from '../utils/dom.mjs';
import { api } from '../app/api.mjs';
import { navigate } from '../app/router.mjs';
import { pageHeader, card, button, dataTable, pagination, toast, helpTip, emptyState } from '../components/ui.mjs';

export const meta = { title: '潜在客户', help: '这里是页面级说明，会显示在标题旁的问号图标里。' };

export async function render(root, params, ctx) {
  clear(root);
  // ctx.query: URLSearchParams  ctx.params: 路径参数  ctx.mode: '/approvals' 时为 'approvals'
  // ctx.navigate(path)  ctx.refresh()
}

export function destroy() {
  // 清理定时器 / 全局事件监听（如果有）
}
```

- 页面必须自行处理 loading / empty / error 三态；请求失败用 `toast(error.message, 'error')` + 页内错误提示，不要让整个工作台崩溃。
- 列表页统一：`pageHeader` → `toolbar`（搜索/筛选/刷新/主按钮）→ `dataTable` → `pagination`。
- 表单弹窗：`openModal` / `openDrawer`；删除/接管/退订等破坏性操作必须 `confirmDialog`。
- 写操作成功 `toast('已保存', 'success')` 并刷新数据；失败展示后端错误信息。
- 没有权限的能力（`state.can(capability)`）隐藏或禁用按钮（不是唯一防线，服务端仍会校验）。
- 数字右对齐、时间使用 `formatDate/relativeTime`、金额 `formatMoney`、状态用 `statusBadge`。
- 表格行点击进入详情；按钮点击不要触发整行跳转（UI kit 已处理）。
- 页面 CSS 只能写进自己的 `src/styles/pages-*.css`，选择器以 `.page-` 前缀开头；优先复用 tokens 与已有组件类。

## 2. 可用工具（Lead 已实现）

### 2.1 `../utils/dom.mjs`
`el(tag, class, ...children)`、`append(parent, children)`、`clear(node)`、`text()`、`on()`、`debounce()`、`cssVar()`。

### 2.2 `../utils/format.mjs`
`formatDate`、`formatDateTime`、`relativeTime`、`formatNumber`、`formatCompact`、`formatMoney(value,'EUR')`、`formatPercent`、`truncate`、`initials`、`countryName(code)`、`domainOf`。

### 2.3 `../app/api.mjs`
```js
import { api, queryString, downloadText } from '../app/api.mjs';
await api.get('/api/v1/companies' + queryString({ page, q, country }));
await api.post('/api/v1/companies', {...});
await api.patch(`/api/v1/companies/${id}`, {...});
await api.delete(`/api/v1/...`);
await api.put(...);
```
- 自动带 CSRF、自动解析 `{ok,data}` 信封；失败抛 `ApiError`（message/code/status），页面捕获并 toast。
- `queryString({page:1,q:'',empty:undefined})` 自动忽略空值。

### 2.4 `../app/state.mjs`
`state.session`、`currentUser()`、`currentWorkspace()`、`membership()`、`can(capability)`、`roleLabel()`、`events`。

### 2.5 `../app/router.mjs`
`navigate('/companies/xxx')`；路径 `#/...`。页面间跳转统一用 navigate。

### 2.6 `../components/ui.mjs`
按钮/徽标/卡片/表格/分页/弹窗/抽屉/确认框/提示/表单/标签页/时间线/评分条等：

```js
pageHeader({ title, help, subtitle, actions })
card({ title, help, actions, body, foot, className, flush })
statCard({ label, value, hint, iconName, help, delta })
toolbar(...children)
searchInput({ placeholder, value, onInput })
input({ value, placeholder, type, onInput, onEnter })
textarea({ value, placeholder, rows, onInput })
select({ value, options, onChange, placeholder })
checkbox({ checked, label, onChange })
field(label, control, { help, required, hint, error })
dataTable({ columns, rows, loading, empty, onRowClick, rowKey })
pagination({ page, pageSize, total, onChange })
tabs({ items:[{key,label,count}], active, onChange })
segmented({ items:[{value,label}], value, onChange })
openModal({ title, body, actions, size }) // actions: [{label, variant, onClick(close)}]
openDrawer({ title, body, actions })
confirmDialog({ title, message, confirmText, danger }) // Promise<boolean>
toast(message, 'success'|'error'|'info'|'warning')
emptyState({ iconName, title, description, action })
notice(text, 'info'|'warn'|'danger')
kvList(items)、detailRows(items)、timeline(items)、chips(items)
statusBadge(status, kind) // kind: company|draft|automation|job|deal|intent|email
scoreBadge(score)、scoreMeter(score)
button(label, { variant:'primary'|'ghost'|'danger'|'outline', size:'sm'|'lg', iconName, onClick, disabled, block })
iconButton(iconName, { title, onClick })
icon(name, size)
helpTip(text)
copyButton(value, label)
mailBody(text)
sectionTitle(label, help)
```

### 2.7 `../components/charts.mjs`
`lineChart([{label,value}], {height})`、`barChart([{label,value}], {height})`、`donutChart([{label,value,color}], {size,centerLabel,centerValue})`、`sparkline(values)`、`progressRow({label,value,max})`。

### 2.8 图标
`icon('building')`：可用 `dashboard/compass/building/users/box/target/mail/checkSquare/inbox/pipeline/sparkles/activity/settings/bell/user/plus/search/refresh/download/upload/filter/close/menu/alert/clock/play/pause/trash/edit/arrowRight/shield/globe/database/brain/send/reply/archive/star/check/copy/eye/more/logout/lock/key/link/chart/funnel/list/zap/book/folder/file/calendar/phone/rocket/layers/cpu/server/hardDrive/terminal/info/tag/scale/flag/message`。

## 3. API 数据形状（后端契约，可能随实现微调；请做可选链兜底）

所有接口前缀 `/api/v1`，列表返回 `{ items:[], total, page, pageSize }`。

### 3.1 t-front-data 页面
- **GET /companies** 查询：`page,pageSize,q,country,status,minScore,hasEmail,tag,icpId,productId,sort,order`
  企业对象：`{ id,name,domain,website,country,region,city,companyType,industry,employeeRange,status,tags[],dataQualityScore,confidence,score?,productMatch?,contactCount,emailCount,lastActivityAt,createdAt,updatedAt }`
- **GET /companies/:id** 详情聚合（若后端字段略有差异，优先读 `data`）：
  `{ company, contacts[], sources[], verifications[], matches[], scores[], automationState, threads[], drafts[], deals[], activities[], timeline[] }`
- **GET/POST/PATCH/DELETE** `/companies`、`/companies/:id`；POST `/companies/:id/score` `{productId}`；POST `/companies/:id/enrich|crawl`；GET `/companies/:id/timeline`；POST `/companies/:id/contacts`
- **GET /contacts** `q,companyId,emailStatus,page`；**GET/POST/PATCH/DELETE /contacts**；POST `/contacts/:id/verify`；POST `/contacts/infer-email` `{companyId,firstName,lastName}` → `{ candidates:[{email,status:'inferred',confidence}] }`
- **GET/POST/PATCH/DELETE /products、/icps**；产品字段见 schema；ICP 字段 `targetCountries[],targetCompanyTypes[],targetSizes[],targetRoles[],includeKeywords[],excludeKeywords[],minScore,productId`
- **GET /discovery/runs**；POST `/discovery/runs` `{productId,icpId,countries[],keywords[],provider,maxResults}` → `{run}`；GET `/discovery/runs/:id`；POST `/discovery/runs/:id/cancel`；GET `/discovery/providers`
- **POST /imports** `{kind:'companies'|'contacts'|'suppression',filename,text}` → run；GET `/imports`；GET `/imports/:id`；GET `/export/companies?format=csv` → `{filename,content}`（用 downloadText 保存）
- **POST /companies/bulk** `{action:'score'|'archive'|'assign', ids[], productId?}`

### 3.2 t-front-outreach 页面
- **GET /campaigns** `{items:[{id,name,status,productName,icpName,steps,targets,sent,replied,pendingApproval,createdAt}]}`；POST/PATCH/DELETE；GET/POST `/campaigns/:id/steps`；PATCH/DELETE `/campaigns/:id/steps/:stepId`；POST `/campaigns/:id/enroll` `{companyIds[],contactIds[]}`；POST `/campaigns/:id/pause|resume`；GET `/campaigns/:id/stats`
- **GET /drafts** `status,campaignId,q,page`；详情含 `contact,company,product,guard,quality,history`；POST `/drafts`；PATCH `/drafts/:id`；POST `/drafts/:id/generate`；`/approve`；`/reject` `{reason}`；`/send`；POST `/drafts/batch-approve` `{ids[]}`；GET `/approvals/pending` → `{count,items}`
- **GET /inbox/threads** `unread=1,status,classification,q,page`；GET `/inbox/threads/:id` → `{thread,messages[],classification,company,contact,suggestedReply}`；GET `/inbox/high-intent`；POST `/inbox/threads/:id/reply` `{bodyText}`；POST `/inbox/threads/:id/read`；POST `/inbox/threads/:id/classification` `{label,status:'user_corrected'}`
- **GET /deals/pipeline** → `{stages:[{key,label,items:[{id,title,companyName,contactName,valueAmount,currency,probability,expectedCloseDate,updatedAt}],totalValue,count}]}`；GET/POST/PATCH/DELETE `/deals`；GET `/activities`；GET/POST `/follow-up-tasks`
- **GET /automation/states** `{items:[{companyId,companyName,state,reason,changedAt}]}`；GET `/automation/:companyId`；POST `/automation/:companyId/takeover|resume|pause|do-not-contact|close` `{reason}`
- **GET/POST /suppression**；DELETE `/suppression/:id`

### 3.3 t-front-system 页面
- **GET /agents** → `{ items:[{role,nameZh,description,promptVersion,capabilities[]}], provider:{provider,model,configured,reachable,lastCheckedAt} }`；GET `/agents/executions`；GET `/agents/executions/:id`；POST `/agents/test-provider` → `{ok,provider,model,latencyMs,sample}`；POST `/agents/run` `{role,input}`
- **GET /jobs** `status,type,page` → `{items:[{id,type,status,attempts,maxAttempts,runAt,startedAt,finishedAt,lastError,result,createdAt}]}`；GET `/jobs/stats`；GET `/jobs/:id`；POST `/jobs/:id/cancel|retry`；POST `/jobs/pause|resume`
- **GET /settings** → `{ settings:{outreach,limits,retention,ai,compliance,enrichment}, providers[], credentials[] }`；PATCH `/settings` body 为分组对象（如 `{outreach:{...}}`）；PATCH `/settings/providers/:key` `{isEnabled,config}`；PUT `/settings/credentials/:kind/:providerKey` `{label,secret:{apiKey},config:{baseUrl,model}}`；DELETE `/settings/credentials/:id`
- **GET /workspace**、PATCH `/workspace`、GET/POST/PATCH/DELETE `/workspace/members...`、GET/POST/DELETE `/auth/api-keys`
- **GET /usage?days=30** → `{totals,byCategory,byDay,byAgent}`；GET `/audit?limit&action&page`；GET `/ops/system`、GET `/ops/license`、POST `/ops/backup`、GET `/ops/backup/:name`、GET `/ops/logs`

## 4. 页面交付清单

| 文件 | Owner | 要求 |
| --- | --- | --- |
| `src/pages/dashboard.js` | Lead（已完成） | 参考实现，不要改 |
| `src/pages/discovery.js` | t-front-data | 发现表单 + 运行记录 + 结果查看 |
| `src/pages/companies.js` | t-front-data | 列表/筛选/分页/新建/导入/导出/批量评分 |
| `src/pages/company-detail.js` | t-front-data | 详情聚合 + 联系人/邮件/商机/时间线 Tab + 评分解释 |
| `src/pages/contacts.js` | t-front-data | 列表 + 详情抽屉 + 验证/推断邮箱 |
| `src/pages/products.js` | t-front-data | 产品卡片/表格 + 编辑弹窗（规格 JSON） |
| `src/pages/icps.js` | t-front-data | ICP 列表 + 编辑器 |
| `src/pages/campaigns.js` | t-front-outreach | 活动 CRUD + 步骤编辑 + enroll + 统计 |
| `src/pages/drafts.js` | t-front-outreach | 草稿/审批双模式 + 生成/编辑/审批/发送 |
| `src/pages/inbox.js` | t-front-outreach | 会话列表 + 详情 + 分类/回复/接管 |
| `src/pages/deals.js` | t-front-outreach | 管道看板 + 商机编辑 + 活动/任务 |
| `src/pages/automation.js` | t-front-outreach | 自动化状态 + 接管操作 + 抑制名单 |
| `src/pages/agents.js` | t-front-system | Agent 目录 + Provider 状态/测试 + 执行记录 |
| `src/pages/jobs.js` | t-front-system | 任务统计 + 列表 + 详情 + 取消/重试 + 暂停 |
| `src/pages/settings.js` | t-front-system | 分组设置（工作空间/成员/AI/数据源/邮箱/限额/合规/密钥/用量/审计/备份） |
| `src/styles/pages-data.css` | t-front-data | 仅 `.page-` 前缀 |
| `src/styles/pages-outreach.css` | t-front-outreach | 仅 `.page-` 前缀 |
| `src/styles/pages-system.css` | t-front-system | 仅 `.page-` 前缀 |

## 5. 验收与汇报

- 技术自检：`node --check src/pages/<own files>.js` 全部通过；不得引入第三方 import；不得出现 `style="..."` 或内联事件属性；不得用 innerHTML 插入用户数据。
- 交互完整性：列表 → 详情 → 操作 → 成功/失败反馈 → 空状态；所有表单有前端校验；危险操作有确认。
- 响应式：1600 宽横向排列；≤900 表格可横向滚动/卡片化；≤640 单列。不要写死像素宽度导致溢出。
- 汇报给 Lead：文件、页面功能、调用的 API、已知缺失（后端未实现处）、自检命令结果。**不要声称已在浏览器验证**（由 Lead 验证）。
