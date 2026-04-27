/**
 * GET /api/admin/learning-dashboard
 *
 * Read-only aggregation endpoint that powers the admin "is the model getting
 * smarter?" page. Pulls from Phase 2 capture tables + audit_log + queue. No
 * writes, no side effects.
 *
 * Auth: super_admin (any tenant via ?tenant_id=) OR org_admin (own tenant).
 *
 * Response shape:
 *   - override_rate_weekly: 12 weekly buckets of total approves vs approves
 *     that produced at least one edit/dismiss capture row.
 *   - review_burden_weekly: 12 weekly buckets of median seconds-per-approve
 *     (queue created_at → audit_log queue_item.approved created_at).
 *   - trust_distribution: empty until Phase 3b ships the trust ladder.
 *   - recent_demotions: empty until Phase 3b.
 *   - pick_volume_by_supplier: top 10 suppliers by reviewer_field_picks count
 *     this calendar month.
 */

import {
  requireRole,
  requireTenantAccess,
  errorToResponse,
} from '../../lib/permissions';
import type { Env, User } from '../../lib/types';

interface WeeklyOverrideRow {
  week_start: string;
  total_approves: number;
  approves_with_overrides: number;
  rate: number;
}

interface WeeklyBurdenRow {
  week_start: string;
  median_seconds_per_approve: number | null;
}

interface SupplierVolumeRow {
  supplier_id: string;
  supplier_name: string | null;
  pick_count: number;
}

const WEEKS_BACK = 12;

/**
 * Compute the ISO date (YYYY-MM-DD) for the Monday on or before a given date.
 * Used to bucket events by calendar week consistently.
 */
