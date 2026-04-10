import { describe, it, expect } from 'vitest';
import { encryptCredentials, decryptCredentials } from '../../functions/lib/connectors/crypto';

const MASTER_KEY = 'test-master-encryption-key-32bytes!!';

describe('encryptCredentials / decryptCredentials', () => {
  it('round-trips: decrypt returns original data', async () => {
    const creds = { api_key: 'secret-123', url: 'https://erp.example.com' };
    const { encrypted, iv } = await encryptCredentials(creds, MASTER_KEY, 'tenant-1', 'conn-1');
    const decrypted = await decryptCredentials(encrypted, iv, MASTER_KEY, 'tenant-1', 'conn-1');
    expect(decrypted).toEqual(creds);
  });

  it('encrypted output is base64 strings', async () => {
    const { encrypted, iv } = await encryptCredentials(
      { key: 'value' },
      MASTER_KEY,
      'tenant-1',
      'conn-1'
    );
    // Should be valid base64
    expect(() => atob(encrypted)).not.toThrow();
    expect(() => atob(iv)).not.toThrow();
  });

  it('different connector IDs produce different ciphertexts', async () => {
    const creds = { key: 'same-value' };
    const a = await encryptCredentials(creds, MASTER_KEY, 'tenant-1', 'conn-A');
    const b = await encryptCredentials(creds, MASTER_KEY, 'tenant-1', 'conn-B');
    // Ciphertext should differ (different derived keys + random IVs)
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it('different tenant IDs produce different ciphertexts', async () => {
    const creds = { key: 'same-value' };
    const a = await encryptCredentials(creds, MASTER_KEY, 'tenant-A', 'conn-1');
    const b = await encryptCredentials(creds, MASTER_KEY, 'tenant-B', 'conn-1');
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it('wrong tenant ID fails to decrypt', async () => {
    const creds = { key: 'secret' };
    const { encrypted, iv } = await encryptCredentials(creds, MASTER_KEY, 'tenant-1', 'conn-1');
    await expect(
      decryptCredentials(encrypted, iv, MASTER_KEY, 'wrong-tenant', 'conn-1')
    ).rejects.toThrow();
  });

  it('wrong master key fails to decrypt', async () => {
    const creds = { key: 'secret' };
    const { encrypted, iv } = await encryptCredentials(creds, MASTER_KEY, 'tenant-1', 'conn-1');
    await expect(
      decryptCredentials(encrypted, iv, 'wrong-master-key-that-is-different', 'tenant-1', 'conn-1')
    ).rejects.toThrow();
  });

  it('handles complex nested credentials', async () => {
    const creds = {
      oauth: { client_id: 'id', client_secret: 'secret', scopes: ['read', 'write'] },
      api_url: 'https://api.example.com',
      port: 443,
    };
    const { encrypted, iv } = await encryptCredentials(creds, MASTER_KEY, 'tenant-1', 'conn-1');
    const decrypted = await decryptCredentials(encrypted, iv, MASTER_KEY, 'tenant-1', 'conn-1');
    expect(decrypted).toEqual(creds);
  });
});
