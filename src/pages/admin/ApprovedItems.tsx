/**
 * Approved items (migration 0135, decision C-001): one row per item from each
 * supplier that ships it.
 *
 * Two columns sit side by side on purpose and must never be merged: APPROVAL
 * (approved / pending / not approved) and SUPPLIED (currently supplied / no
 * longer supplied). They are separate facts and either can be true without the
 * other. Nothing on this page blocks anything elsewhere in the portal; it is
 * the record of what was decided and by whom.
 *
 * Anyone in the organization can read it. An admin decides an approval and
 * names the facility an item comes from.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Chip,
  CircularProgress,
  FormControl,
  InputAdornment,
  InputLabel,
  Link,
  MenuItem,
  Pagination,
  Paper,
  Select,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { EmptyState } from '../../components/EmptyState';
import { ItemApprovalControl, ItemFacilityControl } from '../../components/ItemApproval';
import { helpContent } from '../../lib/helpContent';
import { ITEM_APPROVAL_LABELS } from '../../../shared/itemApproval';
import type { ApprovedItem, ApprovedItemsResponse, ItemApprovalStatus } from '../../../shared/types';

const PAGE_SIZE = 50;
type ApprovalTab = 'all' | ItemApprovalStatus;
const TABS: ApprovalTab[] = ['all', 'approved', 'pending', 'not_approved'];

export function ApprovedItems() {
  const { user, isSuperAdmin, isAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  const [data, setData] = useState<ApprovedItemsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<ApprovalTab>('all');
  const [supplied, setSupplied] = useState<'any' | 'yes' | 'no'>('any');
  const [supplierId, setSupplierId] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [suppliers, setSuppliers] = useState<Array<{ id: string; name: string }>>([]);

  // Debounce the text box; every other filter applies at once.
  useEffect(() => {
    const timer = setTimeout(() => {
      setQuery(search.trim());
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    let live = true;
    api.suppliers
      .list({ limit: 500, tenant_id: tenantId })
      .then((res) => {
        if (live) setSuppliers(res.suppliers.map((s) => ({ id: s.id, name: s.name })));
      })
      .catch(() => {
        // The filter is a convenience; the list still loads without it.
      });
    return () => {
      live = false;
    };
  }, [tenantId]);

  const load = useCallback(async () => {
    if (isSuperAdmin && !tenantId) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setData(
        await api.approvedItems.list({
          tenant_id: isSuperAdmin ? tenantId : undefined,
          supplier_id: supplierId || undefined,
          approval: tab === 'all' ? undefined : tab,
          supplied: supplied === 'any' ? undefined : supplied === 'yes',
          q: query || undefined,
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load approved items');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, tenantId, supplierId, tab, supplied, query, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = data?.counts ?? { approved: 0, pending: 0, not_approved: 0 };
  const countFor = (t: ApprovalTab) =>
    t === 'all' ? counts.approved + counts.pending + counts.not_approved : counts[t];
  const items = data?.items ?? [];
  const filtered = tab !== 'all' || supplied !== 'any' || !!supplierId || !!query;

  return (
    <Box>
      <Typography variant="h4" sx={{ mb: 2, fontWeight: 600 }}>
        Approved items
      </Typography>
      <HelpWell id="approved-items.list" title={helpContent.approvedItems.headline}>
        {helpContent.approvedItems.well}
      </HelpWell>

      {isSuperAdmin && !tenantId ? (
        <Alert severity="info">Pick an organization to see its approved items.</Alert>
      ) : (
        <>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }}>
            <TextField
              size="small"
              placeholder="Item, SKU, supplier, brand owner, producer or facility"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ flexGrow: 1 }}
              inputProps={{ 'aria-label': 'Search approved items' }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />
            <FormControl size="small" sx={{ minWidth: 220 }}>
              <InputLabel id="approved-items-supplier">Supplier</InputLabel>
              <Select
                labelId="approved-items-supplier"
                label="Supplier"
                value={supplierId}
                onChange={(e) => {
                  setSupplierId(String(e.target.value));
                  setPage(1);
                }}
              >
                <MenuItem value="">All suppliers</MenuItem>
                {suppliers.map((s) => (
                  <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>
                ))}
              </Select>
            </FormControl>
            <FormControl size="small" sx={{ minWidth: 200 }}>
              <InputLabel id="approved-items-supplied">Supplied</InputLabel>
              <Select
                labelId="approved-items-supplied"
                label="Supplied"
                value={supplied}
                onChange={(e) => {
                  setSupplied(e.target.value as 'any' | 'yes' | 'no');
                  setPage(1);
                }}
              >
                <MenuItem value="any">Supplied or not</MenuItem>
                <MenuItem value="yes">Currently supplied</MenuItem>
                <MenuItem value="no">No longer supplied</MenuItem>
              </Select>
            </FormControl>
          </Stack>

          <Tabs
            value={tab}
            onChange={(_, v: ApprovalTab) => {
              setTab(v);
              setPage(1);
            }}
            sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}
          >
            {TABS.map((t) => (
              <Tab
                key={t}
                value={t}
                label={`${t === 'all' ? 'All' : ITEM_APPROVAL_LABELS[t]} (${countFor(t)})`}
                data-testid={`approved-items-tab-${t}`}
              />
            ))}
          </Tabs>

          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

          {loading && !data ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
              <CircularProgress size={28} />
            </Box>
          ) : items.length === 0 ? (
            <EmptyState
              title={filtered ? 'No items match' : 'No items linked to a supplier yet'}
              description={
                filtered
                  ? 'Nothing fits these filters.'
                  : 'An item appears here once a supplier is recorded as shipping it: from a certificate, from the supplier page, or from the verified supplier list.'
              }
            />
          ) : (
            <>
              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Item</TableCell>
                      <TableCell>Our SKU</TableCell>
                      <TableCell>Supplier</TableCell>
                      <TableCell>Facility</TableCell>
                      <TableCell>Approval</TableCell>
                      <TableCell>Supplied</TableCell>
                      <TableCell>Brand owner / producer</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {items.map((item) => (
                      <ApprovedItemRow
                        key={`${item.supplier_id}|${item.product_id}`}
                        item={item}
                        canEdit={isAdmin}
                        onChanged={load}
                      />
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
              {(data?.total ?? 0) > PAGE_SIZE && (
                <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
                  <Pagination
                    count={Math.ceil((data?.total ?? 0) / PAGE_SIZE)}
                    page={page}
                    onChange={(_, p) => setPage(p)}
                  />
                </Box>
              )}
            </>
          )}
        </>
      )}
    </Box>
  );
}

function ApprovedItemRow({
  item,
  canEdit,
  onChanged,
}: {
  item: ApprovedItem;
  canEdit: boolean;
  onChanged: () => void;
}) {
  return (
    <TableRow hover data-testid="approved-item-row">
      <TableCell>
        <Link component={RouterLink} to={`/admin/products/${item.product_id}`} underline="hover">
          {item.product_name}
        </Link>
        {!item.product_active && <Chip size="small" variant="outlined" label="Inactive product" sx={{ ml: 1 }} />}
      </TableCell>
      <TableCell>{item.our_sku || '—'}</TableCell>
      <TableCell>
        <Link component={RouterLink} to={`/admin/suppliers/${item.supplier_id}`} underline="hover">
          {item.supplier_name}
        </Link>
      </TableCell>
      <TableCell>
        <ItemFacilityControl
          supplierId={item.supplier_id}
          productId={item.product_id}
          productName={item.product_name}
          facilityId={item.facility?.id ?? null}
          facilityName={
            item.facility
              ? `${item.facility.name}${item.facility.plant_code ? ` (${item.facility.plant_code})` : ''}`
              : null
          }
          canEdit={canEdit}
          onChanged={onChanged}
        />
      </TableCell>
      <TableCell>
        <Stack spacing={0.5} alignItems="flex-start">
          <ItemApprovalControl
            supplierId={item.supplier_id}
            productId={item.product_id}
            productName={item.product_name}
            status={item.approval_status}
            source={item.approval_source}
            note={item.approval_note}
            canEdit={canEdit}
            onChanged={onChanged}
          />
          {item.approval_note && (
            <Typography variant="caption" color="text.secondary" sx={{ maxWidth: 260 }}>
              {item.approval_note}
            </Typography>
          )}
          {item.approval_source === 'person' && item.approval_decided_by_name && (
            <Typography variant="caption" color="text.secondary">
              {item.approval_decided_by_name}
              {item.approval_decided_at ? `, ${item.approval_decided_at.slice(0, 10)}` : ''}
            </Typography>
          )}
        </Stack>
      </TableCell>
      <TableCell>
        {item.supplied ? (
          <Typography variant="body2">Currently supplied</Typography>
        ) : (
          <Chip size="small" label="No longer supplied" />
        )}
      </TableCell>
      <TableCell>
        <Stack spacing={0.25} alignItems="flex-start">
          <Typography variant="body2">
            {item.brand_owner || '—'} / {item.producer || '—'}
          </Typography>
          {item.private_label && (
            <Tooltip title="The brand owner and the producer are different companies. A label only: it changes nothing else.">
              <Chip size="small" color="info" variant="outlined" label="Private label" data-testid="private-label-chip" />
            </Tooltip>
          )}
        </Stack>
      </TableCell>
    </TableRow>
  );
}
