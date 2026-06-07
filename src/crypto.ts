import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { config } from './config.js';

/**
 * Symmetric encryption for client secrets (e.g. n8n API keys) using
 * AES-256-GCM. The 32-byte key comes from config.ENCRYPTION_KEY (64 hex chars,
 * already validated). Each ciphertext carries its own random IV and auth tag:
 *
 *     base64(iv) : base64(authTag) : base64(ciphertext)
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit nonce, recommended for GCM
const KEY = Buffer.from(config.ENCRYPTION_KEY, 'hex'); // 32 bytes

export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

export function decrypt(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 3) {
    throw new Error('decrypt: malformed ciphertext (expected "iv:authTag:ciphertext")');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(authTag); // throws on tampering / wrong key during final()
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return plaintext.toString('utf8');
}
