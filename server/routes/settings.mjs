/** Workspace settings, provider configuration and encrypted credentials. */
import { asBool, asEnum, asObject, asString, validateInput } from '../core/validate.mjs';
import { badRequest } from '../core/errors.mjs';
import {
  deleteCredential,
  getSettings,
  listCredentials,
  listProviders,
  saveCredential,
  updateProvider,
  updateSettings,
} from '../services/settings.mjs';

const CREDENTIAL_KINDS = ['ai_provider', 'data_provider', 'email_api', 'webhook'];

export function mount(router) {
  router.get(
    '/api/v1/settings',
    async (ctx) => ({
      settings: getSettings(ctx.workspace.id),
      providers: listProviders(ctx.workspace.id),
      credentials: listCredentials(ctx.workspace.id),
    }),
    { auth: 'required', capability: 'settings.read' },
  );

  router.patch(
    '/api/v1/settings',
    async (ctx) => {
      ctx.requireCapability('settings.manage');
      const body = asObject(ctx.body, { required: true, label: '设置' });
      const patch = body.settings && typeof body.settings === 'object' ? body.settings : body;
      const settings = updateSettings(ctx.workspace.id, patch, {
        actorId: ctx.user.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        requestId: ctx.requestId,
      });
      return { settings };
    },
    { auth: 'required' },
  );

  router.patch(
    '/api/v1/settings/providers/:key',
    async (ctx) => {
      ctx.requireCapability('settings.manage');
      const key = asString(ctx.params.key, { required: true, max: 60 });
      const body = ctx.body || {};
      if (body.isEnabled === undefined && body.config === undefined) throw badRequest('没有需要更新的内容');
      const providers = updateProvider(
        ctx.workspace.id,
        key,
        {
          isEnabled: body.isEnabled === undefined ? undefined : asBool(body.isEnabled),
          config: body.config === undefined ? undefined : asObject(body.config),
        },
        { actorId: ctx.user.id },
      );
      return { providers };
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/settings/credentials',
    async (ctx) => ({ items: listCredentials(ctx.workspace.id) }),
    { auth: 'required', capability: 'settings.read' },
  );

  router.put(
    '/api/v1/settings/credentials/:kind/:providerKey',
    async (ctx) => {
      ctx.requireCapability('credentials.manage');
      const kind = asEnum(ctx.params.kind, CREDENTIAL_KINDS, { required: true, label: '凭据类型' });
      const providerKey = asString(ctx.params.providerKey, { required: true, max: 60 });
      const body = ctx.body || {};
      const label = asString(body.label, { max: 80, label: '名称' });
      const secret = asObject(body.secret, { label: '密钥' });
      const config = asObject(body.config, { label: '配置' });
      const allowedSecretKeys = ['apiKey', 'token', 'secret', 'password', 'webhookSecret', 'username'];
      const cleanSecret = {};
      for (const [key, value] of Object.entries(secret)) {
        if (!allowedSecretKeys.includes(key)) continue;
        if (typeof value === 'string' && value.length <= 500) cleanSecret[key] = value;
      }
      if (!Object.keys(cleanSecret).length && !body.allowEmpty) throw badRequest('至少需要提供一个密钥字段');
      const saved = saveCredential(ctx.workspace.id, kind, providerKey, { label, secret: cleanSecret, config }, { actorId: ctx.user.id });
      return { credential: { ...saved, secretSaved: Object.keys(cleanSecret) }, items: listCredentials(ctx.workspace.id) };
    },
    { auth: 'required' },
  );

  router.delete(
    '/api/v1/settings/credentials/:id',
    async (ctx) => {
      ctx.requireCapability('credentials.manage');
      deleteCredential(ctx.workspace.id, ctx.params.id, { actorId: ctx.user.id });
      return { deleted: true, items: listCredentials(ctx.workspace.id) };
    },
    { auth: 'required' },
  );

  router.get(
    '/api/v1/providers',
    async (ctx) => ({ items: listProviders(ctx.workspace.id) }),
    { auth: 'required', capability: 'settings.read' },
  );
}
