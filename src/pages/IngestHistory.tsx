import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatDateTime } from '../utils/format';
import {
  Box,
  Typography,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TablePagination,
  Chip,
  CircularProgress,
  Alert,
  IconButton,
  Collapse,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Grid,
  LinearProgress,
} from '@mui/material';
import {
  KeyboardArrowDown as ExpandIcon,
  KeyboardArrowUp as CollapseIcon,
  CheckCircle,
  Error as ErrorIcon,
  HourglassEmpty,
  Sync,
  AutoAwesome,
  OpenInNew,
  History as HistoryIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ProcessingQueueItem } from '../../shared/types';

function processingChip(status: ProcessingQueueItem['processing_status']) {
  switch (status) {
    case 'queued':
      return <Chip icon={<HourglassEmpty />} label="Queued" size="small" color="default" variant="outlined" />;
    case 'processing':
      return <Chip icon={<Sync />} label="Processing" size="small" color="info" variant="outlined" />;
    case 'ready':
      return <Chip icon={<CheckCircle />} label="Ready" size="small" color="success" variant="outlined" />;
    case 'error':
      return <Chip icon={<ErrorIcon />} label="Error" size="small" color="error" variant="outlined" />;
    default:
      return <Chip label={status} size="small" variant="outlined" />;
  }
}

function reviewChip(status: ProcessingQueueItem['status']) {
  switch (status) {
    case 'pending':
      return <Chip label="Pending" size="small" color="warning" variant="outlined" />;
    case 'approved':
      return <Chip icon={<CheckCircle />} label="Approved" size="small" color="success" variant="outlined" />;
    case 'rejected':
      return <Chip icon={<ErrorIcon />} label="Rejected" size="small" color="error" variant="outlined" />;
    default:
      return <Chip label={status} size="small" variant="outlined" />;
  }
}

