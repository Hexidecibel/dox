import { logAudit, getClientIp } from '../../lib/db';
import {
  requireRole,
  requireTenantAccess,
  BadRequestError,
  NotFoundError,
  errorToResponse,
} from '../../lib/permissions';
import { clampStep, getRunById } from '../../lib/tenant-setup';
import type { Env, User } from '../../lib/types';
import type { TenantSetupStatus, UpdateTenantSetupRequest } from '../../../shared/types';

/**
 * PATCH /api/tenant-setup/:id — the autosave target.
 *
 * The wizard debounces 600ms after the last interaction and PATCHes here, the
 * same shape as `records/FormBuilder.tsx` and `WorkflowBuilder.tsx`. What it is
 * saving is a POSITION — which screen, plus the wizard's own scratch — so a
 * failed save costs somebody a re-click and never a setting. Every setting was
 * already written to its own table by its own endpoint before this call.
 *
 * PATCH rather than PUT: three independent fields move at different times
 * (`current_step` on every navigation, `state` on every interaction, `status`
 * once at the end), and a PUT would make the caller resend the other two and
 * race itself.
 */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const STATUSES: readonly TenantSetupStatus[] = ['draft', 'completed', 'abandoned'];

export const onRequestPatch: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const runId = context.params.id as string;
    const existing = await getRunById(context.env.DB, runId);
    if (!existing) throw new NotFoundError('Setup run not found');
    // Tenant isolation is the same check as everywhere else: the run's OWN
    // tenant decides, never a tenant_id from the body.
    requireTenantAccess(user, existing.tenant_id);

    const body = (await context.request.json().catch(() => ({}))) as UpdateTenantSetupRequest;

    const sets: string[] = [];
    const values: unknown[] = [];

    if (body.current_step !== undefined) {
      sets.push('current_step = ?');
      values.push(clampStep(body.current_step));
    }

    if (body.state !== undefined) {
      if (body.state === null || typeof body.state !== 'object' || Array.isArray(body.state)) {
        throw new BadRequestError('state must be an object');
      }
      sets.push('state = ?');
      values.push(JSON.stringify(body.state));
    }

    if (body.pack !== undefined) {
      sets.push('pack = ?');
      values.push(body.pack === null ? null : String(body.pack));
    }

    let statusChange: TenantSetupStatus | null = null;
    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) {
        throw new BadRequestError(`status must be one of ${STATUSES.join(', ')}`);
      }
      // A finished run is history. Re-opening one would break the partial
      // unique index's promise (two drafts for a tenant that also has a
      // completed run) and, worse, would rewrite a provenance record. Starting
      // again is POST { restart: true }, which opens a new row.
      if (existing.status !== 'draft' && body.status !== existing.status) {
        throw new BadRequestError(
          `This run is already ${existing.status}. Start a new one instead of re-opening it.`,
        );
      }
      statusChange = body.status;
      sets.push('status = ?');
      values.push(body.status);
      if (body.status === 'completed') {
        sets.push("completed_at = datetime('now')", 'completed_by = ?');
        values.push(user.id);
      }
    }

    if (sets.length === 0) {
      // Nothing to write is not an error — the autosave fires on a debounce and
      // may land with nothing new to say.
      return json({ run: existing });
    }

    sets.push("updated_at = datetime('now')");
    values.push(runId);

    await context.env.DB.prepare(
      `UPDATE tenant_setup_runs SET ${sets.join(', ')} WHERE id = ?`,
    )
      .bind(...values)
      .run();

    const run = await getRunById(context.env.DB, runId);

    // Step and scratch changes are not audited: they fire every few seconds and
    // would bury the audit log in noise. A status change is the one thing here
    // worth a permanent row.
    if (statusChange && statusChange !== existing.status) {
      await logAudit(
        context.env.DB,
        user.id,
        existing.tenant_id,
        `tenant_setup.${statusChange}`,
        'tenant_setup_run',
        runId,
        JSON.stringify({ pack: run?.pack ?? null, current_step: run?.current_step ?? null }),
        getClientIp(context.request),
      );
    }

    return json({ run });
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('tenant-setup patch error:', err);
    return json({ error: 'Internal server error' }, 500);
  }
};
