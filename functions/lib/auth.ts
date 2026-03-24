function base64UrlEncode(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Hash a password using PBKDF2 with a random salt.
 * Returns "salt:hash" as hex strings.
 */
export async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return `${toHex(salt.buffer)}:${toHex(derivedBits)}`;
}

/**
 * Verify a password against a stored "salt:hash" string.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;

  const encoder = new TextEncoder();
  const salt = fromHex(saltHex);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const derivedHex = toHex(derivedBits);
  return derivedHex === hashHex;
}

interface TokenPayload {
  sub: string;
  email: string;
  role: string;
  tenantId: string | null;
}

/**
 * Generate a JWT with HMAC-SHA256 and 24h expiry.
 */
export async function generateToken(
  payload: TokenPayload,
  secret: string
): Promise<string> {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encoder = new TextEncoder();

  const now = Date.now();
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + 24 * 60 * 60 * 1000,
  };

  const headerB64 = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(encoder.encode(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  const signatureB64 = base64UrlEncode(signature);

  return `${signingInput}.${signatureB64}`;
}

/**
 * Verify and decode a JWT. Returns the payload or null if invalid/expired.
 */
export async function verifyToken(
  token: string,
  secret: string
): Promise<TokenPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));

  if (!valid) return null;

  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64)));

  if (payload.exp && payload.exp < Date.now()) return null;

  return {
    sub: payload.sub,
    email: payload.email,
    role: payload.role,
    tenantId: payload.tenantId ?? null,
  };
}

/**
 * Generate a random hex ID.
 */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Generate an API key with a recognizable prefix.
 * Returns the full key and a short prefix for display.
 */
export function generateApiKey(): { key: string; prefix: string } {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const key = `dox_sk_${hex}`;
  const prefix = key.substring(0, 12);
  return { key, prefix };
}

/**
 * SHA-256 hash an API key for secure storage.
 */
export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
