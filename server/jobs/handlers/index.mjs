/**
 * OWNER: t-worker. Job handler registry.
 *
 * Handler signature:
 *   async ({ db, job, config, logger, workspaceId, payload }) => resultObject
 *
 * Throwing fails the job (see worker.isRetryableJobError). A handler may set
 * `error.retryable` / `error.retryDelayMs` (see JobError) to control backoff.
 * Unregistered types fail permanently with a clear message instead of crashing
 * the worker.
 */
import dataHandlers from './data-handlers.mjs';
import crmHandlers from './crm-handlers.mjs';
import emailHandlers from './email-handlers.mjs';
import maintenanceHandlers from './maintenance-handler.mjs';
import agentHandlers from './agent-handlers.mjs';
import { JobError, requirePayloadField } from './errors.mjs';

const registry = new Map();

function registerGroup(group) {
  for (const [type, handler] of Object.entries(group)) {
    if (typeof handler !== 'function') throw new Error(`handler for ${type} is not a function`);
    registry.set(type, handler);
  }
}

registerGroup(dataHandlers);
registerGroup(crmHandlers);
registerGroup(emailHandlers);
registerGroup(maintenanceHandlers);
registerGroup(agentHandlers);

export function getHandler(type) {
  return registry.get(type) || null;
}

export function listHandlerTypes() {
  return [...registry.keys()].sort();
}

/** Test-only hook to register a synthetic handler. */
export function registerHandler(type, handler) {
  registry.set(type, handler);
  return type;
}

export { JobError, requirePayloadField };

export default { getHandler, listHandlerTypes, registerHandler, JobError, requirePayloadField };
