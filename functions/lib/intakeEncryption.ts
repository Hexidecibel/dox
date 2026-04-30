/**
 * Intake credential encryption.
 *
 * AES-GCM-256 round-trip for connector intake secrets (currently the R2
 * secret access key for B3 S3 drop; reusable for any other Phase B
 * intake credential that warrants at-rest encryption).
 *
 * Key material: `INTAKE_ENCRYPTION_KEY` is a 64-character hex string
 * (32 raw bytes / 256 bits) set as a Pages secret per environment.
 *
 * Wire format: `v1:<base64url(iv || ciphertext-with-auth-tag)>`.
 * The `v1:` version prefix lets us rotate keys later without a
 * silent re-decrypt failure on existing rows.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const KEY_HEX_LEN = 64; // 32 raw bytes

type IntakeEnv = { INTAKE_ENCRYPTION_KEY: string };

/**
 * Module-scope cache of imported CryptoKeys, keyed by the raw secret
 * value. Workers reuse the same isolate across invocations within a
 * deployment, and the secret is a constant per deployment, so this is
 * safe and avoids the ~1ms `subtle.importKey` cost on every call.
 */
const keyCache = new Map<string, Promise<CryptoKey>>();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(hex.length / 2);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function validateKey(rawKey: unknown): string {
  if (typeof rawKey !== 'string' || rawKey.length === 0) {
    throw new Error('INTAKE_ENCRYPTION_KEY is missing or empty');
  }
  if (rawKey.length !== KEY_HEX_LEN) {
    throw new Error(
      `INTAKE_ENCRYPTION_KEY must be ${KEY_HEX_LEN} hex chars (32 bytes); got ${rawKey.length}`
    );
  }
  if (!/^[0-9a-fA-F]+$/.test(rawKey)) {
    throw new Error('INTAKE_ENCRYPTION_KEY must be a hex string');
  }
  return rawKey;
}

async function getKey(rawKey: string): Promise<CryptoKey> {
  const cached = keyCache.get(rawKey);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    'raw',
    hexToBytes(rawKey),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );
  keyCache.set(rawKey, promise);
  return promise;
}

export async function encryptIntakeSecret(
  plaintext: string,
  env: IntakeEnv
): Promise<string> {
  const rawKey = validateKey(env.INTAKE_ENCRYPTION_KEY);
  const key = await getKey(rawKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ptBytes = new TextEncoder().encode(plaintext);
  const ctBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    ptBytes
  );
  const ct = new Uint8Array(ctBuffer);
  const combined = new Uint8Array(iv.length + ct.length);
  combined.set(iv, 0);
  combined.set(ct, iv.length);
  return `${VERSION}:${base64UrlEncode(combined)}`;
}

export async function decryptIntakeSecret(
  ciphertext: string,
  env: IntakeEnv
): Promise<string> {
  const rawKey = validateKey(env.INTAKE_ENCRYPTION_KEY);
  if (typeof ciphertext !== 'string' || !ciphertext.includes(':')) {
    throw new Error('Malformed intake ciphertext: missing version prefix');
  }
  const sep = ciphertext.indexOf(':');
  const version = ciphertext.slice(0, sep);
  const payload = ciphertext.slice(sep + 1);
  if (version !== VERSION) {
    throw new Error(`Unsupported intake ciphertext version: ${version}`);
  }
  const combined = base64UrlDecode(payload);
  if (combined.length <= IV_BYTES) {
    throw new Error('Malformed intake ciphertext: payload shorter than IV');
  }
  const iv = combined.slice(0, IV_BYTES);
  const ct = combined.slice(IV_BYTES);
  const key = await getKey(rawKey);
  const ptBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ct
  );
  return new TextDecoder().decode(ptBuffer);
}
