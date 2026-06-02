import { useState, useEffect, useCallback, useMemo, Fragment } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  Chip,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Link,
  Stack,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../lib/api';
import { useTenant } from '../contexts/TenantContext';
import { formatDate } from '../utils/format';
import type { CoaFulfillmentRow, CoaFulfillmentSummary, CoaGapStatus } from '../lib/types';

const GAP_CHIP: Record<CoaGapStatus, { label: string; color: 'success' | 'error' | 'warning' | 'default' }> = {
  ok: { label: 'OK', color: 'success' },
  missing_lot: { label: 'NO LOT', color: 'error' },
  missing_coa: { label: 'NO COA', color: 'error' },
  expired: { label: 'EXPIRED', color: 'warning' },
};

interface OrderGroup {
  orderId: string;
  orderNumber: string;
  poNumber: string | null;
  customerName: string | null;
  rows: CoaFulfillmentRow[];
}

interface CustomerGroup {
  customerName: string;
  orders: OrderGroup[];
}

/**
 * Group flat rows by customer → order, preserving the server's ordering
 * (rows arrive ordered by order created_at DESC, then order id, then item).
 */
function groupRows(rows: CoaFulfillmentRow[]): CustomerGroup[] {
  const customers: CustomerGroup[] = [];
  const custIndex = new Map<string, CustomerGroup>();
  const orderIndex = new Map<string, OrderGroup>();

  for (const row of rows) {
    const custKey = row.customer_name || '— No customer —';
    let cust = custIndex.get(custKey);
    if (!cust) {
      cust = { customerName: custKey, orders: [] };
      custIndex.set(custKey, cust);
      customers.push(cust);
    }

    let order = orderIndex.get(row.order_id);
    if (!order) {
      order = {
        orderId: row.order_id,
        orderNumber: row.order_number,
        poNumber: row.po_number,
        customerName: row.customer_name,
        rows: [],
      };
      orderIndex.set(row.order_id, order);
      cust.orders.push(order);
    }
    order.rows.push(row);
  }

  return customers;
}

function SummaryHeader({ summary }: { summary: CoaFulfillmentSummary }) {
  return (
    <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 3 }}>
      <Chip
        label={`Coverage ${summary.coverage_pct}%`}
        color={summary.coverage_pct >= 90 ? 'success' : summary.coverage_pct >= 60 ? 'warning' : 'error'}
        sx={{ fontWeight: 700 }}
      />
      <Chip label={`${summary.total} lines`} variant="outlined" />
      <Chip label={`OK ${summary.ok}`} color="success" variant="outlined" />
      <Chip label={`No COA ${summary.missing_coa}`} color={summary.missing_coa ? 'error' : 'default'} variant="outlined" />
      <Chip label={`No Lot ${summary.missing_lot}`} color={summary.missing_lot ? 'error' : 'default'} variant="outlined" />
      <Chip label={`Expired ${summary.expired}`} color={summary.expired ? 'warning' : 'default'} variant="outlined" />
    </Stack>
  );
}

function GapChip({ gap }: { gap: CoaGapStatus }) {
  const cfg = GAP_CHIP[gap];
  return <Chip size="small" label={cfg.label} color={cfg.color} variant={gap === 'ok' ? 'outlined' : 'filled'} />;
}

