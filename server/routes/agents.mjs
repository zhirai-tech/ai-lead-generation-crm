/**
 * OWNER: t-agents — agent catalogue, executions, provider test and runs.
 *
 * Prompt bodies never leave the server: GET /agents only exposes catalogue
 * metadata and the safe provider status (provider/model/source), never keys.
 */
import { AppError, notFound, validationError } from '../core/errors.mjs';
import { asEnum, asObject, asString, parsePagination } from '../core/validate.mjs';
import {
  AGENT_CATALOG,
  AGENT_ROLES,
  EXECUTION_STATUSES,
  MAX_INPUT_BYTES,
  getExecution,
  getProviderInfo,
  listExecutions,
  runAgent,
  testProvider,
} from '../agents/index.mjs';

const ROLE_VALUES = [...AGENT_ROLES];
const STATUS_VALUES = [...EXECUTION_STATUSES];

function inputByteSize(input) {
  try {
    return Buffer.byteLength(JSON.stringify(input ?? {}));
  } catch {
    return Infinity;
  }
}

export function mount(router) {
  // Catalogue + current provider status. Readable by viewers (settings.read).
  router.get(
    '/api/v1/agents',
    async (ctx) => ({
      items: AGENT_CATALOG,
      provider: getProviderInfo(ctx.workspace.id),
      roles: ROLE_VALUES,
      limits: { maxInputBytes: MAX_INPUT_BYTES },
    }),
    { auth: 'required', capability: 'settings.read' },
  );

  router.get(
    '/api/v1/agents/executions',
    async (ctx) => {
      const { page, pageSize } = parsePagination(ctx.query);
      const role = asEnum(ctx.query.get('role') || '', ROLE_VALUES, { label: 'Agent 角色' });
      const status = asEnum(ctx.query.get('status') || '', STATUS_VALUES, { label: '执行状态' });
      return listExecutions(ctx.workspace.id, { page, pageSize, role: role || '', status: status || '' });
    },
    { auth: 'required', capability: 'settings.read' },
  );

  router.get(
    '/api/v1/agents/executions/:id',
    async (ctx) => {
      const executionId = asString(ctx.params.id, { required: true, max: 80, label: '执行 ID' });
      const execution = getExecution(ctx.workspace.id, executionId);
      if (!execution) throw notFound('执行记录不存在');
      return { execution };
    },
    { auth: 'required', capability: 'settings.read' },
  );

  router.post(
    '/api/v1/agents/test-provider',
    async (ctx) => testProvider({ workspaceId: ctx.workspace.id }),
    { auth: 'required', capability: 'settings.read', rateLimit: { windowMs: 60_000, max: 10 } },
  );

  router.post(
    '/api/v1/agents/run',
    async (ctx) => {
      ctx.requireCapability('agents.run');
      const body = asObject(ctx.body, { required: true, label: '请求体' });
      const role = asEnum(body.role, ROLE_VALUES, { required: true, label: 'Agent 角色' });
      const input = body.input === undefined ? {} : asObject(body.input, { label: 'Agent 输入' });
      const size = inputByteSize(input);
      if (!Number.isFinite(size)) throw validationError('Agent 输入无法序列化为 JSON');
      if (size > MAX_INPUT_BYTES) {
        throw new AppError('AGENT_INPUT_TOO_LARGE', `Agent 输入过大（上限 ${MAX_INPUT_BYTES} 字节）`, { status: 413 });
      }
      // runAgent writes the execution row, usage records and the audit event.
      const result = await runAgent({
        workspaceId: ctx.workspace.id,
        role,
        input,
        actorType: 'user',
        actorId: ctx.user.id,
        createdBy: ctx.user.id,
      });
      return result;
    },
    { auth: 'required', rateLimit: { windowMs: 60_000, max: 60 } },
  );
}

export default { mount };
