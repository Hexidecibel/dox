/**
 * Connector credential encryption using AES-256-GCM.
 * Master key stored in CONNECTOR_ENCRYPTION_KEY env var.
 * Per-connector key derived via HKDF (master + tenantId + connectorId).
 */

async function deriveKey(
  masterKey: string,
  tenantId: string,
  connectorId: string
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(masterKey),
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode(`${tenantId}:${connectorId}`),
      info: encoder.encode('connector-credentials'),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptCredentials(
  credentials: Record<string, unknown>,
  masterKey: string,
  tenantId: string,
  connectorId: string
): Promise<{ encrypted: string; iv: string }> {
  const key = await deriveKey(masterKey, tenantId, connectorId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const data = encoder.encode(JSON.stringify(credentials));

  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );

  return {
    encrypted: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
  };
}

export async function decryptCredentials(
  encrypted: string,
  iv: string,
  masterKey: string,
  tenantId: string,
  connectorId: string
): Promise<Record<string, unknown>> {
  const key = await deriveKey(masterKey, tenantId, connectorId);

  const encryptedBuf = Uint8Array.from(atob(encrypted), c => c.charCodeAt(0));
  const ivBuf = Uint8Array.from(atob(iv), c => c.charCodeAt(0));

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ivBuf },
    key,
    encryptedBuf
  );

  const decoder = new TextDecoder();
  return JSON.parse(decoder.decode(decrypted));
}
