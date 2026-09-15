/**
 * SupplierClaimPanel — on a Review Queue item that came through a supplier's
 * request link, what the supplier said the file covers.
 *
 * READ-ONLY, deliberately. The queue reviewer is judging whether the
 * extraction matches the file. Whether the file satisfies the request is
 * decided on the request's arrivals screen, after this approval. Showing the
 * claim here gives useful context ("they say this is the kosher certificate")
 * without turning queue approval back into line acceptance. There are no
 * buttons for that reason.
 */

import { useEffect, useState } from 'react';
import { Alert, AlertTitle, Box, Chip, Link, Stack } from '@mui/material';
import { api } from '../lib/api';
import type { RequestArrival } from '../lib/types';
import { claimChip } from './ArrivalCard';

export interface SupplierClaimPanelProps {
  queueId: string;
  tenantId: string;
  /** Passed only for a super_admin, whose list call must name a tenant. */
  asSuperAdmin: boolean;
  onOpenRequest: (requestId: string) => void;
}

export function SupplierClaimPanel({ queueId, tenantId, asSuperAdmin, onOpenRequest }: SupplierClaimPanelProps) {
  const [arrival, setArrival] = useState<RequestArrival | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.requestUploads
      .list({ queue_id: queueId, tenant_id: asSuperAdmin ? tenantId : undefined, limit: 1 })
      .then((res) => {
        if (!cancelled) setArrival(res.arrivals[0] ?? null);
      })
      .catch(() => {
        // Context only. The review works without it.
      });
    return () => {
      cancelled = true;
    };
  }, [queueId, tenantId, asSuperAdmin]);

  if (!arrival) return null;

  return (
    <Alert severity="info" sx={{ mb: 2 }}>
      <AlertTitle>
        {arrival.supplier_name ?? 'The supplier'} sent this for{' '}
        <Link component="button" onClick={() => onOpenRequest(arrival.current_request_id)}>
          {arrival.request_title}
        </Link>
      </AlertTitle>
      {arrival.claims.length === 0 ? (
        'They did not say which requirement it covers.'
      ) : (
        <>
          They said it covers these requirements. Approving here confirms what was read from the
          file. Whether it satisfies each requirement is decided on the request afterwards.
          <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
            {arrival.claims.map((c) => {
              const chip = claimChip(c);
              return (
                <Box key={c.claim_id}>
                  <Chip
                    size="small"
                    variant="outlined"
                    label={`${c.line_name} · ${chip.label}`}
                  />
                </Box>
              );
            })}
          </Stack>
        </>
      )}
    </Alert>
  );
}
