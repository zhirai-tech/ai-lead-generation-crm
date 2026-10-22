/**
 * OWNER: t-worker. t-crm handlers: draft generation, reply classification,
 * follow-up planning and campaign ticks.
 *
 * Campaign advancement: CONTRACTS.md 7.2 exposes `advanceAfterSend` but no
 * "tick" function. If t-crm later exports `advanceCampaign`/`tickCampaign` we
 * delegate to it; otherwise a conservative SQL fallback advances due targets by
 * one step, creates the draft row and enqueues `draft.generate`. It never sends
 * anything directly — sending always stays behind approval + the send pipeline.
 */
import { all, get, run } from '../../core/db.mjs';
import { id } from '../../core/ids.mjs';
import { addDays, nowIso } from '../../core/time.mjs';
import { normalizeDomain, normalizeEmail } from '../../core/validate.mjs';
import { callUpstream, loadUpstream } from '../contracts.mjs';
import { enqueueJob } from '../queue.mjs';
import { recordJobAudit } from '../job-log.mjs';
import { JobError, requirePayloadField } from './index.mjs';

const BLOCKED_AUTOMATION_STATES = new Set(['HUMAN_TAKEOVER', 'DO_NOT_CONTACT', 'PAUSED', 'CLOSED', 'NEEDS_HUMAN_REVIEW']);
const CAMPAIGN_TICK_BATCH = 50;

async function draftGenerate({ job, workspaceId, payload }) {
  const draftId = requirePayloadField(payload, 'draftId');
  const result = await callUpstream('drafts', 'generateDraft', {
    workspaceId,
    draftId,
    actorType: 'system',
    actorId: job.createdBy || null,
  });
  recordJobAudit({
    workspaceId,
    action: 'draft.generate.completed',
    entityType: 'message_draft',
    entityId: draftId,
    after: { jobId: job.id, status: result?.draft?.status || null, subject: result?.draft?.subject || null },
  });
  return { draftId, draft: result?.draft || null };
}

async function replyClassify({ job, workspaceId, payload }) {
  const messageId = requirePayloadField(payload, 'messageId');
  const result = await callUpstream('replies', 'classifyInboundMessage', { workspaceId, messageId, actorType: 'system' });
  recordJobAudit({
    workspaceId,
    action: 'reply.classify.completed',
    entityType: 'email_message',
    entityId: messageId,
    after: {
      jobId: job.id,
      label: result?.classification?.label || null,
      confidence: result?.classification?.confidence ?? null,
      automationState: result?.automationState || null,
    },
  });
  return { messageId, ...result };
}

async function followupPlan({ job, workspaceId, payload }) {
  const threadId = requirePayloadField(payload, 'threadId');
  const messageId = payload.messageId || null;
  const result = await callUpstream('followups', 'planFollowUpForThread', { workspaceId, threadId, messageId, actorType: 'system' });
  recordJobAudit({
    workspaceId,
    action: 'followup.plan.completed',
    entityType: 'email_thread',
    entityId: threadId,
    after: { jobId: job.id, taskId: result?.taskId || null, messageId },
  });
  return { threadId, messageId, ...result };
}

