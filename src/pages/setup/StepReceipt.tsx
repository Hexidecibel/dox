/**
 * Screen 5 — "Here is what exists now."
 *
 * A receipt. It asks for nothing, offers no control, and has no opinion about
 * whether the tenant is finished: it lists what is in the tables, with three
 * real rows from each so the numbers are checkable, and a link to the page that
 * owns each one.
 *
 * EVERYTHING IS READ BACK OUT OF THE TENANT, never out of the wizard's ledger.
 * That is the difference between a receipt and a summary of intentions. A screen
 * that echoed what the earlier screens had *sent* would look right in exactly
 * the case where something went wrong.
 *
 * THE READINESS CHECKLIST IS A SHARED COMPONENT (`SetupReadinessList`), because
 * screen 6 shows the same list after the demo document lands and the two must
 * agree about what "ready" means. Agreement by shared function, not by shared
 * colour scheme.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  Divider,
  Link as MuiLink,
  Paper,
  Stack,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import {
  SetupReadinessList,
  buildReadinessItems,
  loadReadinessSnapshot,
} from '../../components/SetupReadinessList';
import type { SetupReadinessSnapshot } from '../../components/SetupReadinessList';
import type { SetupStepProps } from './stepProps';

/** One block of the ledger: a heading, a count, three real rows, a link. */
interface LedgerSection {
  key: string;
  title: string;
  count: number;
  unit: string;
  examples: string[];
  href: string;
  linkLabel: string;
  /** A standing sentence. Present where the number alone would mislead. */
  note?: string;
}

function sectionsFrom(snap: SetupReadinessSnapshot, packetsDefined: number): LedgerSection[] {
  return [
    {
      key: 'document_types',
      title: 'What a document IS',
      count: snap.documentTypes.count,
      unit: 'document types',
      examples: snap.documentTypes.examples,
      href: '/settings/document-types',
      linkLabel: 'Document types',
    },
    {
      key: 'requirements',
      title: 'What a document SATISFIES',
      count: snap.requirements.count,
      unit: 'checklist items',
      examples: snap.requirements.examples,
      href: '/settings/requirements',
      linkLabel: 'Checklist',
    },
    {
      key: 'claim_types',
      title: 'What a document TRIGGERS',
      count: snap.claimTypes.count,
      unit: 'claims',
      examples: snap.claimTypes.examples,
      href: '/settings/claim-types',
      linkLabel: 'Claims',
    },
    {
      key: 'spec_tests',
      title: 'Lab results, and what counts as a pass',
      count: snap.specTests.count,
      unit: 'analytes',
      examples: snap.specTests.examples,
      href: '/settings/spec-limits',
      linkLabel: 'Spec limits',
      note: `${snap.specLimits.count} of them carry one of your own acceptance limits. Every certificate is also judged against the limit it prints itself, which needs no configuration at all.`,
    },
    {
      key: 'owner_routes',
      title: 'Who hears about a renewal',
      count: snap.ownerRouting.routed,
      unit: `of ${snap.ownerRouting.labels} departments routed`,
      examples: snap.ownerRouting.gaps.slice(0, 3).map((g) => `${g} — nobody yet`),
      href: '/settings/owner-routes',
      linkLabel: 'Owner routing',
      note:
        snap.ownerRouting.gaps.length > 0
          ? 'Records owned by an unrouted department are reported as a routing gap. No email is sent and nothing falls back to the admin pool.'
          : undefined,
    },
    {
      key: 'suppliers',
      title: 'Suppliers on file',
      count: snap.suppliers.count,
      unit: 'suppliers',
      examples: snap.suppliers.examples,
      href: '/admin/suppliers',
      linkLabel: 'Suppliers',
      note: 'Suppliers appear on their own as documents are processed. There is nothing to fill in here up front.',
    },
    {
      key: 'supplier_requirements',
      title: 'Supplier packets',
      count: snap.supplierRequirements.suppliers,
      // The sentence the whole row exists for. The live tenant's checklist is
      // uniform-and-wrong because six items were bulk-written across 21
      // suppliers; a receipt that read "3 packets ready" would invite exactly
      // that again.
      unit: 'suppliers have a checklist',
      examples: [],
      href: '/settings/supplier-requirements',
      linkLabel: 'Supplier requirements',
      note: `${packetsDefined} packet${packetsDefined === 1 ? '' : 's'} defined, applied to ${snap.supplierRequirements.suppliers} suppliers. A packet is a starting point for a supplier, not a rule for all of them. You will apply one to each supplier as they arrive.`,
    },
  ];
}

export function StepReceipt({ tenantId, pack }: SetupStepProps) {
  const [snap, setSnap] = useState<SetupReadinessSnapshot | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSnap(await loadReadinessSnapshot(tenantId));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !snap) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (!snap) {
    return <Alert severity="error">Could not read the tenant back. Try reloading the page.</Alert>;
  }

  const packetsDefined =
    pack?.sections.find((s) => s.key === 'requirement_packets')?.count ?? 0;
  const sections = sectionsFrom(snap, packetsDefined);

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 2 }}>
        Nothing to fill in here. This is what is actually in the tenant now, read back out of the
        same tables the rest of the portal uses.
      </Typography>

      <Stack spacing={1.5} sx={{ mb: 3 }}>
        {sections.map((section) => (
          <Paper key={section.key} variant="outlined" sx={{ p: 2 }}>
            <Box
              sx={{
                display: 'flex',
                alignItems: 'baseline',
                justifyContent: 'space-between',
                gap: 1,
                flexWrap: 'wrap',
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body1" fontWeight={700}>
                  {section.title}
                </Typography>
                <Chip size="small" label={`${section.count} ${section.unit}`} variant="outlined" />
              </Box>
              <MuiLink component={RouterLink} to={section.href} variant="body2">
                {section.linkLabel}
              </MuiLink>
            </Box>

            {section.examples.length > 0 && (
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                {section.examples.join(' · ')}
                {section.count > section.examples.length ? ' …' : ''}
              </Typography>
            )}

            {section.note && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                {section.note}
              </Typography>
            )}
          </Paper>
        ))}
      </Stack>

      <Divider sx={{ mb: 2 }} />

      <Typography variant="h6" fontWeight={700} gutterBottom>
        Ready to demonstrate itself?
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        None of these blocks anything. A tenant with none of it still accepts documents, reads them
        and puts them in front of a reviewer — this list is about how much the system will have to
        say when it does.
      </Typography>

      <SetupReadinessList items={buildReadinessItems(snap)} />
    </Box>
  );
}

export default StepReceipt;
