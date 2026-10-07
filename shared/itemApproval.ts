/**
 * Approved items, facilities and a customer's COA requirements (migration
 * 0135; decisions C-001, C-002, C-004): the vocabulary and the few pure rules,
 * in one place so the API, the screens and the order review cannot word or
 * decide them differently.
 *
 * Nothing in this file is read by the gap engine, the renewal engine, search
 * or the spec engine. Approval, facility and customer requirements inform a
 * person; they change no verdict.
 */

import type {
  CustomerCoaRequired,
  ItemApprovalSource,
  ItemApprovalStatus,
} from './types';

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export const ITEM_APPROVAL_STATUSES: readonly ItemApprovalStatus[] = ['approved', 'pending', 'not_approved'];

/** A pair created after 0135 starts here, whatever door made it. */
export const DEFAULT_ITEM_APPROVAL_STATUS: ItemApprovalStatus = 'pending';

export const ITEM_APPROVAL_LABELS: Record<ItemApprovalStatus, string> = {
  approved: 'Approved',
  pending: 'Pending',
  not_approved: 'Not approved',
};

export function isItemApprovalStatus(v: unknown): v is ItemApprovalStatus {
  return typeof v === 'string' && (ITEM_APPROVAL_STATUSES as readonly string[]).includes(v);
}

/**
 * Where an approval came from, in words. `initial` is the 0135 backfill:
 * everything on file started approved and NOBODY decided it, so it must never
 * read as a person's sign-off.
 */
export function describeApprovalSource(source: ItemApprovalSource | string | null | undefined): string {
  switch (source) {
    case 'person':
      return 'Decided by a person';
    case 'import':
      return 'From the supplier list';
    case 'initial':
      return 'On file when approvals were introduced';
    default:
      return 'Not decided yet';
  }
}

// ---------------------------------------------------------------------------
// Facility names
// ---------------------------------------------------------------------------

/**
 * The key a facility is unique on under its supplier: lower-cased, whitespace
 * collapsed. "Lynden  Plant" and "lynden plant" are one facility. Computed
 * here, never in SQL (the owner_routes.owner_key discipline).
 */
export function normalizeFacilityName(name: string | null | undefined): string {
  return (name ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// Private label
// ---------------------------------------------------------------------------

function partyKey(v: string | null | undefined): string {
  return (v ?? '').replace(/\s+/g, '').toLowerCase();
}

/**
 * An item is private label when a brand owner AND a producer are both recorded
 * and they are different parties, compared ignoring case and spaces.
 *
 * A DISPLAY FLAG ONLY. One of them missing is "not known", which is not the
 * same as private label, so it reads false. Nothing is blocked by this.
 */
export function isPrivateLabel(
  brandOwner: string | null | undefined,
  producer: string | null | undefined,
): boolean {
  const a = partyKey(brandOwner);
  const b = partyKey(producer);
  return a !== '' && b !== '' && a !== b;
}

// ---------------------------------------------------------------------------
// A customer's COA requirement for one item
// ---------------------------------------------------------------------------

export const CUSTOMER_COA_REQUIRED_VALUES: readonly CustomerCoaRequired[] = ['yes', 'no', 'on_request'];

export const CUSTOMER_COA_REQUIRED_LABELS: Record<CustomerCoaRequired, string> = {
  yes: 'COA required',
  no: 'No COA needed',
  on_request: 'COA on request',
};

export function isCustomerCoaRequired(v: unknown): v is CustomerCoaRequired {
  return typeof v === 'string' && (CUSTOMER_COA_REQUIRED_VALUES as readonly string[]).includes(v);
}

/**
 * The one line the order review prints for an item's requirement:
 * "COA required - must show lot number and best-by date - with the shipment".
 */
export function describeCustomerRequirement(req: {
  coa_required: CustomerCoaRequired;
  must_show?: string | null;
  timing?: string | null;
}): string {
  const parts: string[] = [CUSTOMER_COA_REQUIRED_LABELS[req.coa_required] ?? String(req.coa_required)];
  const mustShow = (req.must_show ?? '').trim();
  if (mustShow) parts.push(`must show ${mustShow}`);
  const timing = (req.timing ?? '').trim();
  if (timing) parts.push(timing);
  return parts.join(' - ');
}
