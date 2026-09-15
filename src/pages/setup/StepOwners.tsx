/**
 * Screen 3 — "Who owns renewals?"
 *
 * `documents.owner` (migration 0077) is a free-text department — QA, Insurance,
 * Accounting, Purchasing — and `owner_routes` (0091) is what turns that label
 * into somebody's inbox. Until a label has a recipient, every record carrying it
 * is reported as a routing gap and NOBODY is emailed: renewal alerts pass
 * `adminFallback: false` on purpose, because a recurring job that falls back to
 * the admin pool trains everyone to ignore it.
 *
 * So this screen exists to spend that fact, not to hide it. Every label the pack
 * proposes gets a row and a sentence naming the certificates riding on it, and
 * an unrouted label is shown in warning colours with what it costs written out.
 *
 * IT DOES NOT BLOCK. Next is always available. A tenant that skips this is
 * correctly configured and quietly unalerted, which is a legitimate choice for
 * somebody evaluating the product — and screen 5's readiness list says so again.
 *
 * THE PANEL IS REUSED, NOT REBUILT. `OwnerRoutingPanel` is the same component
 * Settings → Owner Routing renders, with its summary header suppressed (two
 * progress bars on one screen read as two measurements) and the pack's
 * departments handed to it as `proposedLabels`. Rebuilding the add/remove flow
 * here would fork the one place that knows a route may point at a bare email —
 * the broker case, which is most of Insurance.
 */

import { useEffect, useMemo, useState } from 'react';
import { Alert, AlertTitle, Box, Typography } from '@mui/material';
import OwnerRoutingPanel from '../../components/OwnerRoutingPanel';
import type { ProposedOwnerLabel } from '../../components/OwnerRoutingPanel';
import { api } from '../../lib/api';
import {
  DEFAULT_RENEWAL_ALERT_LEAD_DAYS,
  resolveRenewalAlertLead,
} from '../../../shared/renewalLeadTime';
import type { SetupStepProps } from './stepProps';

/**
 * The tenant's renewal alert lead time as this screen needs it (migration
 * 0111): the organization's stored setting, and the per-type overrides keyed
 * by normalized type name. Null values mean "inherit", exactly as in
 * `resolveRenewalAlertLead`.
 */
export interface WizardLeadTime {
  tenantLeadDays: number | null;
  typeOverrides: Record<string, number>;
}

function typeKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * "60 days", or "30 to 90 days" when this department's types resolve to
 * different lead times (a per-type override). Every type the department owns
 * counts, not only the two the sentence names, so the number cannot understate
 * the spread. Resolution is the engine's own ladder (type -> tenant -> default).
 */
export function leadDaysPhrase(
  documentTypes: string[],
  lead: WizardLeadTime | number,
): string {
  if (typeof lead === 'number') return `${lead} days`;
  const days =
    documentTypes.length === 0
      ? [resolveRenewalAlertLead(null, lead.tenantLeadDays).days]
      : documentTypes.map(
          (t) => resolveRenewalAlertLead(lead.typeOverrides[typeKey(t)], lead.tenantLeadDays).days,
        );
  const min = Math.min(...days);
  const max = Math.max(...days);
  return min === max ? `${min} days` : `${min} to ${max} days`;
}

/**
 * "When a 3rd Party Audit Certificate is 60 days from expiring, QA gets the
 * email."
 *
 * Built from the pack's per-type `owner` key, so it names the actual document
 * types rather than describing a department in the abstract. The number is the
 * tenant's RESOLVED renewal alert lead time (GET /api/expirations/lead-time:
 * per-type override -> organization setting -> default), so the sentence says
 * what the engine will actually do for this tenant. A brand-new tenant has
 * neither setting and reads the default, which the catalog also reports.
 */
export function ownerSentence(
  documentTypes: string[],
  label: string,
  lead: WizardLeadTime | number,
): string {
  if (documentTypes.length === 0) {
    return `No document type defaults to ${label} yet — set Owner on a document, or on a document type, and its renewals route here.`;
  }
  const named = documentTypes.slice(0, 2).join(' or a ');
  const rest =
    documentTypes.length > 2
      ? ` (and ${documentTypes.length - 2} other type${documentTypes.length - 2 === 1 ? '' : 's'})`
      : '';
  return `When a ${named}${rest} is ${leadDaysPhrase(documentTypes, lead)} from expiring, ${label} gets the email.`;
}

export function StepOwners({ tenantId, catalog, pack }: SetupStepProps) {
  const fallbackDays = catalog?.renewal_window_days ?? DEFAULT_RENEWAL_ALERT_LEAD_DAYS;
  const [leadTime, setLeadTime] = useState<WizardLeadTime | null>(null);

  // Non-fatal: if the read fails (or the Compliance module is off, which gates
  // /api/expirations), the sentence falls back to the default the catalog
  // reports rather than blocking the screen.
  useEffect(() => {
    let cancelled = false;
    api.expirations.leadTime
      .get({ tenantId })
      .then((res) => {
        if (cancelled) return;
        const typeOverrides: Record<string, number> = {};
        for (const o of res.document_type_overrides ?? []) typeOverrides[typeKey(o.name)] = o.lead_days;
        setLeadTime({ tenantLeadDays: res.lead_days, typeOverrides });
      })
      .catch(() => {
        if (!cancelled) setLeadTime(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const lead: WizardLeadTime | number = leadTime ?? fallbackDays;

  const proposed = useMemo<ProposedOwnerLabel[]>(() => {
    if (!pack) return [];
    return pack.owner_labels.map((owner) => ({
      owner_label: owner.label,
      note: ownerSentence(owner.document_types, owner.label, lead),
    }));
  }, [pack, lead]);

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 2 }}>
        Renewal alerts go to the department that owns the record, not to a general admin pool. Each
        department below needs one recipient — somebody with a portal account, or a plain email
        address for the broker or site manager who will never have one.
      </Typography>

      <Alert severity="info" sx={{ mb: 2 }}>
        <AlertTitle>What an unrouted department costs</AlertTitle>
        Nothing is broken by leaving one blank, and nothing here blocks the next screen. But there
        is <strong>no fallback</strong>: certificates owned by <em>Insurance</em> will show as a
        routing gap rather than emailing anyone, and the same for every other label left empty. That
        is deliberate — a daily digest that reaches the whole admin pool is a digest everybody
        filters.
      </Alert>

      {!pack && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No starter pack has been applied to this tenant yet, so there are no proposed departments
          — only whatever labels are already on documents. Go back to the first screen to seed one.
        </Alert>
      )}

      <OwnerRoutingPanel tenantId={tenantId} hideSummary proposedLabels={proposed} />
    </Box>
  );
}

export default StepOwners;
