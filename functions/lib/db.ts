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

/**
 * Phase B5 — single helper for connector intake events. Every door (manual,
 * email, API, S3, public link) calls this at the dispatch point so the
 * audit_log gets a uniformly-shaped breadcrumb regardless of how the file
 * arrived.
 *
 * `actorUserId` is null for vendor-driven intakes (api, s3, email,
 * public_link) — those have no logged-in user. The manual upload door is
 * the only path that has an admin id to attribute.
 *
 * The `action` is `connector.intake.<source>` so the activity feed can
 * group the audit rows next to the connector_runs they describe.
 *
 * Failures are swallowed — a missing audit row should never break a real
 * intake. We log to console so a dropped row is visible in the Worker log.
 */
export type IntakeSource =
  | 'manual'
  | 'api'
  | 'email'
  | 'webhook'
  | 'r2_poll'
  | 's3'
  | 'public_link'
  | 'api_poll';

export interface LogIntakeParams {
  db: D1Database;
  tenantId: string;
  connectorId: string;
  runId: string;
  source: IntakeSource;
  actorUserId: string | null;
  fileName: string | null;
  fileSize: number | null;
  runStatus: 'success' | 'partial' | 'error' | 'running';
  errorMessage?: string | null;
  ipAddress?: string | null;
  /** Free-form extras merged into the metadata JSON (e.g. sender for email,
   *  bucket+key for s3, last4 of bearer for api/public_link). */
  extra?: Record<string, unknown>;
}

export async function logIntakeEvent(params: LogIntakeParams): Promise<void> {
  const meta = {
    connector_id: params.connectorId,
    run_id: params.runId,
    source: params.source,
    file_name: params.fileName,
    file_size: params.fileSize,
    run_status: params.runStatus,
    ...(params.errorMessage ? { error_message: params.errorMessage } : {}),
    ...(params.extra || {}),
  };
  try {
    await logAudit(
      params.db,
      params.actorUserId,
      params.tenantId,
      `connector.intake.${params.source}`,
      'connector_run',
      params.runId,
      JSON.stringify(meta),
      params.ipAddress ?? null,
    );
  } catch (err) {
    console.warn(
      `logIntakeEvent failed for ${params.source} run ${params.runId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}
