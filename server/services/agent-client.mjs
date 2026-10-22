/**
 * OWNER: t-crm.
 *
 * Thin bridge to the agent layer (owner: t-agents). The agent module is loaded
 * with a dynamic import so that the CRM routes stay importable while the agent
 * work is still in progress; a clear AGENT_UNAVAILABLE error is surfaced when
 * the layer is missing. Tests (and only tests) may inject deterministic
 * implementations through setAgentImplementation().
 */
import { AppError } from '../core/errors.mjs';

const overrides = new Map();

export function setAgentImplementation(name, fn) {
  if (typeof fn !== 'function') throw new Error('agent implementation must be a function');
  overrides.set(name, fn);
}

export function resetAgentImplementations() {
  overrides.clear();
}

export function agentUnavailable(reason = 'agent layer not available') {
  return new AppError('AGENT_UNAVAILABLE', 'AI 服务尚未就绪，请稍后重试', {
    status: 503,
    details: { reason },
  });
}

export function agentFailed(reason = 'agent execution failed') {
  return new AppError('AGENT_FAILED', 'AI 生成失败，请稍后重试', {
    status: 502,
    details: { reason },
  });
}

async function loadAgentModule() {
  try {
    return await import('../agents/index.mjs');
  } catch (error) {
    throw agentUnavailable(error?.message || 'cannot import ../agents/index.mjs');
  }
}

/**
 * Call one of the agent contract functions (CONTRACTS 7.3).
 * @param {string} fnName e.g. 'generateOutreachDraft'
 * @param {object} args   arguments object passed to the agent function
 */
export async function callAgent(fnName, args) {
  const override = overrides.get(fnName);
  if (override) {
    try {
      return await override(args);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw agentFailed(error?.message || `${fnName} failed`);
    }
  }
  const module = await loadAgentModule();
  const fn = module?.[fnName];
  if (typeof fn !== 'function') throw agentUnavailable(`${fnName} is not exported by agents`);
  try {
    return await fn(args);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw agentFailed(error?.message || `${fnName} failed`);
  }
}
