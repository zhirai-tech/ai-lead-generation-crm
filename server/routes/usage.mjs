/** Usage and cost reporting (Lead-owned). */
import { all, get } from '../core/db.mjs';
import { asInt } from '../core/validate.mjs';
import { addDays, nowIso } from '../core/time.mjs';

export function mount(router) {
  router.get(
    '/api/v1/usage',
    async (ctx) => {
      const days = asInt(ctx.query.get('days'), { fallback: 30, min: 1, max: 365 });
      const since = addDays(-days);
      const totals = get(
        `SELECT
            COALESCE(SUM(CASE WHEN category = 'ai_tokens' THEN quantity ELSE 0 END), 0) AS aiTokens,
            COALESCE(SUM(CASE WHEN category = 'email_sent' THEN quantity ELSE 0 END), 0) AS emailsSent,
            COALESCE(SUM(CASE WHEN category = 'agent_run' THEN quantity ELSE 0 END), 0) AS agentRuns,
            COALESCE(SUM(CASE WHEN category = 'data_lookup' THEN quantity ELSE 0 END), 0) AS dataLookups,
            COALESCE(SUM(cost_estimate), 0) AS costEstimate
          FROM usage_records WHERE workspace_id = ? AND occurred_at >= ?`,
        [ctx.workspace.id, since],
      );
      const byCategory = all(
        `SELECT category, SUM(quantity) AS quantity, SUM(cost_estimate) AS cost
           FROM usage_records WHERE workspace_id = ? AND occurred_at >= ?
          GROUP BY category ORDER BY quantity DESC`,
        [ctx.workspace.id, since],
      );
      const byDay = all(
        `SELECT substr(occurred_at, 1, 10) AS day,
                SUM(CASE WHEN category = 'ai_tokens' THEN quantity ELSE 0 END) AS aiTokens,
                SUM(CASE WHEN category = 'email_sent' THEN quantity ELSE 0 END) AS emailsSent,
                SUM(cost_estimate) AS cost
           FROM usage_records WHERE workspace_id = ? AND occurred_at >= ?
          GROUP BY day ORDER BY day ASC`,
        [ctx.workspace.id, since],
      );
      const byAgent = all(
        `SELECT agent_role, COUNT(*) AS runs, SUM(tokens_in + tokens_out) AS tokens, SUM(cost_estimate) AS cost
           FROM agent_executions WHERE workspace_id = ? AND created_at >= ?
          GROUP BY agent_role ORDER BY runs DESC`,
        [ctx.workspace.id, since],
      );
      return { days, since, now: nowIso(), totals, byCategory, byDay, byAgent };
    },
    { auth: 'required' },
  );
}
