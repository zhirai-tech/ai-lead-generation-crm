/** First-run / settings model setup endpoints for the desktop build. */
import { asObject, asString } from '../core/validate.mjs';
import * as modelSetup from '../services/model-setup.mjs';

export function mount(router) {
  router.get(
    '/api/v1/model-setup/status',
    async () => modelSetup.status(),
    { auth: 'required', capability: 'settings.read' },
  );

  router.get(
    '/api/v1/model-setup/lan',
    async () => modelSetup.scanLan(),
    { auth: 'required', capability: 'settings.read' },
  );

  router.post(
    '/api/v1/model-setup/pull',
    async (ctx) => {
      ctx.requireCapability('settings.manage');
      const body = asObject(ctx.body, { required: true, label: '模型安装参数' });
      return modelSetup.pullModel({
        workspaceId: ctx.workspace.id,
        model: body.model,
        actorId: ctx.user.id,
      });
    },
    { auth: 'required' },
  );

  router.post(
    '/api/v1/model-setup/use',
    async (ctx) => {
      ctx.requireCapability('settings.manage');
      const body = asObject(ctx.body, { required: true, label: '模型配置' });
      return modelSetup.useModel({
        workspaceId: ctx.workspace.id,
        model: body.model,
        baseUrl: body.baseUrl,
        actorId: ctx.user.id,
      });
    },
    { auth: 'required' },
  );
}

export default { mount };