// ------------------------------------------------------------- campaign.tick
function replaceTemplate(text, variables) {
  return String(text || '').replace(/\{\{\s*([a-zA-Z_]+)\s*\}\}/g, (match, key) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function isSuppressed(workspaceId, email, domain) {
  const emailHit = get(
    'SELECT id FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?',
    [workspaceId, 'email', email],
  );
  if (emailHit) return true;
  if (!domain) return false;
  return Boolean(
    get('SELECT id FROM suppression_records WHERE workspace_id = ? AND scope = ? AND value_normalized = ?', [
      workspaceId,
      'domain',
      domain,
    ]),
  );
}

function advanceCampaignFallback({ workspaceId, campaignId, jobId }) {
  const campaign = get('SELECT * FROM campaigns WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', [campaignId, workspaceId]);
  if (!campaign) throw new JobError('活动不存在', { retryable: false, code: 'JOB_INVALID_PAYLOAD' });
  if (campaign.status !== 'active') return { campaignId, skipped: 'campaign_not_active', status: campaign.status };
  const steps = all(
    'SELECT * FROM campaign_steps WHERE campaign_id = ? AND workspace_id = ? AND is_active = 1 ORDER BY step_no ASC',
    [campaignId, workspaceId],
  );
  if (!steps.length) return { campaignId, skipped: 'campaign_has_no_steps' };
  const product = campaign.product_id ? get('SELECT name FROM products WHERE id = ? AND workspace_id = ?', [campaign.product_id, workspaceId]) : null;
  const now = nowIso();
  const due = all(
    `SELECT ct.*, c.email_normalized AS contact_email, c.email AS contact_email_raw, c.full_name AS contact_name,
            c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.deleted_at AS contact_deleted,
            co.name AS company_name, co.domain AS company_domain
       FROM campaign_targets ct
       JOIN contacts c ON c.id = ct.contact_id AND c.workspace_id = ct.workspace_id
       JOIN companies co ON co.id = ct.company_id AND co.workspace_id = ct.workspace_id
      WHERE ct.workspace_id = ? AND ct.campaign_id = ?
        AND ct.status IN ('enrolled', 'active')
        AND (ct.next_run_at IS NULL OR ct.next_run_at <= ?)
      ORDER BY ct.next_run_at ASC, ct.created_at ASC
      LIMIT ?`,
    [workspaceId, campaignId, now, CAMPAIGN_TICK_BATCH],
  );
  const summary = { campaignId, due: due.length, draftsCreated: 0, enqueued: 0, completed: 0, paused: 0, failed: 0, skipped: 0 };
  for (const target of due) {
    const email = normalizeEmail(target.contact_email || target.contact_email_raw || '');
    const domain = normalizeDomain(email ? email.split('@')[1] : target.company_domain || '');
    const contactName = target.contact_name || [target.contact_first_name, target.contact_last_name].filter(Boolean).join(' ');
    if (target.contact_deleted || !email) {
      run("UPDATE campaign_targets SET status = 'failed', next_run_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?", [now, target.id, workspaceId]);
      summary.failed += 1;
      continue;
    }
    const automation = get('SELECT state, reason FROM automation_states WHERE workspace_id = ? AND company_id = ?', [workspaceId, target.company_id]);
    if ((automation && BLOCKED_AUTOMATION_STATES.has(automation.state)) || isSuppressed(workspaceId, email, domain)) {
      run("UPDATE campaign_targets SET status = 'paused', next_run_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?", [now, target.id, workspaceId]);
      recordJobAudit({
        workspaceId,
        action: 'campaign.target.paused',
        entityType: 'campaign_target',
        entityId: target.id,
        after: { reason: automation?.state || 'suppression', jobId },
      });
      summary.paused += 1;
      continue;
    }
    const nextStep = steps.find((step) => step.step_no === target.current_step + 1) || steps.find((step) => step.step_no > target.current_step);
    if (!nextStep) {
      run("UPDATE campaign_targets SET status = 'completed', next_run_at = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?", [now, target.id, workspaceId]);
      summary.completed += 1;
      continue;
    }
    const existingDraft = get(
      `SELECT id, status FROM message_drafts
        WHERE workspace_id = ? AND campaign_id = ? AND campaign_step_id = ? AND contact_id = ?
        ORDER BY created_at ASC LIMIT 1`,
      [workspaceId, campaignId, nextStep.id, target.contact_id],
    );
    let draftId = existingDraft?.id || null;
    if (!draftId) {
      const variables = {
        company: target.company_name || '',
        contact_name: contactName,
        first_name: target.contact_first_name || '',
        last_name: target.contact_last_name || '',
        product: product?.name || '',
        title: '',
      };
      draftId = id('drf');
      run(
        `INSERT INTO message_drafts
           (id, workspace_id, company_id, contact_id, campaign_id, campaign_step_id, account_id, subject, body_text,
            language, status, generated_by, quality_json, guard_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'draft', NULL, '{}', '{}', ?, ?)`,
        [
          draftId,
          workspaceId,
          target.company_id,
          target.contact_id,
          campaignId,
          nextStep.id,
          replaceTemplate(nextStep.subject_template, variables),
          replaceTemplate(nextStep.body_template, variables),
          nextStep.language || 'en',
          now,
          now,
        ],
      );
      summary.draftsCreated += 1;
    }
    if (draftId) {
      const queued = enqueueJob({
        workspaceId,
        type: 'draft.generate',
        payload: { draftId },
        dedupeKey: `draft.generate:${workspaceId}:${draftId}`,
        priority: 80,
        createdBy: null,
      });
      if (!queued.deduped) summary.enqueued += 1;
    }
    const delayDays = Math.max(0, Number(nextStep.delay_days) || 0);
    // Do NOT advance `current_step` here: the step is only considered sent when
    // the draft is actually delivered, and t-crm's `advanceAfterSend` performs
    // that increment (called by the send pipeline). We only push next_run_at out
    // so the same target is not re-scanned on every tick while the draft awaits
    // approval.
    run(
      "UPDATE campaign_targets SET status = 'active', next_run_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?",
      [addDays(Math.max(1, delayDays), new Date(now).getTime()), now, target.id, workspaceId],
    );
  }
  if (summary.due) {
    recordJobAudit({
      workspaceId,
      action: 'campaign.tick.advanced',
      entityType: 'campaign',
      entityId: campaignId,
      after: { ...summary, jobId },
    });
  }
  return summary;
}

async function campaignTick({ job, workspaceId, payload }) {
  const campaignId = requirePayloadField(payload, 'campaignId');
  let campaignsModule = null;
  try {
    campaignsModule = await loadUpstream('campaigns');
  } catch {
    campaignsModule = null;
  }
  const advance = campaignsModule && (campaignsModule.advanceCampaign || campaignsModule.tickCampaign);
  if (typeof advance === 'function') {
    const result = await advance({ workspaceId, campaignId, actorType: 'system', actorId: job.createdBy || null, jobId: job.id });
    return { campaignId, delegated: true, ...(result && typeof result === 'object' ? result : {}) };
  }
  return advanceCampaignFallback({ workspaceId, campaignId, jobId: job.id });
}

/** Exported for unit tests. */
export { advanceCampaignFallback, replaceTemplate };

export const handlers = {
  'draft.generate': draftGenerate,
  'reply.classify': replyClassify,
  'followup.plan': followupPlan,
  'campaign.tick': campaignTick,
};

export default handlers;
