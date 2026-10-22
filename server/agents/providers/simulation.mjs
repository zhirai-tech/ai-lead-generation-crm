/**
 * Deterministic offline simulation provider.
 *
 * This is the default when no model API key is configured. It never performs
 * network I/O, returns fixed-shape JSON per role and is always labelled as
 * `simulation` (execution.provider / pricing 0), so no one can mistake its
 * output for a real model call.
 */
import { AppError } from '../../core/errors.mjs';
import { getAgent } from '../catalog.mjs';
import { simulateRole } from '../simulation.mjs';

export const SIMULATION_MODEL = 'zhirai-sim-1';
export const SIMULATION_NOTE = '内置离线模拟 Provider：未调用任何外部模型 API。';

export function createSimulationProvider({ model = SIMULATION_MODEL, source = 'default' } = {}) {
  return {
    key: 'simulation',
    providerKey: 'simulation',
    model,
    isSimulation: true,
    source,
    baseUrlHost: null,
    timeoutMs: null,
    pricing: { inputPer1k: 0, outputPer1k: 0 },

    async complete({ role, input } = {}) {
      if (!role || !getAgent(role)) {
        throw new AppError('AGENT_INVALID_OUTPUT', `未知 Agent 角色：${role || ''}`, { status: 400 });
      }
      const output = simulateRole(role, input || {});
      return {
        text: JSON.stringify(output),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model,
        simulated: true,
      };
    },

    async test() {
      return {
        sample: {
          ok: true,
          provider: 'simulation',
          model,
          note: SIMULATION_NOTE,
        },
      };
    },
  };
}

export default { createSimulationProvider, SIMULATION_MODEL, SIMULATION_NOTE };
