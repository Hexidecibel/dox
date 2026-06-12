import { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Box,
  Typography,
  TextField,
  CircularProgress,
  Alert,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  IconButton,
  Collapse,
  InputAdornment,
  Pagination,
} from '@mui/material';
import {
  Search as SearchIcon,
  KeyboardArrowDown as ExpandMoreIcon,
  KeyboardArrowRight as ExpandRightIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import { useTenant } from '../contexts/TenantContext';
import { EmptyState } from '../components/EmptyState';
import { LotDetailPanel, LotBadges } from '../components/LotDetailPanel';
import { formatDate } from '../utils/format';
import type { LotListItem } from '../lib/types';

const ITEMS_PER_PAGE = 50;

/** A single expandable lot row for the global Lots table (Part B). */
function LotRow({ lot }: { lot: LotListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <TableCell sx={{ width: 48 }}>
          <IconButton size="small">
            {open ? <ExpandMoreIcon fontSize="small" /> : <ExpandRightIcon fontSize="small" />}
          </IconButton>
        </TableCell>
        <TableCell>
          <Typography variant="body2" fontWeight={500}>{lot.lot_number}</Typography>
        </TableCell>
        <TableCell>
          <Typography variant="body2" color="text.secondary">{lot.sub_lot_code || '—'}</Typography>
        </TableCell>
        <TableCell>
          <Typography variant="body2" color="text.secondary">{lot.product_name || '—'}</Typography>
        </TableCell>
        <TableCell>
          <Typography variant="body2" color="text.secondary">{lot.supplier_name || '—'}</Typography>
        </TableCell>
        <TableCell>
          <Typography variant="body2" color="text.secondary">
            {lot.code_date ? formatDate(lot.code_date) : '—'}
            {lot.expiration_date ? ` / exp ${formatDate(lot.expiration_date)}` : ''}
          </Typography>
        </TableCell>
        <TableCell>
          <LotBadges
            coaCount={lot.coa_document_count}
            matchedOrderCount={lot.matched_order_count}
            suggestedCount={lot.suggested_count}
          />
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell sx={{ py: 0, borderBottom: open ? undefined : 'none' }} colSpan={7}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ py: 1 }}>
              <LotDetailPanel lotId={lot.id} />
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </>
  );
}

export function Lots() {
  const { selectedTenantId } = useTenant();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const search = searchParams.get('search') || '';
  const [searchInput, setSearchInput] = useState(search);

  const [lots, setLots] = useState<LotListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Debounce search input -> URL param (resets to page 1).
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput === search) return;
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        if (searchInput) next.set('search', searchInput);
        else next.delete('search');
        next.delete('page');
        return next;
      });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const loadLots = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.lots.list({
        search: search || undefined,
        limit: ITEMS_PER_PAGE,
        offset: (page - 1) * ITEMS_PER_PAGE,
        tenant_id: selectedTenantId || undefined,
      });
      setLots(result.lots);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load lots');
      setLots([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [search, page, selectedTenantId]);

  useEffect(() => {
    loadLots();
  }, [loadLots]);

  const pageCount = Math.ceil(total / ITEMS_PER_PAGE);

  const handlePageChange = (_: unknown, value: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (value > 1) next.set('page', String(value));
      else next.delete('page');
      return next;
    });
  };

  return (
    <Box>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h4" fontWeight={700} gutterBottom>
          Lots
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Every production lot seen across suppliers, most recent first. Expand a lot to see its
          COA documents and the order lines it fulfills.
        </Typography>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <TextField
        placeholder="Search by lot or sublot key…"
        size="small"
        value={searchInput}
        onChange={(e) => setSearchInput(e.target.value)}
        sx={{ mb: 2, width: { xs: '100%', sm: 360 } }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" />
            </InputAdornment>
          ),
        }}
      />

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : lots.length === 0 ? (
        <EmptyState
          title={search ? 'No lots match your search' : 'No lots yet'}
          description={
            search
              ? 'Try a different lot number, or clear the search to see all lots.'
              : "Lots appear here once the pipeline records production lots from COAs and orders. Once documents and orders flow through, you'll see each lot's COA coverage and order matches here."
          }
        />
      ) : (
        <>
          <TableContainer component={Paper} variant="outlined">
            <Table>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ width: 48 }} />
                  <TableCell>Lot #</TableCell>
                  <TableCell>Sublot</TableCell>
                  <TableCell>Product</TableCell>
                  <TableCell>Supplier</TableCell>
                  <TableCell>Code / Exp Date</TableCell>
                  <TableCell>Activity</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {lots.map((lot) => (
                  <LotRow key={lot.id} lot={lot} />
                ))}
              </TableBody>
            </Table>
          </TableContainer>

          {pageCount > 1 && (
            <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
              <Pagination
                count={pageCount}
                page={page}
                onChange={handlePageChange}
                color="primary"
              />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
