/**
 * Generate a random hex ID (wrapper around crypto.randomUUID).
 */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * Insert an entry into the audit_log table.
 */
export async function logAudit(
  db: D1Database,
  userId: string | null,
  tenantId: string | null,
  action: string,
  resourceType: string | null,
  resourceId: string | null,
  details: string | null,
  ipAddress: string | null
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_log (user_id, tenant_id, action, resource_type, resource_id, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(userId, tenantId, action, resourceType, resourceId, details, ipAddress)
    .run();
}

/**
 * Get the client IP from a request (CF headers or fallback).
 */
export function getClientIp(request: Request): string | null {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    null
  );
}
