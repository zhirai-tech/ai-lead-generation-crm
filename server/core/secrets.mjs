/** Process-wide secret used for credential encryption and signed tokens. */
import { loadSecret } from './crypto.mjs';

let secret = null;

export function initSecret(config) {
  if (!secret) secret = loadSecret(config.secretFile);
  return secret;
}

export function getSecret() {
  if (!secret) throw new Error('application secret not initialised');
  return secret;
}

export function setSecretForTests(value) {
  secret = value;
}
