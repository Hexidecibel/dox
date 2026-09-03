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

import { useMemo } from 'react';
import { Alert, AlertTitle, Box, Typography } from '@mui/material';
import OwnerRoutingPanel from '../../components/OwnerRoutingPanel';
import type { ProposedOwnerLabel } from '../../components/OwnerRoutingPanel';
import type { SetupStepProps } from './stepProps';

/**
 * "When a 3rd Party Audit Certificate is 60 days from expiring, QA gets the
 * email."
 *
 * Built from the pack's per-type `owner` key, so it names the actual document
 * types rather than describing a department in the abstract. The window comes
 * from the catalog response (`DEFAULT_WINDOW_DAYS` on the server) rather than a
 * literal here, so the sentence cannot state a number the engine has changed.
 */
export function ownerSentence(
  documentTypes: string[],
  label: string,
  windowDays: number,
): string {
  if (documentTypes.length === 0) {
    return `No document type defaults to ${label} yet — set Owner on a document, or on a document type, and its renewals route here.`;
  }
  const named = documentTypes.slice(0, 2).join(' or a ');
  const rest =
    documentTypes.length > 2
      ? ` (and ${documentTypes.length - 2} other type${documentTypes.length - 2 === 1 ? '' : 's'})`
      : '';
  return `When a ${named}${rest} is ${windowDays} days from expiring, ${label} gets the email.`;
}

export function StepOwners({ tenantId, catalog, pack }: SetupStepProps) {
  const windowDays = catalog?.renewal_window_days ?? 60;

  const proposed = useMemo<ProposedOwnerLabel[]>(() => {
    if (!pack) return [];
    return pack.owner_labels.map((owner) => ({
      owner_label: owner.label,
      note: ownerSentence(owner.document_types, owner.label, windowDays),
    }));
  }, [pack, windowDays]);

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
