/**
 * API key authentication, lifted out of `_middleware.ts` so the decision takes
 * an explicit `now`. The middleware passes the wall clock; tests pass a pinned
 * one and exercise the real lookup + expiry path against D1, instead of
 * re-running the SQL by hand and trusting that the middleware matches.
 *
 * Expiry semantics live in `shared/apiKeyExpiry.ts` and nowhere else.
 */

import { hashApiKey, isApiKeyExpired } from './auth';
import type { User } from './types';

export type ApiKeyAuthResult =
  | { ok: true; keyId: string; user: User }
  | { ok: false; error: 'Invalid API key' | 'API key expired' | 'Account not found or inactive' };

export async function authenticateApiKey(
  db: D1Database,
  rawKey: string,
  now: Date,
): Promise<ApiKeyAuthResult> {
  const keyHash = await hashApiKey(rawKey);
  const row = await db
    .prepare(
      `SELECT ak.id, ak.expires_at, u.id as uid, u.email, u.name, u.role, u.tenant_id, u.active
       FROM api_keys ak
       JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = ? AND ak.revoked = 0`,
    )
    .bind(keyHash)
    .first<{
      id: string;
      expires_at: string | null;
      uid: string;
      email: string;
      name: string;
      role: string;
      tenant_id: string | null;
      active: number;
    }>();

  if (!row) return { ok: false, error: 'Invalid API key' };
  if (isApiKeyExpired(row.expires_at, now)) return { ok: false, error: 'API key expired' };
  if (!row.active) return { ok: false, error: 'Account not found or inactive' };

  return {
    ok: true,
    keyId: row.id,
    user: {
      id: row.uid,
      email: row.email,
      name: row.name,
      role: row.role as User['role'],
      tenant_id: row.tenant_id,
      active: row.active,
    },
  };
}