export function Reports() {
  const { selectedTenantId } = useTenant();
  const [rows, setRows] = useState<CoaFulfillmentRow[]>([]);
  const [summary, setSummary] = useState<CoaFulfillmentSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.reports.coaFulfillment({
        tenantId: selectedTenantId || undefined,
        from: from || undefined,
        to: to || undefined,
      });
      setRows(result.rows);
      setSummary(result.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, [selectedTenantId, from, to]);

  useEffect(() => {
    load();
  }, [selectedTenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const groups = useMemo(() => groupRows(rows), [rows]);

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          COA Fulfillment
        </Typography>
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Per shipped order line: is a Certificate of Analysis on file? Gaps are flagged.
      </Typography>

      {/* Date-range filter */}
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 3 }}>
        <TextField
          label="From"
          type="date"
          size="small"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <TextField
          label="To"
          type="date"
          size="small"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          InputLabelProps={{ shrink: true }}
        />
        <Button variant="contained" onClick={load} disabled={loading}>
          Apply
        </Button>
        {(from || to) && (
          <Button
            onClick={() => { setFrom(''); setTo(''); }}
            disabled={loading}
          >
            Clear
          </Button>
        )}
      </Box>

      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {summary && <SummaryHeader summary={summary} />}

          {groups.length === 0 ? (
            <Alert severity="info">No order lines in this range.</Alert>
          ) : (
            <TableContainer component={Paper} variant="outlined">
              {/* Single fixed-layout table so columns align across every order
                  group (was a separate auto-sized table per order → staggered). */}
              <Table size="small" sx={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '26%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '18%' }} />
                  <col style={{ width: '22%' }} />
                  <col style={{ width: '11%' }} />
                  <col style={{ width: '11%' }} />
                </colgroup>
                <TableHead>
                  <TableRow>
                    <TableCell>Product</TableCell>
                    <TableCell>Lot</TableCell>
                    <TableCell>Supplier</TableCell>
                    <TableCell>COA</TableCell>
                    <TableCell>Exp Date</TableCell>
                    <TableCell align="right">Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {groups.map((cust) => (
                    <Fragment key={cust.customerName}>
                      <TableRow>
                        <TableCell colSpan={6} sx={{ bgcolor: 'action.selected', fontWeight: 700 }}>
                          {cust.customerName}
                        </TableCell>
                      </TableRow>
                      {cust.orders.map((order) => (
                        <Fragment key={order.orderId}>
                          <TableRow>
                            <TableCell
                              colSpan={6}
                              sx={{ bgcolor: 'action.hover', color: 'text.secondary', fontWeight: 600 }}
                            >
                              Order {order.orderNumber}
                              {order.poNumber ? ` · PO ${order.poNumber}` : ''}
                            </TableCell>
                          </TableRow>
                          {order.rows.map((row, i) => (
                            <TableRow key={`${order.orderId}-${i}`} hover>
                              <TableCell sx={{ wordBreak: 'break-word' }}>
                                {row.product_name ? (
                                  row.product_id ? (
                                    <Link component={RouterLink} to={`/admin/products/${row.product_id}`} underline="hover">
                                      {row.product_name}
                                    </Link>
                                  ) : (
                                    row.product_name
                                  )
                                ) : (
                                  '-'
                                )}
                              </TableCell>
                              <TableCell sx={{ wordBreak: 'break-word' }}>
                                {row.lot_number ? (
                                  <Link component={RouterLink} to={`/lots?search=${encodeURIComponent(row.lot_number)}`} underline="hover">
                                    {row.lot_number}
                                  </Link>
                                ) : (
                                  <GapChip gap="missing_lot" />
                                )}
                              </TableCell>
                              <TableCell sx={{ wordBreak: 'break-word' }}>
                                {row.supplier_name ? (
                                  row.supplier_id ? (
                                    <Link component={RouterLink} to={`/admin/suppliers/${row.supplier_id}`} underline="hover">
                                      {row.supplier_name}
                                    </Link>
                                  ) : (
                                    row.supplier_name
                                  )
                                ) : (
                                  '-'
                                )}
                              </TableCell>
                              <TableCell sx={{ wordBreak: 'break-word' }}>
                                {row.coa_document_id ? (
                                  <Link href={`/documents/${row.coa_document_id}`} underline="hover">
                                    {row.coa_file_name || 'View COA'}
                                  </Link>
                                ) : row.gap === 'missing_lot' ? (
                                  '-'
                                ) : (
                                  <GapChip gap="missing_coa" />
                                )}
                              </TableCell>
                              <TableCell>
                                {row.expiration_date ? formatDate(row.expiration_date) : '-'}
                              </TableCell>
                              <TableCell align="right">
                                <GapChip gap={row.gap} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </Fragment>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </>
      )}
    </Box>
  );
}
