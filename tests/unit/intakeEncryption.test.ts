import { describe, it, expect } from 'vitest';
import {
  encryptIntakeSecret,
  decryptIntakeSecret,
} from '../../functions/lib/intakeEncryption';

// 32 raw bytes (64 hex chars) — valid keys for the helper.
const KEY_A =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const KEY_B =
  'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';

const envA = { INTAKE_ENCRYPTION_KEY: KEY_A };
const envB = { INTAKE_ENCRYPTION_KEY: KEY_B };

describe('encryptIntakeSecret / decryptIntakeSecret', () => {
  it('round-trips: decrypt returns the original plaintext', async () => {
    const secret = 'super-secret-r2-access-key-value';
    const ct = await encryptIntakeSecret(secret, envA);
    const pt = await decryptIntakeSecret(ct, envA);
    expect(pt).toBe(secret);
  });

  it('round-trips multibyte / unicode plaintext', async () => {
    const secret = 'héllo · 世界 · 🔐';
    const ct = await encryptIntakeSecret(secret, envA);
    const pt = await decryptIntakeSecret(ct, envA);
    expect(pt).toBe(secret);
  });

  it('emits the v1: version prefix', async () => {
    const ct = await encryptIntakeSecret('hello', envA);
    expect(ct.startsWith('v1:')).toBe(true);
  });

  it('produces a different ciphertext on each call (random IV)', async () => {
    const secret = 'same-plaintext';
    const a = await encryptIntakeSecret(secret, envA);
    const b = await encryptIntakeSecret(secret, envA);
    expect(a).not.toBe(b);
    expect(await decryptIntakeSecret(a, envA)).toBe(secret);
    expect(await decryptIntakeSecret(b, envA)).toBe(secret);
  });

  it('decrypt throws on tampered ciphertext (auth tag check)', async () => {
    const ct = await encryptIntakeSecret('secret', envA);
    // Flip a character in the base64url payload (after the v1: prefix).
    const idx = ct.length - 3;
    const ch = ct[idx];
    const flipped = ch === 'A' ? 'B' : 'A';
    const tampered = ct.slice(0, idx) + flipped + ct.slice(idx + 1);
    await expect(decryptIntakeSecret(tampered, envA)).rejects.toThrow();
  });

  it('decrypt throws when using a different key', async () => {
    const ct = await encryptIntakeSecret('secret', envA);
    await expect(decryptIntakeSecret(ct, envB)).rejects.toThrow();
  });

  it('throws when the key is missing', async () => {
    await expect(
      encryptIntakeSecret('x', { INTAKE_ENCRYPTION_KEY: '' })
    ).rejects.toThrow(/missing|empty/i);
    await expect(
      decryptIntakeSecret('v1:abcd', { INTAKE_ENCRYPTION_KEY: '' })
    ).rejects.toThrow(/missing|empty/i);
  });

  it('throws when the key is the wrong length', async () => {
    await expect(
      encryptIntakeSecret('x', { INTAKE_ENCRYPTION_KEY: 'deadbeef' })
    ).rejects.toThrow(/64 hex chars|32 bytes/);
  });

  it('throws when the key is not hex', async () => {
    const notHex = 'z'.repeat(64);
    await expect(
      encryptIntakeSecret('x', { INTAKE_ENCRYPTION_KEY: notHex })
    ).rejects.toThrow(/hex/i);
  });

  it('throws on an unsupported version prefix', async () => {
    // Build a v2-prefixed payload by replacing the prefix on a real v1 ciphertext.
    const ct = await encryptIntakeSecret('secret', envA);
    const v2 = 'v2:' + ct.slice(3);
    await expect(decryptIntakeSecret(v2, envA)).rejects.toThrow(
      /unsupported.*version/i
    );
  });

  it('throws on a malformed ciphertext (no version prefix)', async () => {
    await expect(
      decryptIntakeSecret('not-a-valid-ciphertext', envA)
    ).rejects.toThrow(/version prefix/i);
  });
});
