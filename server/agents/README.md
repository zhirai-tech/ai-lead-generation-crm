# Agent 层（t-agents）

> 服务端私有模块。**提示词正文与输出 schema 绝不返回前端**，静态服务也禁止访问 `server/**`。

## 目录

```
server/agents/
  index.mjs              # 对外唯一入口（其他模块只 import 这里）
  catalog.mjs            # AGENT_CATALOG 元数据（浏览器安全）
  roles.mjs              # 角色白名单（10 个）
  schemas.mjs            # 10 个角色的输出 JSON Schema
  schema.mjs             # 轻量校验器 + JSON 解析（剥离 ```json 围栏）
  simulation.mjs         # 离线确定性模拟输出（按角色构造，纯函数）
  runner.mjs             # runAgent：提示词拼装/调用/重试/记账/审计
  executions.mjs         # agent_executions + usage_records 读写、预算统计
  prompts/*.md           # 版本化提示词（front matter: role/version/output）
  providers/
    index.mjs            # resolveProvider / getProviderInfo / testProvider
    openai-compatible.mjs# 任意 OpenAI Chat Completions 兼容接口（默认 DeepSeek）
    simulation.mjs       # 离线模拟 Provider（成本 0）
```

## 对外 API（docs/CONTRACTS.md 7.3）

```js
import {
  AGENT_CATALOG, runAgent, testProvider,
  generateOutreachDraft, qualifyCompany, classifyReply, planFollowUp,
  companyResearch, matchProduct, complianceCheck, reviewQuality,
} from '../agents/index.mjs';

await runAgent({ workspaceId, role, input, actorType, actorId, jobId, createdBy });
// -> { executionId, output, usage: { provider, model, isSimulation, promptVersion,
//      tokensIn, tokensOut, totalTokens, costEstimate, latencyMs, jobId } }
```

便捷函数接受 `{ workspaceId, context, language, actorType, actorId, jobId, createdBy }`，
内部按角色**裁剪最小必要上下文**后调用 `runAgent`，直接返回 `output`：

| 函数 | 角色 |
| --- | --- |
| `generateOutreachDraft` | `outreach_writer` |
| `qualifyCompany` | `company_qualification` |
| `classifyReply` | `reply_classification` |
| `planFollowUp` | `follow_up_planning` |
| `companyResearch` | `market_research` |
| `matchProduct` | `product_matching` |
| `complianceCheck` | `compliance_guard` |
| `reviewQuality` | `quality_review` |

`runAgent` 的输入：`input` 必须是对象且 ≤ 64KB；模型输出必须通过角色 schema 校验
（≤ 120KB），失败时带加强提示重试 1 次，仍失败抛 `AppError('AGENT_INVALID_OUTPUT')`。

## Provider 解析优先级

1. 工作空间 `integration_credentials`（`kind='ai_provider'`，加密存储，服务端解密）
2. `settings.ai` 选择真实 provider + 环境变量 `AI_API_KEY` 提供密钥
3. 进程环境 `AI_PROVIDER / AI_BASE_URL / AI_API_KEY / AI_MODEL`
4. **内置 `simulation`（离线、确定性、成本 0）**

未配置密钥时永远回退 simulation，execution 会明确记录 `provider='simulation'`，
成本 0，`testProvider` 返回 `isSimulation: true`——模拟结果不得当作真实模型结果。

OpenAI 兼容 Provider：先尝试 `response_format: {type:'json_object'}`，接口拒绝时
自动去掉并重试；`AbortController` 默认 60s 超时；错误映射为
`AGENT_PROVIDER_AUTH / RATE_LIMIT / TIMEOUT / UNAVAILABLE / ERROR`，错误信息会
抹掉 API Key。密钥从不写日志、不返回前端、不进入 `input_json`（自动脱敏）。

## 执行与账务

每次 `runAgent` 写：

- `agent_executions`：status（running→succeeded/failed）、`input_json`（脱敏+限长）、
  `output_json`、`prompt_version`（如 `outreach_writer@1`）、provider、model、
  tokens_in/out、cost_estimate、latency_ms、job_id、created_by、started/finished_at、
  error；失败也保留可追溯记录。
- `usage_records`：`agent_run`（quantity 1, unit `run`）+ `ai_tokens`
  （quantity = tokens_in + tokens_out, unit `tokens`），均带 cost_estimate。
- `audit_events`：`action='agent.run'`。

预算：`settings.limits.dailyAiTokens` 为当日（UTC）AI token 上限，用量达到上限后
直接拒绝执行并返回 `AGENT_BUDGET_EXCEEDED`（HTTP 429，`details.limit/used`），
不会调用模型、不会产生 execution 行。simulation 的 token 记为 0，不消耗预算。

成本：simulation 固定 0；真实 Provider 按 `credentials.config.pricing` 或
`settings.ai.pricing`（`{ inputPer1k, outputPer1k }`，USD）估算，无配置时用内置常量。

## HTTP 路由（`server/routes/agents.mjs`）

| 方法/路径 | 权限 | 说明 |
| --- | --- | --- |
| `GET /api/v1/agents` | `settings.read` | 目录 + provider 状态（无密钥/提示词正文） |
| `GET /api/v1/agents/executions` | `settings.read` | 分页 + role/status 过滤 |
| `GET /api/v1/agents/executions/:id` | `settings.read` | 执行详情（含 input/output） |
| `POST /api/v1/agents/test-provider` | `settings.read` | 连通性测试，限流 10/min |
| `POST /api/v1/agents/run` | `agents.run` | `{ role, input }`，校验白名单/大小，限流 60/min |

所有查询均按 `ctx.workspace.id` 过滤，执行记录不跨工作空间。

## 提示词与事实约束

`prompts/<role>.md` 均由 front matter（role/version/output）与系统提示组成，统一约束：
只用输入事实；未知写 unknown；禁止编造客户案例/认证/产能/价格/交期；区分事实/推断；
只输出一个 JSON 对象。修改提示词时请递增 `version`，`prompt_version` 会自动变化。

## 测试

```bash
node --test tests/unit/agents-*.test.mjs
node --test tests/integration/agents-*.test.mjs
```

测试默认离线：`tests/unit/agents-support.mjs` 在导入 Agent 模块前清空 `AI_*` 环境变量，
未配置凭据时只会使用 simulation；重试/预算/失败路径通过注入 fake provider 覆盖，
不会发起真实网络请求。
