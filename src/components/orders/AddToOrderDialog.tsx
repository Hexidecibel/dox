import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { api } from '../../lib/api';
import { NewOrderDialog } from './NewOrderDialog';
import type { OrderItemsAddResponse } from '../../../shared/types';

/**
 * "Add to order" from a search result (migration 0134).
 *
 * The person has found the certificates; this asks which order they belong on
 * -- an open one, or a new one -- and puts them there. Each document becomes a
 * line per lot it certifies, recorded as that person's pick.
 *
 * WHAT COULD NOT BE ADDED IS SAID. A document that is archived, deleted or has
 * no file is refused by the server with its reason; the rest still land, and
 * the result names both counts.
 */
interface OrderOption {
  id: string;
  order_number: string;
  po_number: string | null;
  customer_name: string | null;
  status: string;
  item_count: number;
}

export interface AddToOrderResult {
  orderId: string;
  orderNumber: string;
  response: OrderItemsAddResponse;
}

export interface AddToOrderDialogProps {
  open: boolean;
  tenantId?: string;
  documentIds: string[];
  onClose: () => void;
  onAdded: (result: AddToOrderResult) => void;
}

/** One sentence for what a pick did, used by every caller. */
export function describePickResult(orderNumber: string, r: OrderItemsAddResponse): string {
  const added = r.results.filter((x) => x.outcome !== 'already_on_order').length;
  const already = r.results.length - added;
  const parts = [`${added} line${added === 1 ? '' : 's'} added to order ${orderNumber}`];
  if (already > 0) parts.push(`${already} already on it`);
  if (r.refused.length > 0) {
    parts.push(
      `${r.refused.length} document${r.refused.length === 1 ? ' was' : 's were'} not added (${r.refused[0].reason})`,
    );
  }
  return `${parts.join('; ')}.`;
}

export function AddToOrderDialog({ open, tenantId, documentIds, onClose, onAdded }: AddToOrderDialogProps) {
  const [orders, setOrders] = useState<OrderOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setSearch('');
      setError('');
      setNewOpen(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api.orders
        .list({ tenant_id: tenantId, search: search.trim() || undefined, limit: 25 })
        .then((res) => {
          if (!alive) return;
          const list = ((res as { orders?: OrderOption[] }).orders ?? []) as OrderOption[];
          // A delivered order has already gone to the customer. It can still be
          // opened and added to from its own page; it is not offered here.
          setOrders(list.filter((o) => o.status !== 'delivered'));
        })
        .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Could not load orders'))
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, search, tenantId]);

  const addTo = async (order: { id: string; order_number: string }) => {
    setBusy(true);
    setError('');
    try {
      const response = await api.orders.addItems(order.id, { document_ids: documentIds });
      onAdded({ orderId: order.id, orderNumber: order.order_number, response });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add to the order');
    } finally {
      setBusy(false);
    }
  };

  const count = documentIds.length;

  return (
    <>
      <Dialog open={open && !newOpen} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
        <DialogTitle>Add {count} document{count === 1 ? '' : 's'} to an order</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            {error && <Alert severity="error">{error}</Alert>}
            <Typography variant="body2" color="text.secondary">
              Each document becomes a line for every lot it certifies. You review the lines, and send, on the order.
            </Typography>
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              onClick={() => setNewOpen(true)}
              disabled={busy}
              sx={{ textTransform: 'none', alignSelf: 'flex-start' }}
              data-testid="add-to-order-new"
            >
              Start a new order
            </Button>
            <TextField
              size="small"
              label="Find an open order"
              placeholder="Order number, customer or PO"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              fullWidth
              inputProps={{ 'data-testid': 'add-to-order-search' }}
            />
            {loading ? (
              <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
                <CircularProgress size={22} />
              </Box>
            ) : orders.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
                No open orders{search.trim() ? ' match that' : ''}. Start a new one above.
              </Typography>
            ) : (
              <List dense disablePadding sx={{ maxHeight: 320, overflowY: 'auto' }}>
                {orders.map((o) => (
                  <ListItemButton key={o.id} onClick={() => addTo(o)} disabled={busy} data-testid="add-to-order-option">
                    <ListItemText
                      primary={`Order ${o.order_number}${o.customer_name ? ` · ${o.customer_name}` : ''}`}
                      secondary={[o.po_number ? `PO ${o.po_number}` : null, `${o.item_count} line${o.item_count === 1 ? '' : 's'}`, o.status]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  </ListItemButton>
                ))}
              </List>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
        </DialogActions>
      </Dialog>

      <NewOrderDialog
        open={open && newOpen}
        tenantId={tenantId}
        onClose={() => setNewOpen(false)}
        onCreated={(order) => {
          setNewOpen(false);
          void addTo(order);
        }}
      />
    </>
  );
}
