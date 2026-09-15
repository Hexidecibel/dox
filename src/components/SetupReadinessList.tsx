/**
 * SetupReadinessList — "is this tenant ready to demonstrate itself?", as a
 * checklist that names the missing thing rather than scoring it.
 *
 * Shared between the wizard's screen 5 (the receipt: here is what exists now)
 * and screen 6 (the live document drop), which is why the snapshot loader, the
 * item builder and the renderer are all exported separately. The two screens
 * must agree about what "ready" means; the only way to guarantee that is for
 * them to run the same function, not to render the same colours.
 *
 * TWO STATES, NOT THREE. A row is green with a count, or amber with the exact
 * missing thing and a link to the page that fixes it. There is no red: nothing
 * in this list BLOCKS anything. A tenant with no spec limits still ingests, still
 * extracts, still runs the printed-spec check — the zero-configuration behaviour
 * is genuinely good, and colouring its absence as an error would be a lie told
 * to make a wizard feel important.
 *
 * EVERY COUNT IS READ BACK OUT OF THE TENANT'S OWN TABLES, through the same
 * endpoints the admin pages use. Nothing here reads the wizard's `applied`
 * ledger: the whole point of a receipt is that it describes the tenant, so if
 * the ledger and the tables ever disagree the tables must win visibly.
 */

import { Alert, Box, Chip, Link as MuiLink, Paper, Stack, Typography } from '@mui/material';
import {
  CheckCircle as ReadyIcon,
  ErrorOutline as MissingIcon,
} from '@mui/icons-material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../lib/api';

/** One line of the checklist. */
export interface ReadinessItem {
  key: string;
  /** The thing being checked, as a noun phrase: "Document types". */
  label: string;
  ready: boolean;
  count: number;
  /** Up to three real names from the tenant, for the green line. */
  examples: string[];
  /** Exactly what is absent, when it is. Written as a sentence, not a status. */
  missing?: string;
  /** The admin page that owns this row. */
  href: string;
  /** A standing sentence shown whatever the state. Used where the count misleads. */
  note?: string;
}

/**
 * Everything the checklist needs, read once.
 *
 * Deliberately a plain data structure with no React in it, so screen 5 and
 * screen 6 can each decide when to load and neither has to own the other's
 * lifecycle.
 */
export interface SetupReadinessSnapshot {
  documentTypes: { count: number; examples: string[] };
  requirements: { count: number; examples: string[] };
  claimTypes: { count: number; examples: string[] };
  specTests: { count: number; examples: string[] };
  specLimits: { count: number };
  suppliers: { count: number; examples: string[] };
  /** Owner labels that documents (or the pack) use, and how many have a recipient. */
  ownerRouting: { labels: number; routed: number; gaps: string[] };
  /** Supplier checklists actually attached, and to how many distinct suppliers. */
  supplierRequirements: { rows: number; suppliers: number };
  documents: { count: number };
}

const three = (names: Array<string | null | undefined>): string[] =>
  names.filter((n): n is string => typeof n === 'string' && n.length > 0).slice(0, 3);

/**
 * Load the snapshot from the live tenant.
 *
 * Every read is best-effort and independent: one endpoint being unhappy must
 * not blank the whole receipt, so a failed read reports zero for its own row
 * and leaves the others alone. A zero on this screen already means "nothing
 * configured", which is the same thing a reader should do about it.
 */
