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
  TextField,
  Chip,
  CircularProgress,
  Alert,
  IconButton,
  Collapse,
  Tooltip,
  ToggleButton,
  ToggleButtonGroup,
  Grid,
} from '@mui/material';
import {
  KeyboardArrowDown as ExpandIcon,
  KeyboardArrowUp as CollapseIcon,
  CheckCircle,
  Error as ErrorIcon,
  History as HistoryIcon,
  OpenInNew,
} from '@mui/icons-material';
import { api } from '../lib/api';

interface IngestEntry {
  id: number;
  user_id: string | null;
  tenant_id: string | null;
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  details: string | null;
  ip_address: string | null;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
}

interface ParsedDetails {
  file_name?: string;
  action?: string;
  external_ref?: string;
  error?: string;
  [key: string]: unknown;
}

function parseDetails(details: string | null): ParsedDetails | null {
  if (!details) return null;
  try {
    return JSON.parse(details);
  } catch {
    return null;
  }
}

function IngestRow({ entry }: { entry: IngestEntry }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const parsed = parseDetails(entry.details);
  const isFailed = entry.action === 'document.ingest_failed';
  const isSuccess = entry.action === 'document.ingested';

  const handleRowClick = () => {
    if (isSuccess && entry.resource_id) {
      navigate(`/documents/${entry.resource_id}`);
    }
  };

  return (
    <>
      <TableRow
        hover
        onClick={isFailed ? undefined : handleRowClick}
        sx={{ cursor: isSuccess && entry.resource_id ? 'pointer' : 'default' }}
      >
        <TableCell padding="checkbox">
          {isFailed && entry.details && (
            <IconButton size="small" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
              {open ? <CollapseIcon /> : <ExpandIcon />}
            </IconButton>
          )}
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {formatDateTime(entry.created_at)}
        </TableCell>
        <TableCell>
          <Tooltip title={parsed?.file_name || ''}>
            <Typography variant="body2" noWrap sx={{ maxWidth: 250 }}>
              {parsed?.file_name || '-'}
            </Typography>
          </Tooltip>
        </TableCell>
        <TableCell>
          {isFailed ? (
            <Chip
              icon={<ErrorIcon />}
              label="Failed"
              size="small"
              color="error"
              variant="outlined"
            />
          ) : (
            <Chip
              icon={<CheckCircle />}
              label="Success"
              size="small"
              color="success"
              variant="outlined"
            />
          )}
        </TableCell>
        <TableCell>
          <Chip
            label={parsed?.action || (isFailed ? 'failed' : 'unknown')}
            size="small"
            variant="outlined"
          />
        </TableCell>
        <TableCell>
          <Typography variant="body2" color="text.secondary" noWrap sx={{ maxWidth: 180 }}>
            {parsed?.external_ref || '-'}
          </Typography>
        </TableCell>
        <TableCell>
          {entry.user_name ? (
            <Tooltip title={entry.user_email || ''}>
              <span>{entry.user_name}</span>
            </Tooltip>
          ) : (
            <Typography variant="body2" color="text.secondary">System</Typography>
          )}
        </TableCell>
        <TableCell padding="checkbox">
          {isSuccess && entry.resource_id && (
            <Tooltip title="Open document">
              <IconButton size="small" onClick={handleRowClick}>
                <OpenInNew fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </TableCell>
      </TableRow>
      {isFailed && entry.details && (
        <TableRow>
          <TableCell colSpan={8} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ py: 1.5, px: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Error Details
                </Typography>
                {parsed?.error ? (
                  <Alert severity="error" variant="outlined" sx={{ mb: 1 }}>
                    {parsed.error}
                  </Alert>
                ) : null}
                <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.default' }}>
                  <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {JSON.stringify(parsed || entry.details, null, 2)}
                  </pre>
                </Paper>
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type StatusFilter = 'all' | 'success' | 'failed';

function getActionParam(status: StatusFilter): string {
  switch (status) {
    case 'success':
      return 'document.ingested';
    case 'failed':
      return 'document.ingest_failed';
    default:
      return 'document.ingested,document.ingest_failed';
  }
}

function getDefaultDateFrom(): string {
  const d = new Date();
  d.setDate(d.getDate() - 30);
  return d.toISOString().split('T')[0];
}

export function IngestHistory() {
  const [entries, setEntries] = useState<IngestEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [status, setStatus] = useState<StatusFilter>('all');
  const [dateFrom, setDateFrom] = useState(getDefaultDateFrom);
  const [dateTo, setDateTo] = useState('');

  // Pagination
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = {
        action: getActionParam(status),
      };
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      params.limit = String(rowsPerPage);
      params.offset = String(page * rowsPerPage);

      const result = await api.ingestHistory.list(params);
      setEntries(result.entries as IngestEntry[]);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load ingest history');
    } finally {
      setLoading(false);
    }
  }, [status, dateFrom, dateTo, page, rowsPerPage]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleChangePage = (_: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleChangeRowsPerPage = (event: React.ChangeEvent<HTMLInputElement>) => {
    setRowsPerPage(parseInt(event.target.value, 10));
    setPage(0);
  };

  const handleStatusChange = (_: React.MouseEvent<HTMLElement>, newStatus: StatusFilter | null) => {
    if (newStatus !== null) {
      setStatus(newStatus);
      setPage(0);
    }
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
        Track documents ingested via the API and email pipelines.
      </Typography>

      {/* Filters */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={4}>
            <ToggleButtonGroup
              value={status}
              exclusive
              onChange={handleStatusChange}
              size="small"
              fullWidth
            >
              <ToggleButton value="all">All</ToggleButton>
              <ToggleButton value="success" color="success">Success</ToggleButton>
              <ToggleButton value="failed" color="error">Failed</ToggleButton>
            </ToggleButtonGroup>
          </Grid>
          <Grid item xs={6} sm={3} md={4}>
            <TextField
              label="Date From"
              type="date"
              fullWidth
              size="small"
              value={dateFrom}
              onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
              InputLabelProps={{ shrink: true }}
            />
          </Grid>
          <Grid item xs={6} sm={3} md={4}>
            <TextField
              label="Date To"
              type="date"
              fullWidth
              size="small"
              value={dateTo}
              onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
              InputLabelProps={{ shrink: true }}
            />
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
                  <TableCell>Status</TableCell>
                  <TableCell>Action</TableCell>
                  <TableCell>External Ref</TableCell>
                  <TableCell>User</TableCell>
                  <TableCell padding="checkbox" />
                </TableRow>
              </TableHead>
              <TableBody>
                {entries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} align="center" sx={{ py: 4 }}>
                      <Typography color="text.secondary">No ingest entries found</Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  entries.map((entry) => (
                    <IngestRow key={entry.id} entry={entry} />
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
