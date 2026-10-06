import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { api } from '../../lib/api';

/**
 * "New order" -- the order a PERSON builds (migration 0134).
 *
 * On the basic tier nothing feeds orders in, so a person records what the
 * matcher would otherwise be told: who the customer is, the customer's PO /
 * order number, and the day it ships. It is the same order record a connector
 * writes; the lines and their certificates are added on the order's own page.
 *
 * THE CUSTOMER IS PICKED, NOT RETYPED, when they are on file -- that is what
 * gives the order an address to send to. A name that is not on file can still
 * be typed (creating customers is an administrator's job); the order then has
 * no address until one is entered on the send screen.
 */
export interface CustomerOption {
  id: string;
  name: string;
  customer_number: string;
  email: string | null;
}

export interface CreatedOrder {
  id: string;
  order_number: string;
  customer_name: string | null;
}

export interface NewOrderDialogProps {
  open: boolean;
  tenantId?: string;
  onClose: () => void;
  onCreated: (order: CreatedOrder) => void;
  fullScreen?: boolean;
}

export function NewOrderDialog({ open, tenantId, onClose, onCreated, fullScreen = false }: NewOrderDialogProps) {
  const [customer, setCustomer] = useState<CustomerOption | null>(null);
  const [customerText, setCustomerText] = useState('');
  const [options, setOptions] = useState<CustomerOption[]>([]);
  const [searching, setSearching] = useState(false);
  const [orderNumber, setOrderNumber] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [shipDate, setShipDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setCustomer(null);
      setCustomerText('');
      setOrderNumber('');
      setPoNumber('');
      setShipDate('');
      setError('');
    }
  }, [open]);

  // The customer list, narrowed as the person types. The latest request wins.
  const seq = useRef(0);
  useEffect(() => {
    if (!open) return;
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(() => {
      api.customers
        .list({ tenant_id: tenantId, search: customerText.trim() || undefined, active: '1', limit: 25 })
        .then((res) => {
          if (seq.current !== mine) return;
          setOptions(((res as { customers?: CustomerOption[] }).customers ?? []) as CustomerOption[]);
        })
        .catch(() => {
          if (seq.current === mine) setOptions([]);
        })
        .finally(() => {
          if (seq.current === mine) setSearching(false);
        });
    }, 200);
    return () => clearTimeout(t);
  }, [open, customerText, tenantId]);

  const typedName = customer ? '' : customerText.trim();
  const canCreate = orderNumber.trim() !== '' && !busy;

  const create = async () => {
    if (!canCreate) return;
    setBusy(true);
    setError('');
    try {
      const res = (await api.orders.create({
        order_number: orderNumber.trim(),
        po_number: poNumber.trim() || undefined,
        customer_id: customer?.id,
        customer_name: typedName || undefined,
        ship_date: shipDate || undefined,
        tenant_id: tenantId,
      })) as { order: CreatedOrder };
      onCreated(res.order);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the order');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth fullScreen={fullScreen}>
      <DialogTitle>New order</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <Autocomplete<CustomerOption, false, false, true>
            freeSolo
            options={options}
            filterOptions={(x) => x}
            loading={searching}
            value={customer}
            inputValue={customerText}
            onInputChange={(_, v, reason) => {
              setCustomerText(v);
              // Typing over a picked customer un-picks it: the name in the box
              // must never disagree with the customer the order is filed under.
              if (reason === 'input') setCustomer(null);
            }}
            onChange={(_, v) => setCustomer(typeof v === 'string' ? null : v)}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            renderOption={(props, o) => (
              <Box component="li" {...props} key={o.id}>
                <Box>
                  <Typography variant="body2">{o.name}</Typography>
                  <Typography variant="caption" color="text.secondary">
                    {o.customer_number}
                    {o.email ? ` · ${o.email}` : ' · no email on file'}
                  </Typography>
                </Box>
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Customer"
                autoFocus
                helperText={
                  customer
                    ? customer.email
                      ? `Documents will be sent to ${customer.email}.`
                      : 'This customer has no email on file. You can enter one when you send.'
                    : typedName
                      ? 'Not a customer on file. The order keeps this name; you enter the address when you send.'
                      : 'Pick a customer on file, or type a name.'
                }
                inputProps={{ ...params.inputProps, 'data-testid': 'new-order-customer' }}
                InputProps={{
                  ...params.InputProps,
                  endAdornment: (
                    <>
                      {searching ? <CircularProgress size={16} /> : null}
                      {params.InputProps.endAdornment}
                    </>
                  ),
                }}
              />
            )}
          />

          <TextField
            label="Order number"
            required
            fullWidth
            value={orderNumber}
            onChange={(e) => setOrderNumber(e.target.value)}
            disabled={busy}
            helperText="Your own number for this order. It must not already be in use."
            inputProps={{ 'data-testid': 'new-order-number' }}
          />
          <TextField
            label="Customer PO"
            fullWidth
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
            disabled={busy}
            inputProps={{ 'data-testid': 'new-order-po' }}
          />
          <TextField
            label="Ship date"
            type="date"
            fullWidth
            value={shipDate}
            onChange={(e) => setShipDate(e.target.value)}
            disabled={busy}
            InputLabelProps={{ shrink: true }}
            inputProps={{ 'data-testid': 'new-order-ship-date' }}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button variant="contained" onClick={create} disabled={!canCreate} sx={{ textTransform: 'none' }} data-testid="new-order-create">
          {busy ? 'Creating…' : 'Create order'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