function weekStart(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

/**
 * Build a 12-element ordered list of week_start strings ending with the
 * current week. Front-fills empty buckets so the chart renders continuously
 * even when no data exists for a given week.
 */
function buildWeekScaffold(weeks: number): string[] {
  const today = new Date();
  const out: string[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - i * 7);
    out.push(weekStart(d));
  }
  return [...new Set(out)];
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const user = context.data.user as User;
    requireRole(user, 'super_admin', 'org_admin');

    const url = new URL(context.request.url);
    const tenantParam = url.searchParams.get('tenant_id');

    // Scope: super_admin can omit tenant_id (global aggregate) or pass any
    // tenant_id; org_admin is forced to their own tenant.
    let tenantId: string | null;
    if (user.role === 'super_admin') {
      tenantId = tenantParam ?? null;
    } else {
      tenantId = user.tenant_id;
      if (tenantParam && tenantParam !== tenantId) {
        // Defensive — requireTenantAccess would also reject below.
        requireTenantAccess(user, tenantParam);
      }
    }

    const db = context.env.DB;

    const tenantClause = tenantId ? 'AND tenant_id = ?' : '';
    const tenantParams = tenantId ? [tenantId] : [];

    // ---- Override rate weekly ----
    // "Approve" = audit_log row with action 'queue_item.approved' or
    //   'queue_item.auto_ingested'. Auto-ingested items have no human in the
    //   loop, so they're always "no override" — but we still count them
    //   toward total_approves so the rate reflects actual ingestion volume.
    // "Override" = approve where ANY reviewer_field_picks row with
    //   chosen_source IN ('edited','vlm') OR a reviewer_field_dismissals
    //   row exists for the same queue_item_id.
    const sinceMs = Date.now() - WEEKS_BACK * 7 * 24 * 60 * 60 * 1000;
    const sinceIso = new Date(sinceMs).toISOString();

    const approveRows = await db
      .prepare(
        `SELECT id, tenant_id, resource_id, action, created_at
         FROM audit_log
         WHERE action IN ('queue_item.approved','queue_item.auto_ingested')
           AND created_at >= ?
           ${tenantClause}`
      )
      .bind(sinceIso, ...tenantParams)
      .all<{ id: number; tenant_id: string; resource_id: string; action: string; created_at: string }>();

    const overrideQueueIds = new Set<string>();
    const pickRows = await db
      .prepare(
        `SELECT DISTINCT queue_item_id
         FROM reviewer_field_picks
         WHERE chosen_source IN ('edited','vlm')
           AND created_at >= ?
           ${tenantClause}`
      )
      .bind(sinceIso, ...tenantParams)
      .all<{ queue_item_id: string }>();
    for (const r of pickRows.results ?? []) overrideQueueIds.add(r.queue_item_id);

    const dismissalRows = await db
      .prepare(
        `SELECT DISTINCT queue_item_id
         FROM reviewer_field_dismissals
         WHERE created_at >= ?
           ${tenantClause}`
      )
      .bind(sinceIso, ...tenantParams)
      .all<{ queue_item_id: string }>();
    for (const r of dismissalRows.results ?? []) overrideQueueIds.add(r.queue_item_id);

    const overrideByWeek = new Map<string, { total: number; overridden: number }>();
    for (const r of approveRows.results ?? []) {
      const wk = weekStart(new Date(r.created_at));
      const bucket = overrideByWeek.get(wk) ?? { total: 0, overridden: 0 };
      bucket.total++;
      if (overrideQueueIds.has(r.resource_id)) bucket.overridden++;
      overrideByWeek.set(wk, bucket);
    }

    const scaffold = buildWeekScaffold(WEEKS_BACK);
    const override_rate_weekly: WeeklyOverrideRow[] = scaffold.map(week_start => {
      const b = overrideByWeek.get(week_start) ?? { total: 0, overridden: 0 };
      return {
        week_start,
        total_approves: b.total,
        approves_with_overrides: b.overridden,
        rate: b.total === 0 ? 0 : b.overridden / b.total,
      };
    });

    // ---- Review burden weekly ----
    // Median seconds from queue created_at → audit log approved_at, bucketed
    // by the week the approve happened in. Missing queue rows skip silently.
    const burdenRows = await db
      .prepare(
        `SELECT a.created_at AS approved_at, q.created_at AS queued_at
         FROM audit_log a
         JOIN processing_queue q ON q.id = a.resource_id
         WHERE a.action = 'queue_item.approved'
           AND a.created_at >= ?
           ${tenantId ? 'AND a.tenant_id = ?' : ''}`
      )
      .bind(sinceIso, ...tenantParams)
      .all<{ approved_at: string; queued_at: string }>();

    const burdenByWeek = new Map<string, number[]>();
    for (const r of burdenRows.results ?? []) {
      const approvedMs = new Date(r.approved_at).getTime();
      const queuedMs = new Date(r.queued_at).getTime();
      if (!Number.isFinite(approvedMs) || !Number.isFinite(queuedMs)) continue;
      const seconds = Math.max(0, (approvedMs - queuedMs) / 1000);
      const wk = weekStart(new Date(r.approved_at));
      const list = burdenByWeek.get(wk) ?? [];
      list.push(seconds);
      burdenByWeek.set(wk, list);
    }

    const review_burden_weekly: WeeklyBurdenRow[] = scaffold.map(week_start => ({
      week_start,
      median_seconds_per_approve: median(burdenByWeek.get(week_start) ?? []),
    }));

    // ---- Pick volume by supplier (this calendar month) ----
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const monthIso = monthStart.toISOString();

    const supplierRows = await db
      .prepare(
        `SELECT p.supplier_id AS supplier_id, s.name AS supplier_name, COUNT(*) AS pick_count
         FROM reviewer_field_picks p
         LEFT JOIN suppliers s ON s.id = p.supplier_id
         WHERE p.created_at >= ?
           AND p.supplier_id IS NOT NULL
           ${tenantId ? 'AND p.tenant_id = ?' : ''}
         GROUP BY p.supplier_id
         ORDER BY pick_count DESC
         LIMIT 10`
      )
      .bind(monthIso, ...tenantParams)
      .all<SupplierVolumeRow>();

    const pick_volume_by_supplier: SupplierVolumeRow[] = (supplierRows.results ?? []).map(r => ({
      supplier_id: r.supplier_id,
      supplier_name: r.supplier_name,
      pick_count: Number(r.pick_count) || 0,
    }));

    return new Response(
      JSON.stringify({
        override_rate_weekly,
        review_burden_weekly,
        trust_distribution: [],
        recent_demotions: [],
        pick_volume_by_supplier,
      }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    const httpErr = errorToResponse(err);
    if (httpErr) return httpErr;
    console.error('Learning dashboard error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal server error' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};