function confidenceDisplay(score: number | null) {
  if (score == null) return <Typography variant="body2" color="text.secondary">-</Typography>;
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'error';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 80 }}>
      <LinearProgress
        variant="determinate"
        value={pct}
        color={color}
        sx={{ flex: 1, height: 6, borderRadius: 3 }}
      />
      <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32 }}>
        {pct}%
      </Typography>
    </Box>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function QueueRow({ item }: { item: ProcessingQueueItem }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const hasDetails = item.error_message || item.ai_fields || item.summary || item.template_id || item.auto_ingested;

  const parsedFields = (() => {
    if (!item.ai_fields) return null;
    try { return JSON.parse(item.ai_fields); } catch { return null; }
  })();

  return (
    <>
      <TableRow hover sx={{ '& > *': { borderBottom: open ? 'none' : undefined } }}>
        <TableCell padding="checkbox">
          {hasDetails && (
            <IconButton size="small" onClick={() => setOpen(!open)}>
              {open ? <CollapseIcon /> : <ExpandIcon />}
            </IconButton>
          )}
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {formatDateTime(item.created_at)}
        </TableCell>
        <TableCell>
          <Tooltip title={`${item.file_name} (${formatFileSize(item.file_size)})`}>
            <Typography variant="body2" noWrap sx={{ maxWidth: 220 }}>
              {item.file_name}
            </Typography>
          </Tooltip>
        </TableCell>
        <TableCell>
          <Chip label="Import" size="small" variant="outlined" />
        </TableCell>
        <TableCell>
          {processingChip(item.processing_status)}
        </TableCell>
        <TableCell>
          {reviewChip(item.status)}
        </TableCell>
        <TableCell>
          {confidenceDisplay(item.confidence_score)}
        </TableCell>
        <TableCell>
          <Typography variant="body2" noWrap sx={{ maxWidth: 140 }}>
            {item.supplier || '-'}
          </Typography>
        </TableCell>
        <TableCell>
          <Typography variant="body2" noWrap sx={{ maxWidth: 140 }}>
            {item.document_type_name || item.document_type_guess || '-'}
          </Typography>
        </TableCell>
        <TableCell padding="checkbox">
          <Box sx={{ display: 'flex', gap: 0.5 }}>
            {item.template_id && (
              <Tooltip title="Template matched">
                <AutoAwesome fontSize="small" color="info" />
              </Tooltip>
            )}
            {item.auto_ingested === 1 && (
              <Tooltip title="Auto-ingested">
                <CheckCircle fontSize="small" color="success" />
              </Tooltip>
            )}
            {item.status === 'approved' && (
              <Tooltip title="View in review queue">
                <IconButton size="small" onClick={() => navigate(`/review/${item.id}`)}>
                  <OpenInNew fontSize="small" />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </TableCell>
      </TableRow>
      {hasDetails && (
        <TableRow>
          <TableCell colSpan={10} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ py: 1.5, px: 2 }}>
                {item.error_message && (
                  <Alert severity="error" variant="outlined" sx={{ mb: 1.5 }}>
                    {item.error_message}
                  </Alert>
                )}
                {item.summary && (
                  <Box sx={{ mb: 1.5 }}>
                    <Typography variant="subtitle2" gutterBottom>Summary</Typography>
                    <Typography variant="body2" color="text.secondary">{item.summary}</Typography>
                  </Box>
                )}
                <Grid container spacing={2}>
                  {parsedFields && (
                    <Grid item xs={12} md={6}>
                      <Typography variant="subtitle2" gutterBottom>Extracted Fields</Typography>
                      <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.default' }}>
                        <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                          {JSON.stringify(parsedFields, null, 2)}
                        </pre>
                      </Paper>
                    </Grid>
                  )}
                  <Grid item xs={12} md={6}>
                    <Typography variant="subtitle2" gutterBottom>Details</Typography>
                    <Box component="dl" sx={{ m: 0, '& dt': { fontWeight: 600, fontSize: '0.8rem', color: 'text.secondary' }, '& dd': { ml: 0, mb: 1, fontSize: '0.85rem' } }}>
                      <dt>File Size</dt>
                      <dd>{formatFileSize(item.file_size)}</dd>
                      <dt>MIME Type</dt>
                      <dd>{item.mime_type}</dd>
                      {item.product_names && (
                        <>
                          <dt>Products</dt>
                          <dd>{item.product_names}</dd>
                        </>
                      )}
                      {item.template_id && (
                        <>
                          <dt>Template</dt>
                          <dd>{item.template_id}</dd>
                        </>
                      )}
                      {item.auto_ingested === 1 && (
                        <>
                          <dt>Auto-ingested</dt>
                          <dd>Yes</dd>
                        </>
                      )}
                      {item.reviewed_by_name && (
                        <>
                          <dt>Reviewed By</dt>
                          <dd>{item.reviewed_by_name} at {item.reviewed_at ? formatDateTime(item.reviewed_at) : '-'}</dd>
                        </>
                      )}
                      {item.created_by_name && (
                        <>
                          <dt>Created By</dt>
                          <dd>{item.created_by_name}</dd>
                        </>
                      )}
                    </Box>
                  </Grid>
                </Grid>
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type ReviewFilter = 'all' | 'pending' | 'approved' | 'rejected';
type ProcessingFilter = 'all' | 'queued' | 'processing' | 'ready' | 'error';

export function IngestHistory() {
  const [items, setItems] = useState<ProcessingQueueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('all');
  const [processingFilter, setProcessingFilter] = useState<ProcessingFilter>('all');

  // Pagination
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string | number> = {
        status: reviewFilter === 'all' ? 'all' : reviewFilter,
        limit: rowsPerPage,
        offset: page * rowsPerPage,
      };
      if (processingFilter !== 'all') {
        params.processing_status = processingFilter;
      }
      // Note: date filtering would need backend support; for now we fetch all and the
      // queue endpoint sorts by created_at DESC which gives us recency.
      // TODO: Add date range params to queue endpoint if needed.

      const result = await api.queue.list(params as any);
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  }, [reviewFilter, processingFilter, page, rowsPerPage]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleChangePage = (_: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleReviewChange = (_: React.MouseEvent<HTMLElement>, val: ReviewFilter | null) => {
    if (val !== null) { setReviewFilter(val); setPage(0); }
  };

  const handleProcessingChange = (_: React.MouseEvent<HTMLElement>, val: ProcessingFilter | null) => {
    if (val !== null) { setProcessingFilter(val); setPage(0); }
  };

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <HistoryIcon color="primary" />
        <Typography variant="h4" fontWeight={700}>
          Ingest History
        </Typography>
      </Box>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Full pipeline view: source, processing, AI extraction, review, and ingest status.
      </Typography>

      {/* Filters */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} md={5}>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
              Review Status
            </Typography>
            <ToggleButtonGroup
              value={reviewFilter}
              exclusive
              onChange={handleReviewChange}
              size="small"
              fullWidth
            >
              <ToggleButton value="all">All</ToggleButton>
              <ToggleButton value="pending">Pending</ToggleButton>
              <ToggleButton value="approved" color="success">Approved</ToggleButton>
              <ToggleButton value="rejected" color="error">Rejected</ToggleButton>
            </ToggleButtonGroup>
          </Grid>
          <Grid item xs={12} md={7}>
            <Typography variant="caption" color="text.secondary" sx={{ mb: 0.5, display: 'block' }}>
              Processing Status
            </Typography>
            <ToggleButtonGroup
              value={processingFilter}
              exclusive
              onChange={handleProcessingChange}
              size="small"
              fullWidth
            >
              <ToggleButton value="all">All</ToggleButton>
              <ToggleButton value="queued">Queued</ToggleButton>
              <ToggleButton value="processing">Processing</ToggleButton>
              <ToggleButton value="ready" color="success">Ready</ToggleButton>
              <ToggleButton value="error" color="error">Error</ToggleButton>
            </ToggleButtonGroup>
          </Grid>
        </Grid>
      </Paper>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Paper variant="outlined">
          <TableContainer sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox" />
                  <TableCell>Timestamp</TableCell>
                  <TableCell>File Name</TableCell>
                  <TableCell>Source</TableCell>
                  <TableCell>Processing</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Confidence</TableCell>
                  <TableCell>Supplier</TableCell>
                  <TableCell>Doc Type</TableCell>
                  <TableCell padding="checkbox" />
                </TableRow>
              </TableHead>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} align="center" sx={{ py: 4 }}>
                      <Typography color="text.secondary">No queue items found</Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((item) => (
                    <QueueRow key={item.id} item={item} />
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={handleChangePage}
            rowsPerPage={rowsPerPage}
            onRowsPerPageChange={handleChangeRowsPerPage}
            rowsPerPageOptions={[10, 25, 50, 100]}
          />
        </Paper>
      )}
    </Box>
  );
}
