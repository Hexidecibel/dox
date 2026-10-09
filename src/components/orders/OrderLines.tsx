import { holdRefusalText } from '../../../shared/holds';
import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Description as DocIcon,
  DeleteOutline as DeleteIcon,
  LinkOff as UnlinkIcon,
  WarningAmber as WarningIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { humanBytes, lotRowLabel } from '../../../shared/orderSend';
import { LotMatchSuggestionList, type LotMatchSuggestionLike } from '../LotMatchSuggestionList';
import type { ApiOrderItem } from '../../../shared/types';

/**
 * An order's lines, as a person checks them before anything is sent
 * (migration 0134): product, lot and production date beside the certificate on
 * the line, so a wrong pick is visible before it goes.
 *
 * THE PRODUCTION DATE IS SHOWN WITH ITS DOUBT. Only a date the certificate
 * states, and that reads one way, is printed plainly. A date decoded from the
 * lot code, read from an older extraction, ambiguous, or in conflict between
 * certificates is marked and says why -- the wording is resolved on the server
 * (shared/orderSend.ts) so this screen and the review dialog cannot differ.
 *
 * A line whose certificate is one lot's page of a larger certificate says
 * whether the WHOLE certificate is on file, because that is what the customer
 * will be sent.
 */
export interface OrderLineSuggestion extends LotMatchSuggestionLike {
  order_item_id: string;
}

export interface OrderLinesProps {
  orderId: string;
  items: ApiOrderItem[];
  suggestions: OrderLineSuggestion[];
  /** False for a read-only account, and for an order still in staged review. */
  canEdit: boolean;
  compact: boolean;
  onChanged: () => void;
  onOpenDocument: (documentId: string) => void;
}

export function lineLot(item: ApiOrderItem): string | null {
  return lotRowLabel(item.lot_row_number, item.sub_lot_code) ?? item.lot_number ?? null;
}

function ProductionDate({ item }: { item: ApiOrderItem }) {
  const state = item.production_date_state ?? 'none';
  if (state === 'none' || !item.production_date_label) {
    return (
      <Typography variant="body2" color="text.secondary" data-testid="line-production-date" data-state={state}>
        {item.lot_id ? 'Not on file' : '-'}
      </Typography>
    );
  }
  if (state === 'stated') {
    return (
      <Typography variant="body2" data-testid="line-production-date" data-state={state}>
        {item.production_date_label}
      </Typography>
    );
  }
  return (
    <Tooltip title={item.production_date_note ?? ''}>
      <Stack direction="row" spacing={0.5} alignItems="center" data-testid="line-production-date" data-state={state} sx={{ color: 'warning.dark' }}>
        <WarningIcon sx={{ fontSize: 16 }} />
        <Typography variant="body2" sx={{ fontStyle: 'italic' }}>
          {item.production_date_label}
        </Typography>
      </Stack>
    </Tooltip>
  );
}

function OriginalChip({ item }: { item: ApiOrderItem }) {
  if (item.coa_original === 'on_file') {
    return (
      <Tooltip title="This document is one lot's page of a larger certificate. The whole certificate is on file and is what the customer is sent.">
        <Chip size="small" variant="outlined" label="Whole certificate on file" />
      </Tooltip>
    );
  }
  if (item.coa_original === 'missing') {
    return (
      <Tooltip title="This document is one lot's page of a larger certificate, and the whole certificate is not on file. The per-lot page is what the customer will be sent.">
        <Chip size="small" variant="outlined" color="warning" label="Per-lot page only" />
      </Tooltip>
    );
  }
  return null;
}

