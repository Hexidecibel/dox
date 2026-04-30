import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  Button,
  Grid,
  CircularProgress,
  Alert,
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Paper,
  ToggleButtonGroup,
  ToggleButton,
  Tabs,
  Tab,
  Chip,
  Card,
  CardActionArea,
  CardContent,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Search as SearchIcon,
  Download as DownloadIcon,
  AutoAwesome as AiIcon,
  ShoppingCart as OrdersIcon,
  Description as DocsIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { Document, OrderNaturalSearchResponse } from '../lib/types';
import { DocumentCard } from '../components/DocumentCard';
import { useTenant } from '../contexts/TenantContext';
import { formatDate } from '../utils/format';
import { HelpWell } from '../components/HelpWell';
import { InfoTooltip } from '../components/InfoTooltip';
import { EmptyState } from '../components/EmptyState';
import { helpContent } from '../lib/helpContent';

type SearchTab = 'documents' | 'orders';

const ORDER_STATUSES = ['pending', 'enriched', 'matched', 'fulfilled', 'delivered', 'error'] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

const statusChipProps: Record<OrderStatus, { color: 'default' | 'info' | 'warning' | 'success' | 'primary' | 'error'; variant?: 'filled' | 'outlined' }> = {
  pending: { color: 'default' },
  enriched: { color: 'info' },
  matched: { color: 'warning' },
  fulfilled: { color: 'success' },
  delivered: { color: 'primary' },
  error: { color: 'error' },
};

interface OrderResult {
  id: string;
  tenant_id: string;
  order_number: string;
  po_number: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_number: string | null;
  customer_name_resolved?: string | null;
  status: string;
  item_count: number;
  matched_count: number;
  product_names?: string | null;
  lot_numbers?: string | null;
  connector_name?: string | null;
  created_at: string;
  updated_at: string;
  relevance_score?: number;
}

function formatRelativeDate(dateString: string): string {
  const date = new Date(dateString.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateString) ? dateString : dateString + 'Z');
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return formatDate(dateString);
}