export async function loadReadinessSnapshot(
  tenantId?: string,
): Promise<SetupReadinessSnapshot> {
  const empty: SetupReadinessSnapshot = {
    documentTypes: { count: 0, examples: [] },
    requirements: { count: 0, examples: [] },
    claimTypes: { count: 0, examples: [] },
    specTests: { count: 0, examples: [] },
    specLimits: { count: 0 },
    suppliers: { count: 0, examples: [] },
    ownerRouting: { labels: 0, routed: 0, gaps: [] },
    supplierRequirements: { rows: 0, suppliers: 0 },
    documents: { count: 0 },
  };

  const settled = await Promise.allSettled([
    api.documentTypes.list({ tenant_id: tenantId, active: 1 }),
    api.requirements.list({ tenant_id: tenantId, active: 1, limit: 500 }),
    api.claimTypes.list({ tenant_id: tenantId, active: 1, limit: 500 }),
    api.specTests.list({ tenant_id: tenantId }),
    api.specLimits.list({ tenant_id: tenantId }),
    api.suppliers.list({ tenant_id: tenantId, limit: 100 }),
    api.ownerRoutes.list({ tenantId }),
    api.supplierRequirements.listAll({ tenant_id: tenantId }),
    api.documents.list({ limit: 1, tenantId }),
  ]);

  const [types, reqs, claims, tests, limits, suppliers, routing, supplierReqs, docs] = settled;

  if (types.status === 'fulfilled') {
    empty.documentTypes = {
      count: types.value.documentTypes.length,
      examples: three(types.value.documentTypes.map((t) => t.name)),
    };
  }
  if (reqs.status === 'fulfilled') {
    empty.requirements = {
      count: reqs.value.total,
      examples: three(reqs.value.requirements.map((r) => r.name)),
    };
  }
  if (claims.status === 'fulfilled') {
    empty.claimTypes = {
      count: claims.value.total,
      examples: three(claims.value.claimTypes.map((c) => c.name)),
    };
  }
  if (tests.status === 'fulfilled') {
    empty.specTests = {
      count: tests.value.specTests.length,
      examples: three(tests.value.specTests.map((t) => t.name)),
    };
  }
  if (limits.status === 'fulfilled') {
    empty.specLimits = { count: limits.value.specLimits.length };
  }
  if (suppliers.status === 'fulfilled') {
    empty.suppliers = {
      count: suppliers.value.total,
      examples: three(suppliers.value.suppliers.map((s) => s.name)),
    };
  }
  if (routing.status === 'fulfilled') {
    const routed = new Set(
      routing.value.routes.filter((r) => r.active).map((r) => r.owner_key),
    );
    const labels = routing.value.labels_in_use ?? [];
    // Labels that are on documents but reach nobody. Labels that only exist as
    // routes are not gaps — they are configured and idle.
    const gaps = labels.filter((l) => !routed.has(l.owner_key)).map((l) => l.owner_label);
    const known = new Set([...routed, ...labels.map((l) => l.owner_key)]);
    empty.ownerRouting = { labels: known.size, routed: routed.size, gaps };
  }
  if (supplierReqs.status === 'fulfilled') {
    empty.supplierRequirements = {
      rows: supplierReqs.value.length,
      suppliers: new Set(supplierReqs.value.map((r) => r.supplier_id)).size,
    };
  }
  if (docs.status === 'fulfilled') {
    empty.documents = { count: docs.value.total };
  }

  return empty;
}

/**
 * Turn the snapshot into checklist rows.
 *
 * The order is the order the wizard configures things, so a person reading the
 * receipt top to bottom is re-walking the screens they just came through.
 */
