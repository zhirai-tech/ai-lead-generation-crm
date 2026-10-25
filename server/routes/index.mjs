/**
 * Route manifest. Each module exports `mount(router)` and owns its own paths.
 * Route ownership is documented in docs/CONTRACTS.md.
 */
import { mount as auth } from './auth.mjs';
import { mount as workspace } from './workspace.mjs';
import { mount as settings } from './settings.mjs';
import { mount as audit } from './audit.mjs';
import { mount as notifications } from './notifications.mjs';
import { mount as usage } from './usage.mjs';
import { mount as ops } from './ops.mjs';
import { mount as health } from './health.mjs';
import { mount as publicRoutes } from './public.mjs';
import { mount as dashboard } from './dashboard.mjs';
import { mount as companies } from './companies.mjs';
import { mount as contacts } from './contacts.mjs';
import { mount as products } from './products.mjs';
import { mount as productFiles } from './product-files.mjs';
import { mount as productTemplates } from './product-templates.mjs';
import { mount as icps } from './icps.mjs';
import { mount as discovery } from './discovery.mjs';
import { mount as imports } from './imports.mjs';
import { mount as campaigns } from './campaigns.mjs';
import { mount as drafts } from './drafts.mjs';
import { mount as inbox } from './inbox.mjs';
import { mount as deals } from './deals.mjs';
import { mount as automation } from './automation.mjs';
import { mount as suppression } from './suppression.mjs';
import { mount as emailAccounts } from './email-accounts.mjs';
import { mount as agents } from './agents.mjs';
import { mount as assistant } from './assistant.mjs';
import { mount as assistantTts } from './assistant-tts.mjs';
import { mount as assistantTools } from './assistant-tools.mjs';
import { mount as agentTasks } from './agent-tasks.mjs';
import { mount as jobs } from './jobs.mjs';
import { mount as modelSetup } from './model-setup.mjs';

export function mountRoutes(router) {
  health(router);
  publicRoutes(router);
  auth(router);
  workspace(router);
  settings(router);
  audit(router);
  notifications(router);
  usage(router);
  ops(router);
  dashboard(router);
  companies(router);
  contacts(router);
  products(router);
  productFiles(router);
  productTemplates(router);
  icps(router);
  discovery(router);
  imports(router);
  campaigns(router);
  drafts(router);
  inbox(router);
  deals(router);
  automation(router);
  suppression(router);
  emailAccounts(router);
  agents(router);
  assistant(router);
  assistantTts(router);
  assistantTools(router);
  agentTasks(router);
  jobs(router);
  modelSetup(router);
}