export function Search() {
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const { selectedTenantId } = useTenant();

  // Shared state
  const [activeTab, setActiveTab] = useState<SearchTab>('documents');
  const [query, setQuery] = useState('');
  const [aiSearchActive, setAiSearchActive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Document search state
  const [category, setCategory] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [docResults, setDocResults] = useState<Document[]>([]);
  const [docTotal, setDocTotal] = useState(0);
  const [docSearched, setDocSearched] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'json'>('csv');
  const [exporting, setExporting] = useState(false);

  // Order search state
  const [orderStatusFilter, setOrderStatusFilter] = useState('');
  const [orderResults, setOrderResults] = useState<OrderResult[]>([]);
  const [orderTotal, setOrderTotal] = useState(0);
  const [orderSearched, setOrderSearched] = useState(false);
  const [orderQueryInterpretation, setOrderQueryInterpretation] = useState<OrderNaturalSearchResponse['query_interpretation'] | null>(null);

  // Document search handlers
  const handleDocSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.documents.search(query.trim(), {
        category: category || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      setDocResults(result.documents);
      setDocTotal(result.total);
      setDocSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDocAiSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    try {
      const result = await api.naturalSearch(query.trim(), selectedTenantId || undefined);
      setDocResults((result.results || []).map((d: any) => {
        let primaryMetadata = null;
        if (d.primary_metadata) {
          try { primaryMetadata = typeof d.primary_metadata === 'string' ? JSON.parse(d.primary_metadata) : d.primary_metadata; } catch { /* ignore */ }
        }
        let extendedMetadata = null;
        if (d.extended_metadata) {
          try { extendedMetadata = typeof d.extended_metadata === 'string' ? JSON.parse(d.extended_metadata) : d.extended_metadata; } catch { /* ignore */ }
        }
        return {
          ...d,
          tags: typeof d.tags === 'string' ? (() => { try { return JSON.parse(d.tags); } catch { return []; } })() : (d.tags || []),
          documentTypeId: d.document_type_id ?? null,
          documentTypeName: d.document_type_name,
          documentTypeSlug: d.document_type_slug,
          supplierId: d.supplier_id ?? null,
          supplierName: d.supplier_name,
          primaryMetadata,
          extendedMetadata,
        };
      }));
      setDocTotal(result.total || 0);
      setDocSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI search failed');
    } finally {
      setLoading(false);
    }
  };

  // Order search handlers
  const handleOrderSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    setOrderQueryInterpretation(null);
    try {
      const result = await api.orders.list({
        search: query.trim(),
        status: orderStatusFilter || undefined,
        tenant_id: selectedTenantId || undefined,
      }) as any;
      setOrderResults(result.orders || []);
      setOrderTotal(result.total || 0);
      setOrderSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Order search failed');
    } finally {
      setLoading(false);
    }
  };

  const handleOrderAiSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    setError('');
    setOrderQueryInterpretation(null);
    try {
      const result = await api.orders.naturalSearch(query.trim(), selectedTenantId || undefined) as OrderNaturalSearchResponse;
      setOrderResults(result.results || []);
      setOrderTotal(result.total || 0);
      setOrderQueryInterpretation(result.query_interpretation || null);
      setOrderSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI order search failed');
    } finally {
      setLoading(false);
    }
  };

  // Unified handlers
  const handleSearch = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (activeTab === 'documents') {
      if (aiSearchActive) {
        handleDocAiSearch();
      } else {
        handleDocSearch();
      }
    } else {
      if (aiSearchActive) {
        handleOrderAiSearch();
      } else {
        handleOrderSearch();
      }
    }
  };

  const handleExport = async () => {
    if (docResults.length === 0) return;
    setExporting(true);
    setError('');
    try {
      await api.reports.generate({
        category: category || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        format: exportFormat,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
  };

  const handleTabChange = (_: React.SyntheticEvent, newTab: SearchTab) => {
    setActiveTab(newTab);
    setError('');
    // Keep query but clear results
    if (newTab === 'documents') {
      setOrderSearched(false);
      setOrderResults([]);
      setOrderQueryInterpretation(null);
    } else {
      setDocSearched(false);
      setDocResults([]);
    }
  };

  const getStatusChip = (status: string) => {
    const props = statusChipProps[status as OrderStatus] || { color: 'default' as const };
    return (
      <Chip
        label={status}
        size="small"
        color={props.color}
        variant={props.variant || 'filled'}
        sx={{ textTransform: 'capitalize' }}
      />
    );
  };

  const searched = activeTab === 'documents' ? docSearched : orderSearched;
  const results = activeTab === 'documents' ? docResults : orderResults;
  const total = activeTab === 'documents' ? docTotal : orderTotal;

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Search
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 2 }}>
        {activeTab === 'documents'
          ? 'Search across all documents by title, description, tags, file names, and file content.'
          : 'Search orders by order number, customer, PO number, and more.'}
      </Typography>

      <HelpWell id="search.list" title={helpContent.search.list?.headline ?? 'Search'}>
        {helpContent.search.list?.well ?? helpContent.search.well}
      </HelpWell>

      {/* Tab Bar */}
      <Tabs
        value={activeTab}
        onChange={handleTabChange}
        sx={{ mb: 3, borderBottom: 1, borderColor: 'divider' }}
      >
        <Tab
          value="documents"
          label="Documents"
          icon={<DocsIcon />}
          iconPosition="start"
          sx={{ minHeight: 48 }}
        />
        <Tab
          value="orders"
          label="Orders"
          icon={<OrdersIcon />}
          iconPosition="start"
          sx={{ minHeight: 48 }}
        />
      </Tabs>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }}>
        <Box component="form" onSubmit={handleSearch}>
          <Box sx={{ display: 'flex', gap: 1, mb: 2 }}>
            <TextField
              placeholder={
                aiSearchActive
                  ? activeTab === 'documents'
                    ? 'Search with AI (e.g. "COAs for Butter from March")...'
                    : 'Search orders with AI (e.g. "orders for Acme from last week")...'
                  : activeTab === 'documents'
                    ? 'Search titles, tags, file names, and content...'
                    : 'Search order #, customer, PO...'
              }
              fullWidth
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    {aiSearchActive ? <AiIcon color="primary" /> : <SearchIcon />}
                  </InputAdornment>
                ),
              }}
            />
            <Button
              variant={aiSearchActive ? 'contained' : 'outlined'}
              size="small"
              onClick={() => setAiSearchActive(!aiSearchActive)}
              startIcon={<AiIcon />}
              sx={{ whiteSpace: 'nowrap' }}
            >
              AI
            </Button>
            <InfoTooltip text={helpContent.search.list?.columnTooltips?.aiToggle} />
          </Box>

          {/* Document-specific filters */}
          {activeTab === 'documents' && !aiSearchActive && (
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={12} sm={4}>
                <FormControl fullWidth size="small">
                  <InputLabel>Category</InputLabel>
                  <Select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    label="Category"
                  >
                    <MenuItem value="">All Categories</MenuItem>
                    <MenuItem value="Regulatory">Regulatory</MenuItem>
                    <MenuItem value="Compliance">Compliance</MenuItem>
                    <MenuItem value="Safety">Safety</MenuItem>
                    <MenuItem value="Quality">Quality</MenuItem>
                    <MenuItem value="Technical">Technical</MenuItem>
                    <MenuItem value="Other">Other</MenuItem>
                  </Select>
                </FormControl>
              </Grid>
              <Grid item xs={6} sm={4}>
                <TextField
                  label="Date From"
                  type="date"
                  fullWidth
                  size="small"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={6} sm={4}>
                <TextField
                  label="Date To"
                  type="date"
                  fullWidth
                  size="small"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
            </Grid>
          )}

          {/* Order-specific filters */}
          {activeTab === 'orders' && !aiSearchActive && (
            <Grid container spacing={2} sx={{ mb: 2 }}>
              <Grid item xs={12} sm={4}>
                <FormControl fullWidth size="small">
                  <InputLabel>Status</InputLabel>
                  <Select
                    value={orderStatusFilter}
                    onChange={(e) => setOrderStatusFilter(e.target.value)}
                    label="Status"
                  >
                    <MenuItem value="">All Statuses</MenuItem>
                    {ORDER_STATUSES.map((s) => (
                      <MenuItem key={s} value={s} sx={{ textTransform: 'capitalize' }}>
                        {s}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>
              </Grid>
            </Grid>
          )}

          <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
            <Button
              type="submit"
              variant="contained"
              startIcon={aiSearchActive ? <AiIcon /> : <SearchIcon />}
              disabled={!query.trim() || loading}
              fullWidth={isMobile}
            >
              {loading ? 'Searching...' : aiSearchActive ? 'AI Search' : 'Search'}
            </Button>
            {activeTab === 'documents' && docResults.length > 0 && !aiSearchActive && (
              <>
                <ToggleButtonGroup
                  size="small"
                  value={exportFormat}
                  exclusive
                  onChange={(_, v) => { if (v) setExportFormat(v); }}
                >
                  <ToggleButton value="csv">CSV</ToggleButton>
                  <ToggleButton value="json">JSON</ToggleButton>
                </ToggleButtonGroup>
                <Button
                  variant="outlined"
                  startIcon={<DownloadIcon />}
                  onClick={handleExport}
                  disabled={exporting}
                >
                  {exporting ? 'Exporting...' : `Export ${exportFormat.toUpperCase()}`}
                </Button>
              </>
            )}
          </Box>
        </Box>
      </Paper>

      {/* Order AI query interpretation */}
      {activeTab === 'orders' && orderQueryInterpretation && (
        <Box sx={{ mb: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 1 }}>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            <Typography component="span" variant="body2" fontWeight={600}>
              {orderQueryInterpretation.explanation || 'Search interpretation'}
            </Typography>
          </Typography>
          {Object.entries(orderQueryInterpretation.parsed).length > 0 && (
            <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
              {Object.entries(orderQueryInterpretation.parsed).map(([key, value]) => (
                value ? (
                  <Chip
                    key={key}
                    label={`${key}: ${String(value)}`}
                    size="small"
                    onDelete={() => setOrderQueryInterpretation(null)}
                  />
                ) : null
              ))}
            </Box>
          )}
        </Box>
      )}

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : searched ? (
        <>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            {total} result{total !== 1 ? 's' : ''} found
          </Typography>
          {results.length === 0 ? (
            <EmptyState
              title={`No ${activeTab === 'documents' ? 'documents' : 'orders'} match your search`}
              description={
                aiSearchActive
                  ? 'AI mode parses your wording into structured filters; if nothing matched, try simplifying the query or switching to keyword mode.'
                  : 'Try different keywords or adjust the filters above. Toggle AI search if you have a natural-language query in mind.'
              }
            />
          ) : activeTab === 'documents' ? (
            <Grid container spacing={2}>
              {docResults.map((doc) => (
                <Grid item xs={12} sm={6} md={4} key={doc.id}>
                  <DocumentCard document={doc} />
                </Grid>
              ))}
            </Grid>
          ) : (
            /* Order results */
            <Grid container spacing={2}>
              {orderResults.map((order) => (
                <Grid item xs={12} sm={6} md={4} key={order.id}>
                  <Card variant="outlined" sx={{ height: '100%' }}>
                    <CardActionArea
                      onClick={() => navigate(`/orders/${order.id}`)}
                      sx={{ height: '100%' }}
                    >
                      <CardContent>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                          <Typography variant="subtitle1" fontWeight={700}>
                            {order.order_number}
                          </Typography>
                          {getStatusChip(order.status)}
                        </Box>

                        <Typography variant="body2" color="text.secondary" gutterBottom>
                          {order.customer_name_resolved || order.customer_name || order.customer_number || 'No customer'}
                          {order.customer_number && order.customer_name ? ` (${order.customer_number})` : ''}
                        </Typography>

                        {order.po_number && (
                          <Typography variant="body2" color="text.secondary">
                            PO: {order.po_number}
                          </Typography>
                        )}

                        <Box sx={{ mt: 1, mb: 0.5 }}>
                          <Typography variant="body2" color="text.secondary">
                            {order.matched_count}/{order.item_count} items matched
                          </Typography>
                        </Box>

                        {order.product_names && (
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{
                              display: 'block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              maxWidth: '100%',
                            }}
                          >
                            {order.product_names}
                          </Typography>
                        )}

                        {order.relevance_score != null && (
                          <Chip
                            label={`${Math.round(order.relevance_score * 100)}% match`}
                            size="small"
                            color="info"
                            variant="outlined"
                            sx={{ mt: 1, mr: 0.5 }}
                          />
                        )}

                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                          {formatRelativeDate(order.created_at)}
                        </Typography>
                      </CardContent>
                    </CardActionArea>
                  </Card>
                </Grid>
              ))}
            </Grid>
          )}
        </>
      ) : (
        <EmptyState
          icon={<SearchIcon sx={{ fontSize: 32 }} />}
          title={`Search across ${activeTab === 'documents' ? 'documents' : 'orders'}`}
          description={
            activeTab === 'documents'
              ? 'Type a query above to search titles, tags, file names, and indexed file content. Toggle AI for natural-language search.'
              : 'Type a query above to search by order number, customer, or PO. Toggle AI for natural-language search.'
          }
        />
      )}
    </Box>
  );
}