export function OrderLines({ orderId, items, suggestions, canEdit, compact, onChanged, onOpenDocument }: OrderLinesProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const suggestionsFor = (itemId: string) => suggestions.filter((s) => s.order_item_id === itemId);

  const act = async (itemId: string, run: () => Promise<unknown>) => {
    setBusy(itemId);
    setError('');
    try {
      await run();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save that');
    } finally {
      setBusy(null);
    }
  };

  const certificate = (item: ApiOrderItem) => {
    if (item.coa_document_id) {
      const gone = item.coa_document_status && item.coa_document_status !== 'active';
      return (
        <Box>
          <Button
            size="small"
            startIcon={<DocIcon />}
            onClick={() => onOpenDocument(item.coa_document_id as string)}
            sx={{ textTransform: 'none', textAlign: 'left' }}
          >
            {item.coa_document_title || 'View document'}
          </Button>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap', pl: 0.5 }}>
            {gone && <Chip size="small" color="error" variant="outlined" label={`Document ${item.coa_document_status}: will not be sent`} />}
            {item.coa_hold && (
              <Chip
                size="small"
                color="error"
                label="On hold: will not be sent"
                title={`${holdRefusalText(item.coa_hold)}. QA or an administrator releases a hold.`}
                data-testid="order-line-hold"
              />
            )}
            <OriginalChip item={item} />
            {item.coa_file_size ? (
              <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                {humanBytes(Number(item.coa_file_size))}
              </Typography>
            ) : null}
          </Stack>
        </Box>
      );
    }
    const offered = suggestionsFor(item.id);
    if (offered.length > 0) {
      return (
        <LotMatchSuggestionList
          suggestions={offered}
          canResolve={canEdit}
          onResolved={onChanged}
          onOpenDocument={onOpenDocument}
        />
      );
    }
    return (
      <Typography variant="body2" color="text.secondary">
        No certificate yet
      </Typography>
    );
  };

  const pickedBy = (item: ApiOrderItem) => {
    if (!item.coa_document_id) return '-';
    if (item.picked_by) return item.picked_by_name ?? 'A former user';
    return 'Accepted match';
  };

  const actions = (item: ApiOrderItem) =>
    canEdit ? (
      <Stack direction="row" spacing={0} justifyContent="flex-end">
        {item.coa_document_id && (
          <Tooltip title="Take the certificate off this line">
            <span>
              <IconButton
                size="small"
                disabled={busy === item.id}
                onClick={() => act(item.id, () => api.orders.updateItem(orderId, item.id, { coa_document_id: null }))}
                data-testid="line-remove-certificate"
                aria-label="Take the certificate off this line"
              >
                <UnlinkIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}
        <Tooltip title="Remove this line">
          <span>
            <IconButton
              size="small"
              disabled={busy === item.id}
              onClick={() => act(item.id, () => api.orders.removeItem(orderId, item.id))}
              data-testid="line-remove"
              aria-label="Remove this line"
            >
              <DeleteIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
    ) : null;

  return (
    <Box sx={{ mb: 3 }} data-testid="order-lines">
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {compact ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {items.map((item) => (
            <Card key={item.id} variant="outlined" data-testid="order-line">
              <CardContent sx={{ pb: '12px !important' }}>
                <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
                  <Box>
                    <Typography variant="subtitle2" fontWeight={600}>
                      {item.product_name || item.product_name_resolved || item.product_code || 'No product named'}
                    </Typography>
                    {item.product_code && (item.product_name || item.product_name_resolved) && (
                      <Typography variant="caption" color="text.secondary">
                        {item.product_code}
                      </Typography>
                    )}
                  </Box>
                  {actions(item)}
                </Stack>
                <Stack direction="row" spacing={2} sx={{ mt: 1, flexWrap: 'wrap' }} useFlexGap>
                  {item.quantity != null && <Typography variant="body2">Qty: {item.quantity}</Typography>}
                  <Typography variant="body2">Lot: {lineLot(item) ?? '-'}</Typography>
                </Stack>
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.5 }}>
                  <Typography variant="body2" color="text.secondary">
                    Produced:
                  </Typography>
                  <ProductionDate item={item} />
                </Stack>
                <Box sx={{ mt: 1 }}>{certificate(item)}</Box>
                {item.coa_document_id && (
                  <Typography variant="caption" color="text.secondary">
                    Picked by: {pickedBy(item)}
                  </Typography>
                )}
              </CardContent>
            </Card>
          ))}
        </Box>
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                <TableCell align="right">Qty</TableCell>
                <TableCell>Lot</TableCell>
                <TableCell>Production date</TableCell>
                <TableCell>Certificate</TableCell>
                <TableCell>Picked by</TableCell>
                {canEdit && <TableCell align="right" />}
              </TableRow>
            </TableHead>
            <TableBody>
              {items.map((item) => (
                <TableRow key={item.id} data-testid="order-line">
                  <TableCell>
                    <Typography variant="body2">{item.product_name || item.product_name_resolved || '-'}</Typography>
                    {item.product_code && (
                      <Typography variant="caption" color="text.secondary">
                        {item.product_code}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell align="right">{item.quantity != null ? item.quantity : '-'}</TableCell>
                  <TableCell>
                    <Typography variant="body2" sx={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: '0.8rem' }}>
                      {lineLot(item) ?? '-'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <ProductionDate item={item} />
                  </TableCell>
                  <TableCell>{certificate(item)}</TableCell>
                  <TableCell>
                    <Typography variant="body2" color="text.secondary">
                      {pickedBy(item)}
                    </Typography>
                  </TableCell>
                  {canEdit && <TableCell align="right">{actions(item)}</TableCell>}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Box>
  );
}
