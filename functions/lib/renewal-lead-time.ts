/**
 * "What would this change?" for a renewal alert lead time (migration 0111).
 *
 * An admin moving the organization from 60 to 90 days is deciding to warn
 * owners about every record 61-90 days out, and some of those owners will
 * start chasing suppliers the next morning. So the settings screens show the
 * consequence BEFORE saving: how many records newly enter the alert set at the
 * next run, how many of those would actually be mailed (the re-alert ledger
 * still applies), and how many leave.
 *
 * READ-ONLY. It runs the same classifier the engine runs (computeExpirations
 * with LEAD_TIME_WINDOW) twice — once with the stored configuration, once with
 * the proposal — and the same `decideSend` the scheduled run applies. Nothing
 * is written: no ledger stamp, no audit row, no mail.
 */

import type { D1Database } from '@cloudflare/workers-types';
import { BadRequestError } from './permissions';
import type { User } from './types';
import {
  computeExpirations,
  isAlertStatus,
  LEAD_TIME_WINDOW,
  type ExpirationRow,
  type LeadTimeOverride,
} from './expirations';
import { decideSend, loadAlertState, type SendDecision } from './renewal-alerts';
import type {
  RenewalAlertLeadSource,
  ResolvedRenewalAlertLead,
} from '../../shared/renewalLeadTime';

/** super_admin may name any tenant; everyone else gets their own. */
export function resolveLeadTimeTenantId(user: User, requested: string | null | undefined): string {
  if (user.role === 'super_admin') {
    if (!requested) throw new BadRequestError('tenant_id is required for super_admin');
    return requested;
  }
  return user.tenant_id!;
}

/** Cap on the listed documents; the counts are always complete. */
export const PREVIEW_DOCUMENT_LIMIT = 25;

export interface LeadTimePreviewDocument {
  id: string;
  title: string;
  owner: string | null;
  primary_category_name: string | null;
  renewal_due_date: string | null;
  days_until: number | null;
  status: string;
  /** Lead time under the PROPOSED configuration. */
  alert_lead_days: number;
  alert_lead_source: RenewalAlertLeadSource;
  /** Lead time under the configuration stored today. */
  current_alert_lead_days: number;
  /**
   * What the scheduled run would decide for it under the proposal; null for a
   * record that would not be alerting at all (the `leaving` list).
   */
  next_run_decision: SendDecision | null;
}

export interface LeadTimePreview {
  as_of: string;
  scope: 'tenant' | 'document_type';
  document_type_id: string | null;
  /** The proposed value; null = inherit / default. */
  proposed_lead_days: number | null;
  /** The tenant-level lead under the current and the proposed configuration. */
  current_tenant_lead: ResolvedRenewalAlertLead;
  proposed_tenant_lead: ResolvedRenewalAlertLead;
  /** Alerting documents today, and under the proposal. */
  current_alerting_count: number;
  proposed_alerting_count: number;
  /** In the proposal's alert set and not in today's. */
  newly_entering_count: number;
  /** Of those, the ones the next scheduled run would actually mail. */
  newly_entering_would_send_count: number;
  /** In today's alert set and not in the proposal's. Nothing is sent for these. */
  leaving_count: number;
  /** Documents whose resolved lead time differs at all, alerting or not. */
  lead_changed_count: number;
  newly_entering: LeadTimePreviewDocument[];
  leaving: LeadTimePreviewDocument[];
}

export interface LeadTimeProposal {
  scope: 'tenant' | 'document_type';
  leadDays: number | null;
  documentTypeId?: string;
}

function previewDoc(
  row: ExpirationRow,
  currentLead: number,
  decision: SendDecision | null,
): LeadTimePreviewDocument {
  return {
    id: row.id,
    title: row.title,
    owner: row.owner,
    primary_category_name: row.primary_category_name,
    renewal_due_date: row.renewal_due_date,
    days_until: row.days_until,
    status: row.status,
    alert_lead_days: row.alert_lead_days,
    alert_lead_source: row.alert_lead_source,
    current_alert_lead_days: currentLead,
    next_run_decision: decision,
  };
}

export async function previewLeadTimeChange(
  db: D1Database,
  tenantId: string,
  asOf: string,
  proposal: LeadTimeProposal,
): Promise<LeadTimePreview> {
  const override: LeadTimeOverride =
    proposal.scope === 'tenant'
      ? { tenantLeadDays: proposal.leadDays }
      : { documentTypeId: proposal.documentTypeId, typeLeadDays: proposal.leadDays };

  const current = await computeExpirations(db, tenantId, asOf, LEAD_TIME_WINDOW);
  const proposed = await computeExpirations(db, tenantId, asOf, LEAD_TIME_WINDOW, override);

  const currentById = new Map(current.rows.map((r) => [r.id, r]));
  const proposedById = new Map(proposed.rows.map((r) => [r.id, r]));
  const currentAlerting = new Set(current.rows.filter((r) => isAlertStatus(r.status)).map((r) => r.id));
  const proposedAlerting = new Set(proposed.rows.filter((r) => isAlertStatus(r.status)).map((r) => r.id));

  const state = await loadAlertState(db, tenantId);

  const entering = proposed.rows.filter((r) => proposedAlerting.has(r.id) && !currentAlerting.has(r.id));
  const enteringDocs = entering.map((r) =>
    previewDoc(
      r,
      currentById.get(r.id)?.alert_lead_days ?? r.alert_lead_days,
      // The scheduled run's rule, cooldown respected: a record mailed last
      // week and toggled out and back in is honestly reported as suppressed.
      decideSend(r, state.get(r.id), asOf),
    ),
  );

  const leaving = current.rows
    .filter((r) => currentAlerting.has(r.id) && !proposedAlerting.has(r.id))
    .map((r) => previewDoc(proposedById.get(r.id) ?? r, r.alert_lead_days, null));

  const leadChanged = proposed.rows.filter(
    (r) => currentById.get(r.id)?.alert_lead_days !== r.alert_lead_days,
  ).length;

  return {
    as_of: asOf,
    scope: proposal.scope,
    document_type_id: proposal.scope === 'document_type' ? proposal.documentTypeId ?? null : null,
    proposed_lead_days: proposal.leadDays,
    current_tenant_lead: current.tenant_lead,
    proposed_tenant_lead: proposed.tenant_lead,
    current_alerting_count: currentAlerting.size,
    proposed_alerting_count: proposedAlerting.size,
    newly_entering_count: enteringDocs.length,
    newly_entering_would_send_count: enteringDocs.filter((d) => d.next_run_decision !== null && d.next_run_decision !== 'suppressed').length,
    leaving_count: leaving.length,
    lead_changed_count: leadChanged,
    newly_entering: enteringDocs.slice(0, PREVIEW_DOCUMENT_LIMIT),
    leaving: leaving.slice(0, PREVIEW_DOCUMENT_LIMIT),
  };
}
