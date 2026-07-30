import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto.js';

describe('provider secret encryption', () => {
  it('round trips without storing plaintext', () => {
    const encrypted = encrypt('secret-value');
    expect(encrypted).not.toContain('secret-value');
    expect(decrypt(encrypted)).toBe('secret-value');
  });
});
