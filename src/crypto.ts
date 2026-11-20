import crypto from 'node:crypto';
import { config } from './config.js';

function key() {
  const raw = config.CREDENTIAL_ENCRYPTION_KEY;
  return /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : crypto.createHash('sha256').update(raw).digest();
}

export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64url'), tag.toString('base64url'), encrypted.toString('base64url')].join('.');
}

export function decryptJson<T>(payload: string): T {
  const [ivEncoded, tagEncoded, encryptedEncoded] = payload.split('.');
  if (!ivEncoded || !tagEncoded || !encryptedEncoded) throw new Error('Invalid encrypted payload');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(ivEncoded, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encryptedEncoded, 'base64url')), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8')) as T;
}

export function hashToken(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}
