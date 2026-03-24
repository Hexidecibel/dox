import { useState, useEffect, useCallback } from 'react';
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
  MenuItem,
  Select,
  FormControl,
  InputLabel,
  Chip,
  CircularProgress,
  Alert,
  IconButton,
  Collapse,
  Tooltip,
  Grid,
} from '@mui/material';
import {
  KeyboardArrowDown as ExpandIcon,
  KeyboardArrowUp as CollapseIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';

interface AuditEntry {
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

const ACTION_CATEGORIES: Record<string, { label: string; color: 'success' | 'info' | 'warning' | 'error' | 'default' }> = {
  login: { label: 'Auth', color: 'info' },
  password_changed: { label: 'Auth', color: 'info' },
  user_created: { label: 'User', color: 'warning' },
  document_created: { label: 'Document', color: 'success' },
  document_updated: { label: 'Document', color: 'success' },
  document_deleted: { label: 'Document', color: 'error' },
  document_version_uploaded: { label: 'Document', color: 'success' },
  document_downloaded: { label: 'Document', color: 'default' },
  tenant_updated: { label: 'Tenant', color: 'warning' },
  tenant_deactivated: { label: 'Tenant', color: 'error' },
  user_updated: { label: 'User', color: 'warning' },
  user_deactivated: { label: 'User', color: 'error' },
  'report.generate': { label: 'Report', color: 'info' },
};

const ALL_ACTIONS = [
  'login',
  'password_changed',
  'user_created',
  'document_created',
  'document_updated',
  'document_deleted',
  'document_version_uploaded',
  'document_downloaded',
  'tenant_updated',
  'tenant_deactivated',
  'user_updated',
  'user_deactivated',
  'report.generate',
];

function getActionChip(action: string) {
  const cat = ACTION_CATEGORIES[action] || { label: 'Other', color: 'default' as const };
  return <Chip label={action} size="small" color={cat.color} variant="outlined" />;
}

function formatTimestamp(ts: string): string {
  const date = new Date(ts + (ts.endsWith('Z') ? '' : 'Z'));
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function ExpandableRow({ entry }: { entry: AuditEntry }) {
  const [open, setOpen] = useState(false);

  let parsedDetails: Record<string, unknown> | null = null;
  if (entry.details) {
    try {
      parsedDetails = JSON.parse(entry.details);
    } catch {
      // not JSON
    }
  }

  const changes = parsedDetails?.changes as Record<string, { from: any; to: any }> | null | undefined;

  const formatValue = (val: any): string => {
    if (val === null || val === undefined) return '(empty)';
    if (typeof val === 'object') return JSON.stringify(val);
    return String(val);
  };

  return (
    <>
      <TableRow hover>
        <TableCell padding="checkbox">
          {entry.details && (
            <IconButton size="small" onClick={() => setOpen(!open)}>
              {open ? <CollapseIcon /> : <ExpandIcon />}
            </IconButton>
          )}
        </TableCell>
        <TableCell sx={{ whiteSpace: 'nowrap' }}>
          {formatTimestamp(entry.created_at)}
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
        <TableCell>{getActionChip(entry.action)}</TableCell>
        <TableCell>
          {entry.resource_type && (
            <Typography variant="body2">
              {entry.resource_type}
              {entry.resource_id && (
                <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
                  ({entry.resource_id.slice(0, 8)}...)
                </Typography>
              )}
            </Typography>
          )}
        </TableCell>
        <TableCell>
          <Tooltip title={entry.ip_address || 'Unknown'}>
            <Typography variant="body2" color="text.secondary">
              {entry.ip_address || '-'}
            </Typography>
          </Tooltip>
        </TableCell>
      </TableRow>
      {entry.details && (
        <TableRow>
          <TableCell colSpan={6} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
            <Collapse in={open} timeout="auto" unmountOnExit>
              <Box sx={{ py: 1.5, px: 2 }}>
                <Typography variant="subtitle2" gutterBottom>
                  Details
                </Typography>
                {changes && Object.keys(changes).length > 0 ? (
                  <Table size="small" sx={{ maxWidth: 600 }}>
                    <TableHead>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 600, py: 0.5 }}>Field</TableCell>
                        <TableCell sx={{ fontWeight: 600, py: 0.5 }}>Before</TableCell>
                        <TableCell sx={{ fontWeight: 600, py: 0.5 }} />
                        <TableCell sx={{ fontWeight: 600, py: 0.5 }}>After</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {Object.entries(changes).map(([field, { from, to }]) => (
                        <TableRow key={field}>
                          <TableCell sx={{ py: 0.5, fontWeight: 500 }}>{field}</TableCell>
                          <TableCell
                            sx={{
                              py: 0.5,
                              color: 'error.main',
                              bgcolor: 'error.lighter',
                              fontFamily: 'monospace',
                              fontSize: '0.8rem',
                            }}
                          >
                            {formatValue(from)}
                          </TableCell>
                          <TableCell sx={{ py: 0.5, px: 1, color: 'text.secondary' }}>
                            {'\u2192'}
                          </TableCell>
                          <TableCell
                            sx={{
                              py: 0.5,
                              color: 'success.main',
                              bgcolor: 'success.lighter',
                              fontFamily: 'monospace',
                              fontSize: '0.8rem',
                            }}
                          >
                            {formatValue(to)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : parsedDetails ? (
                  <Paper variant="outlined" sx={{ p: 1.5, bgcolor: 'background.default' }}>
                    <pre style={{ margin: 0, fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {JSON.stringify(parsedDetails, null, 2)}
                    </pre>
                  </Paper>
                ) : (
                  <Typography variant="body2">{entry.details}</Typography>
                )}
              </Box>
            </Collapse>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Filters
  const [action, setAction] = useState('');
  const [userSearch, setUserSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // Pagination
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(25);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = {};
      if (action) params.action = action;
      if (dateFrom) params.dateFrom = dateFrom;
      if (dateTo) params.dateTo = dateTo;
      params.limit = String(rowsPerPage);
      params.offset = String(page * rowsPerPage);

      const result = await api.audit.list(params);
      setEntries(result.entries as AuditEntry[]);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [action, dateFrom, dateTo, page, rowsPerPage]);

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

  // Filter entries by user search (client-side since the API doesn't support name search)
  const filteredEntries = userSearch
    ? entries.filter(
        (e) =>
          e.user_name?.toLowerCase().includes(userSearch.toLowerCase()) ||
          e.user_email?.toLowerCase().includes(userSearch.toLowerCase())
      )
    : entries;

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} gutterBottom>
        Audit Log
      </Typography>
      <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
        Track all actions performed in the system.
      </Typography>

      {/* Filters */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={3}>
            <FormControl fullWidth size="small">
              <InputLabel>Action Type</InputLabel>
              <Select
                value={action}
                onChange={(e) => { setAction(e.target.value); setPage(0); }}
                label="Action Type"
              >
                <MenuItem value="">All Actions</MenuItem>
                {ALL_ACTIONS.map((a) => (
                  <MenuItem key={a} value={a}>{a}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField
              label="Search User"
              fullWidth
              size="small"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="Name or email..."
            />
          </Grid>
          <Grid item xs={6} sm={6} md={3}>
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
          <Grid item xs={6} sm={6} md={3}>
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
                  <TableCell>User</TableCell>
                  <TableCell>Action</TableCell>
                  <TableCell>Resource</TableCell>
                  <TableCell>IP Address</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} align="center" sx={{ py: 4 }}>
                      <Typography color="text.secondary">No audit entries found</Typography>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredEntries.map((entry) => (
                    <ExpandableRow key={entry.id} entry={entry} />
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
