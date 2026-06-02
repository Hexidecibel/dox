import { useState, useEffect } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Box,
  Typography,
  Chip,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Link,
  Stack,
} from '@mui/material';
import { api } from '../lib/api';
import type { LotDetail } from '../lib/types';
import { formatDate } from '../utils/format';

/**
 * Level-3 expansion content for a lot: its COA documents + matched order
 * lines. Lazy-loads `api.lots.get(lotId)` on first mount and caches the
 * result for the component's lifetime (it only mounts when a lot row is
 * expanded, and Collapse keeps it mounted while open). Shared by the
 * SupplierDetail Products tab (Part A) and the global Lots page (Part B)
 * so the "report-as-you-browse" view is identical in both places.
 */
export function LotDetailPanel({ lotId }: { lotId: string }) {
  const [detail, setDetail] = useState<LotDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const result = await api.lots.get(lotId);
        if (!cancelled) setDetail(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load lot detail');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lotId]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
        <CircularProgress size={20} />
      </Box>
    );
  }

  if (error) {
    return (
      <Alert severity="error" sx={{ my: 1 }}>
        {error}
      </Alert>
    );
  }

  if (!detail) return null;

  const matchStatusColor = (status: string | null): 'success' | 'warning' | 'default' | 'error' => {
    switch (status) {
      case 'matched':
        return 'success';
      case 'pending':
      case 'suggested':
        return 'warning';
      case 'unmatched':
        return 'error';
      default:
        return 'default';
    }
  };

  return (
    <Box sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 1 }}>
      {/* COA documents */}
      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
        COA Documents ({detail.coa_documents.length})
      </Typography>
      {detail.coa_documents.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          No COA documents linked to this lot.
        </Typography>
      ) : (
        <Stack spacing={0.5} sx={{ mb: 2 }}>
          {detail.coa_documents.map((doc) => (
            <Box key={doc.document_id} sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
              <Link
                component={RouterLink}
                to={`/documents/${doc.document_id}`}
                variant="body2"
                fontWeight={500}
              >
                {doc.title || doc.file_name || doc.document_id}
              </Link>
              {doc.file_name && doc.title && (
                <Typography variant="caption" color="text.secondary">
                  {doc.file_name}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
                linked {formatDate(doc.linked_at)}
              </Typography>
            </Box>
          ))}
        </Stack>
      )}

      {/* Matched order lines */}
      <Typography variant="subtitle2" fontWeight={600} sx={{ mb: 1 }}>
        Order Lines ({detail.order_lines.length})
      </Typography>
      {detail.order_lines.length === 0 ? (
        <Typography variant="body2" color="text.secondary">
          No order lines associated with this lot.
        </Typography>
      ) : (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Order #</TableCell>
              <TableCell>Customer</TableCell>
              <TableCell align="right">Qty</TableCell>
              <TableCell>COA Match</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {detail.order_lines.map((line) => (
              <TableRow key={line.order_item_id}>
                <TableCell>
                  <Link
                    component={RouterLink}
                    to={`/orders/${line.order_id}`}
                    variant="body2"
                  >
                    {line.order_number || line.po_number || line.order_id}
                  </Link>
                </TableCell>
                <TableCell>
                  <Typography variant="body2">{line.customer_name || '—'}</Typography>
                </TableCell>
                <TableCell align="right">
                  <Typography variant="body2">{line.quantity ?? '—'}</Typography>
                </TableCell>
                <TableCell>
                  <Chip
                    label={line.coa_match_status || 'unmatched'}
                    size="small"
                    color={matchStatusColor(line.coa_match_status)}
                    variant="outlined"
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Box>
  );
}

/**
 * Compact badge row showing a lot's rollup counts (COA / orders /
 * suggested). Shared between the supplier and global lot tables.
 */
export function LotBadges({
  coaCount,
  matchedOrderCount,
  suggestedCount,
}: {
  coaCount: number;
  matchedOrderCount: number;
  suggestedCount: number;
}) {
  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
      <Chip
        label={`${coaCount} COA`}
        size="small"
        color={coaCount > 0 ? 'success' : 'default'}
        variant="outlined"
      />
      <Chip
        label={`${matchedOrderCount} orders`}
        size="small"
        color={matchedOrderCount > 0 ? 'primary' : 'default'}
        variant="outlined"
      />
      {suggestedCount > 0 && (
        <Chip label={`${suggestedCount} suggested`} size="small" color="warning" variant="outlined" />
      )}
    </Stack>
  );
}
