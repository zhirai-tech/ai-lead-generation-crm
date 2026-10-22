/**
 * OWNER: t-worker. Mail client facade.
 *
 * The CRM module (`services/email-accounts.mjs`) discovers a mail client through
 * `../mail/client.mjs` to test SMTP/IMAP connectivity from the settings UI. This
 * module exposes the connection tests implemented in `smtp.mjs` / `imap.mjs` and
 * a unified `testConnection({ account, secret, config })` entry point.
 *
 * Sending itself is *not* exposed here: outbound mail must go through
 * `server/jobs/send-pipeline.mjs` (approval / suppression / automation /
 * window / limit / duplicate / circuit-breaker checks).
 */
import { resolveSmtpConfig, testSmtpConnection } from './smtp.mjs';
import { resolveImapConfig, testImapConnection } from './imap.mjs';
import { isSimulationAccount } from './simulation.mjs';

function describe(result) {
  return result && result.ok ? '连接成功' : `连接失败：${(result && result.error) || '未知错误'}`;
}

/**
 * Test the configured mail connection for one account.
 * @param {{account?:object, secret?:object, config?:object}} input
 * @returns {Promise<{ok:boolean, success:boolean, mode:string, message:string, details:object}>}
 */
export async function testConnection({ account = {}, secret = {}, config = {} } = {}) {
  if (isSimulationAccount(account)) {
    return { ok: true, success: true, mode: 'simulation', message: '模拟邮箱可用，无需外部连接', details: null };
  }
  const protocol = String(account.protocol || 'smtp_imap').toLowerCase();
  if (protocol !== 'smtp_imap') {
    return { ok: false, success: false, mode: protocol, message: `不支持的邮箱协议：${protocol}`, details: null };
  }
  const smtpConfig = resolveSmtpConfig(account, secret, config);
  const imapConfig = resolveImapConfig(account, secret, config);
  const details = {};
  if (smtpConfig.host) {
    details.smtp = await testSmtpConnection(account, secret, { config });
  } else {
    details.smtp = { ok: false, error: '未配置 SMTP 主机' };
  }
  if (imapConfig.host) {
    details.imap = await testImapConnection(account, secret, { config });
  }
  const smtpOk = Boolean(details.smtp?.ok);
  const imapOk = details.imap ? Boolean(details.imap.ok) : true;
  const ok = smtpOk && imapOk;
  const parts = [`SMTP：${describe(details.smtp)}`];
  if (details.imap) parts.push(`IMAP：${describe(details.imap)}`);
  return { ok, success: ok, mode: 'smtp_imap', message: parts.join('；'), details };
}

/** Aliases expected by older call sites / CRM discovery. */
export const verifyAccount = testConnection;
export const testAccount = testConnection;

export { testSmtpConnection, testImapConnection, resolveSmtpConfig, resolveImapConfig };

export default { testConnection, verifyAccount, testAccount, testSmtpConnection, testImapConnection };
