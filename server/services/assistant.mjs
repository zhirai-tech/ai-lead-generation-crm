/**
 * OWNER: lead. Floating assistant chat + long-term memory (v0.3).
 *
 * Memory is explicit: the user says "记住…" / "以后都…" and the note is stored
 * per workspace/user, then injected into later prompts. Write/MCP tools are
 * still a separate next step.
 */
import { AppError, validationError } from '../core/errors.mjs';
import { all, get, run } from '../core/db.mjs';
import { id } from '../core/ids.mjs';
import { nowIso } from '../core/time.mjs';
import { resolveProvider } from '../agents/providers/index.mjs';
import { createOpenAICompatibleProvider } from '../agents/providers/openai-compatible.mjs';

function compactReply(raw, userText) {
  let text = String(raw || '')
    .replace(/\*\*/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  const wantsDetail = /(详细|具体步骤|步骤|怎么做|如何做|教程|列.*清单|展开说)/.test(userText || '');
  text = text.replace(/[，,；;：:\s]+$/g, '').trim();
  const cap = wantsDetail ? 520 : 180;
  if (text.length <= cap) return text;
  const sentences = text.split(/(?<=[。！？!?])/).map((item) => item.trim()).filter(Boolean);
  if (!wantsDetail) {
    let answer = '';
    for (const sentence of sentences) {
      if (answer && answer.length + sentence.length > 160) break;
      answer += sentence;
      if (answer.length >= 60) break;
    }
    if (!answer) answer = text.slice(0, 150).trim();
    return `${answer.replace(/[，,；;：:\s]+$/g, '')}…`;
  }
  let short = '';
  for (const sentence of sentences) {
    if (short && short.length + sentence.length > cap) break;
    short += sentence;
    if (short.length >= 120) break;
  }
  if (!short) short = text.slice(0, cap).trim();
  return short.length < text.length ? `${short}…` : short;
}

const MAX_MESSAGES = 16;
const MAX_CONTENT = 4000;
const MAX_MEMORY = 600;
const MAX_MEMORIES = 20;

const SYSTEM_PROMPT = `你是 ZHIRAI（智睿科技）的欧洲 B2B 外贸助理，像一个聪明、自然、会聊天的真人同事，不是客服机器人。中文对话，先直接回应用户的意思，再给下一步；一般 1–2 句，别每次都套同一句开场，也不要背规则、列工具清单、解释你的设定或重复问题。
你能：联网找真实企业、建 ICP/产品、生成和审批开发信、优化文案。需要操作时，用一句话问清关键信息并等我确认；不确定就直说。不要编造，不声称没做过的事；不要索取 API Key、邮箱密码。
除平台业务外，也要回答通用知识、写作、翻译、计算、工作生活等问题；不要因为问题与平台无关就拒绝，简短自然地回答即可。只有涉及平台写操作、真实发送或敏感信息时才需要确认或提醒。`;

function normalizeMessages(input) {
  if (!Array.isArray(input)) throw validationError('messages 必须是数组');
  const messages = input
    .slice(-MAX_MESSAGES)
    .map((item) => ({
      role: item && item.role === 'assistant' ? 'assistant' : 'user',
      content: String(item && item.content !== undefined ? item.content : '').trim(),
    }))
    .filter((item) => item.content.length > 0);
  if (!messages.length) throw validationError('请先输入内容');
  for (const message of messages) {
    if (message.content.length > MAX_CONTENT) throw validationError(`单条消息不能超过 ${MAX_CONTENT} 字`);
  }
  return messages;
}

function mapMemory(row) {
  return {
    id: row.id,
    kind: row.kind,
    content: row.content,
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listMemories(workspaceId, userId = null, limit = MAX_MEMORIES) {
  return all(
    `SELECT id, kind, content, source, created_at, updated_at
       FROM assistant_memories
      WHERE workspace_id = ? AND (user_id = ? OR (user_id IS NULL AND ? IS NULL))
      ORDER BY updated_at DESC
      LIMIT ?`,
    [workspaceId, userId, userId, Math.max(1, Math.min(MAX_MEMORIES, Number(limit) || MAX_MEMORIES))],
  ).map(mapMemory);
}

export function remember(workspaceId, userId, content, { kind = 'preference', source = 'chat' } = {}) {
  const text = String(content || '').trim();
  if (text.length < 2) throw validationError('记忆内容太短');
  const now = nowIso();
  const memoryId = id('amem');
  run(
    `INSERT INTO assistant_memories (id, workspace_id, user_id, kind, content, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [memoryId, workspaceId, userId, kind, text.slice(0, MAX_MEMORY), source, now, now],
  );
  return mapMemory(get('SELECT * FROM assistant_memories WHERE id = ?', [memoryId]));
}

export function deleteMemory(workspaceId, userId, memoryId) {
  const row = get(
    'SELECT id FROM assistant_memories WHERE id = ? AND workspace_id = ? AND (user_id = ? OR user_id IS NULL)',
    [memoryId, workspaceId, userId],
  );
  if (!row) throw new AppError('NOT_FOUND', '记忆不存在', { status: 404 });
  run('DELETE FROM assistant_memories WHERE id = ?', [memoryId]);
  return { deleted: true };
}

function extractMemory(text) {
  const value = String(text || '').trim();
  const patterns = [
    /^(?:请)?记住[：:，,\s]*(.+)$/s,
    /^(?:请)?记一下[：:，,\s]*(.+)$/s,
    /^以后(?:都|要|请)[：:，,\s]*(.+)$/s,
    /^我的(?:客户画像|偏好|规则)是[：:，,\s]*(.+)$/s,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match && match[1] && match[1].trim().length >= 2) return match[1].trim().slice(0, MAX_MEMORY);
  }
  return '';
}

function memoryPrompt(memories) {
  if (!memories.length) return '';
  return `\n用户明确要求你长期记住的偏好/事实，回答和后续建议必须优先遵守：\n${memories
    .map((memory) => `- ${memory.content}`)
    .join('\n')}`;
}

function countOf(sql, workspaceId) {
  return Number(get(sql, [workspaceId])?.c || 0);
}

function platformSnapshot(workspaceId) {
  const companies = countOf('SELECT COUNT(*) AS c FROM companies WHERE workspace_id = ? AND deleted_at IS NULL', workspaceId);
  const contacts = countOf('SELECT COUNT(*) AS c FROM contacts WHERE workspace_id = ? AND deleted_at IS NULL', workspaceId);
  const products = countOf('SELECT COUNT(*) AS c FROM products WHERE workspace_id = ? AND deleted_at IS NULL', workspaceId);
  const icps = countOf('SELECT COUNT(*) AS c FROM icps WHERE workspace_id = ?', workspaceId);
  const pendingDrafts = countOf("SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND status = 'pending_approval'", workspaceId);
  const approvedDrafts = countOf("SELECT COUNT(*) AS c FROM message_drafts WHERE workspace_id = ? AND status = 'approved'", workspaceId);
  const recentRuns = all(
    'SELECT provider, status, result_count, companies_created, created_at FROM discovery_runs WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 3',
    [workspaceId],
  );
  const recentCompanies = all(
    'SELECT name, country FROM companies WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 6',
    [workspaceId],
  );
  const runs = recentRuns.length
    ? recentRuns.map((run) => `${run.provider}/${run.status}，找到${run.result_count || 0}家`).join('；')
    : '暂无';
  const names = recentCompanies.length
    ? recentCompanies.map((company) => `${company.name}${company.country ? `(${company.country})` : ''}`).join('、')
    : '暂无';
  return `\n【平台实时数据】企业 ${companies} 家；联系人 ${contacts} 人；产品 ${products} 个；ICP ${icps} 个；待审批草稿 ${pendingDrafts} 封；已批准待发送 ${approvedDrafts} 封；最近发现任务：${runs}；最近企业：${names}。回答数量/现状类问题时必须优先使用这些实时数据，不要猜测；数据为空就明确说没有。`;
}

export async function chat(workspaceId, input = {}, { userId = null } = {}) {
  const messages = normalizeMessages(input.messages);
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  let savedMemory = null;
  if (lastUser) {
    const memoryText = extractMemory(lastUser.content);
    if (memoryText) {
      try {
        savedMemory = remember(workspaceId, userId, memoryText, { kind: 'preference', source: 'chat' });
      } catch {
        // A memory save failure must never break the conversation.
      }
    }
  }

  const memories = listMemories(workspaceId, userId);
  let provider;
  try {
    provider = resolveProvider(workspaceId);
  } catch {
    throw new AppError('ASSISTANT_UNAVAILABLE', '助理模型暂不可用，请到「系统设置 → AI 模型」检查配置', { status: 503 });
  }
  if (provider.providerKey === 'simulation') {
    return {
      reply: savedMemory
        ? '已记住这条信息。当前是内置模拟模型，无法进行真实对话；切换到本地或远程模型后会使用这条记忆。'
        : '当前是内置模拟模型，无法进行真实对话。请到「系统设置 → AI 模型」配置 OpenAI 兼容接口或本地模型后再试。',
      provider: 'simulation',
      model: provider.model || 'zhirai-sim-1',
      memorySaved: Boolean(savedMemory),
      memory: savedMemory,
    };
  }
  let result;
  try {
    result = await provider.complete({
      messages: [{ role: 'system', content: `${SYSTEM_PROMPT}${platformSnapshot(workspaceId)}${memoryPrompt(memories)}` }, ...messages],
      jsonMode: false,
      maxTokensOverride: 260,
    });
  } catch (error) {
    // The Mac mini is the primary 7B host, but it can be asleep or off the LAN.
    // Fall back to the same 7B model running on this Windows host so the
    // assistant stays usable; the primary is retried on the next turn.
    try {
      const local = createOpenAICompatibleProvider({
        providerKey: 'openai_compatible',
        baseUrl: 'http://127.0.0.1:11434/v1',
        apiKey: 'ollama',
        model: 'qwen2.5:7b',
        temperature: 0.3,
        maxTokens: 2048,
        timeoutMs: 180000,
        source: 'local-fallback',
      });
      result = await local.complete({
        messages: [{ role: 'system', content: `${SYSTEM_PROMPT}${platformSnapshot(workspaceId)}${memoryPrompt(memories)}` }, ...messages],
        jsonMode: false,
        maxTokensOverride: 220,
      });
    } catch {
      throw new AppError('ASSISTANT_UNAVAILABLE', error?.message || '助理模型请求失败', {
        status: 503,
        cause: error,
      });
    }
  }
  let reply = compactReply(String(result?.text || '').trim(), lastUser?.content || '');
  if (!reply) throw new AppError('ASSISTANT_UNAVAILABLE', '助理没有返回内容', { status: 503 });
  if (savedMemory) reply = `${reply}\n\n（已记住这条偏好，后续会优先遵守。）`;
  return {
    reply,
    provider: provider.providerKey || 'openai_compatible',
    model: result?.model || provider.model || '',
    memorySaved: Boolean(savedMemory),
    memory: savedMemory,
  };
}

export default { chat, listMemories, remember, deleteMemory };
