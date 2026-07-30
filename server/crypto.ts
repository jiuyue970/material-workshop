import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const source = process.env.APP_ENCRYPTION_KEY || 'material-workshop-local-development-key';
const key = createHash('sha256').update(source).digest();

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

export function decrypt(value: string) {
  const [iv, tag, encrypted] = value.split('.').map((part) => Buffer.from(part!, 'base64url'));
  const decipher = createDecipheriv('aes-256-gcm', key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(encrypted!), decipher.final()]).toString('utf8');
}
