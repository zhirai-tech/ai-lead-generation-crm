/** OWNER: t-crm (email account configuration routes). */
import * as emailAccounts from '../services/email-accounts.mjs';
import { actorOf } from './crm-shared.mjs';

export function mount(router) {
  router.get('/api/v1/email-accounts', async (ctx) => emailAccounts.list(ctx.workspace.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.post('/api/v1/email-accounts', async (ctx) => emailAccounts.create(ctx.workspace.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'email.accounts.manage',
  });

  router.get('/api/v1/email-accounts/:id', async (ctx) => emailAccounts.detail(ctx.workspace.id, ctx.params.id), {
    auth: 'required',
    capability: 'data.read',
  });

  router.patch('/api/v1/email-accounts/:id', async (ctx) => emailAccounts.update(ctx.workspace.id, ctx.params.id, ctx.body || {}, actorOf(ctx)), {
    auth: 'required',
    capability: 'email.accounts.manage',
  });

  router.delete('/api/v1/email-accounts/:id', async (ctx) => emailAccounts.remove(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'email.accounts.manage',
  });

  router.post('/api/v1/email-accounts/:id/test-connection', async (ctx) => emailAccounts.testConnection(ctx.workspace.id, ctx.params.id), {
    auth: 'required',
    capability: 'email.accounts.manage',
    rateLimit: { windowMs: 60_000, max: 10 },
  });

  router.post('/api/v1/email-accounts/:id/sync', async (ctx) => emailAccounts.syncNow(ctx.workspace.id, ctx.params.id, actorOf(ctx)), {
    auth: 'required',
    capability: 'email.sync',
    rateLimit: { windowMs: 60_000, max: 10 },
  });
}