export function buildReadinessItems(snap: SetupReadinessSnapshot): ReadinessItem[] {
  return [
    {
      key: 'document_types',
      label: 'Document types',
      ready: snap.documentTypes.count > 0,
      count: snap.documentTypes.count,
      examples: snap.documentTypes.examples,
      missing: 'No document types yet — nothing an arriving file can be classified as.',
      href: '/settings/document-types',
    },
    {
      key: 'requirements',
      label: 'Requirements',
      ready: snap.requirements.count > 0,
      count: snap.requirements.count,
      examples: snap.requirements.examples,
      missing: 'No requirements yet — an approved document has nothing it can close.',
      href: '/settings/requirements',
    },
    {
      key: 'claim_types',
      label: 'Claims',
      ready: snap.claimTypes.count > 0,
      count: snap.claimTypes.count,
      examples: snap.claimTypes.examples,
      missing: 'No claims yet — nothing to say what a document TRIGGERS.',
      href: '/settings/claim-types',
    },
    {
      key: 'spec_tests',
      label: 'Lab tests and limits',
      ready: snap.specTests.count > 0,
      count: snap.specTests.count,
      examples: snap.specTests.examples,
      missing:
        'No analytes configured. Certificates are still checked against the limits they print themselves; only OUR own tighter limits are missing.',
      href: '/settings/spec-limits',
      note:
        snap.specTests.count > 0 && snap.specLimits.count === 0
          ? 'Analytes are named but none carries an acceptance limit yet, so every result reads as not checked against your own thresholds.'
          : undefined,
    },
    {
      key: 'owner_routes',
      label: 'Renewal recipients',
      ready: snap.ownerRouting.gaps.length === 0 && snap.ownerRouting.routed > 0,
      count: snap.ownerRouting.routed,
      examples: [],
      missing:
        snap.ownerRouting.routed === 0
          ? 'Nobody is behind any owner label. Renewal alerts do not fall back to the admin pool, so every expiring record would be reported as unowned and no email would be sent.'
          : `${snap.ownerRouting.gaps.length} label${
              snap.ownerRouting.gaps.length === 1 ? '' : 's'
            } reach nobody: ${snap.ownerRouting.gaps.slice(0, 4).join(', ')}. Records they own are reported as a routing gap rather than emailed.`,
      href: '/settings/owner-routes',
    },
    {
      key: 'suppliers',
      label: 'Suppliers',
      ready: snap.suppliers.count > 0,
      count: snap.suppliers.count,
      examples: snap.suppliers.examples,
      missing:
        'No suppliers yet. They arrive on their own as documents are processed — this is not something to fill in up front.',
      href: '/admin/suppliers',
    },
    {
      key: 'supplier_requirements',
      label: 'Supplier packets',
      // Never "ready", and never a gap either: zero is the CORRECT state for a
      // tenant with no suppliers, so this row states the number and the rule and
      // leaves the judgement out of it.
      ready: snap.supplierRequirements.suppliers > 0,
      count: snap.supplierRequirements.suppliers,
      examples: [],
      // Reads "Applied to 0 suppliers." on a fresh tenant, which is the state
      // this row exists to state plainly rather than flag as a failure.
      missing: `Applied to ${snap.supplierRequirements.suppliers} suppliers.`,
      href: '/settings/supplier-requirements',
      note:
        'A packet is a starting point for a supplier, not a rule for all of them. You will apply one to each supplier as they arrive.',
    },
  ];
}

export interface SetupReadinessListProps {
  items: ReadinessItem[];
  /** Tighter spacing, for a step that has other things on it. */
  dense?: boolean;
}

export function SetupReadinessList({ items, dense = false }: SetupReadinessListProps) {
  const gaps = items.filter((i) => !i.ready).length;

  return (
    <Box>
      {gaps === 0 ? (
        <Alert severity="success" sx={{ mb: 2 }}>
          Everything on this list has something behind it.
        </Alert>
      ) : (
        <Alert severity="info" sx={{ mb: 2 }}>
          {gaps} item{gaps === 1 ? '' : 's'} below {gaps === 1 ? 'has' : 'have'} nothing behind{' '}
          {gaps === 1 ? 'it' : 'them'} yet. None of them blocks anything — documents still arrive,
          get read and get reviewed. Each one just means a part of the system has nothing to say.
        </Alert>
      )}

      <Stack spacing={dense ? 0.75 : 1}>
        {items.map((item) => (
          <Paper
            key={item.key}
            variant="outlined"
            sx={{
              p: dense ? 1.25 : 1.75,
              display: 'flex',
              gap: 1.5,
              alignItems: 'flex-start',
              borderColor: item.ready ? undefined : 'warning.main',
            }}
          >
            {item.ready ? (
              <ReadyIcon fontSize="small" color="success" sx={{ mt: 0.25 }} />
            ) : (
              <MissingIcon fontSize="small" color="warning" sx={{ mt: 0.25 }} />
            )}

            <Box sx={{ flexGrow: 1, minWidth: 0 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="body2" fontWeight={700}>
                  {item.label}
                </Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  color={item.ready ? 'success' : 'warning'}
                  label={item.count}
                />
              </Box>

              {item.ready && item.examples.length > 0 && (
                <Typography variant="caption" color="text.secondary" display="block">
                  {item.examples.join(' · ')}
                  {item.count > item.examples.length ? ' …' : ''}
                </Typography>
              )}

              {!item.ready && item.missing && (
                <Typography variant="caption" color="warning.main" display="block">
                  {item.missing}
                </Typography>
              )}

              {item.note && (
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                  {item.note}
                </Typography>
              )}
            </Box>

            <MuiLink component={RouterLink} to={item.href} variant="caption" sx={{ flexShrink: 0 }}>
              Open
            </MuiLink>
          </Paper>
        ))}
      </Stack>
    </Box>
  );
}

export default SetupReadinessList;
