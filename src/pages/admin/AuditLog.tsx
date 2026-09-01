import { useState, useEffect, useCallback } from 'react';
import { formatDateTime } from '../../utils/format';
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
  Button,
} from '@mui/material';
import {
  KeyboardArrowDown as ExpandIcon,
  KeyboardArrowUp as CollapseIcon,
  FileDownload as ExportIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { HelpWell } from '../../components/HelpWell';
import { InfoTooltip } from '../../components/InfoTooltip';
import { EmptyState } from '../../components/EmptyState';
import { helpContent } from '../../lib/helpContent';

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
  'audit.export': { label: 'Report', color: 'info' },
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
  'audit.export',
];

function getActionChip(action: string) {
  const cat = ACTION_CATEGORIES[action] || { label: 'Other', color: 'default' as const };
  return <Chip label={action} size="small" color={cat.color} variant="outlined" />;
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
          {formatDateTime(entry.created_at)}
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

  // Export
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null);

  /**
   * The filters the SERVER understands. Deliberately the single source for
   * both the table fetch and the export, so the CSV an auditor downloads is
   * the same result set as the screen they were looking at.
   *
   * `userSearch` is intentionally absent: it is a client-side substring filter
   * over the current page only (the API has no name search), so it cannot be
   * pushed to the export. The UI says so next to the button rather than
   * silently producing a CSV that is wider than the screen.
   */
  const serverFilters = useCallback((): Record<string, string> => {
    const params: Record<string, string> = {};
    if (action) params.action = action;
    if (dateFrom) params.dateFrom = dateFrom;
    if (dateTo) params.dateTo = dateTo;
    return params;
  }, [action, dateFrom, dateTo]);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = {
        ...serverFilters(),
        limit: String(rowsPerPage),
        offset: String(page * rowsPerPage),
      };

      const result = await api.audit.list(params);
      setEntries(result.entries as AuditEntry[]);
      setTotal(result.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }, [serverFilters, page, rowsPerPage]);

  useEffect(() => {
    fetchEntries();
  }, [fetchEntries]);

  const handleChangePage = (_: unknown, newPage: number) => {
    setPage(newPage);
  };

  const handleExport = async () => {
    setExporting(true);
    setError('');
    setExportNotice(null);
    try {
      // Exports the whole filtered result set, not just the visible page.
      const { matched, truncated } = await api.audit.export(serverFilters());
      setExportNotice(
        truncated
          ? {
              severity: 'warning',
              text: `${matched.toLocaleString()} rows matched, but the export is capped. Narrow the date range to get the rest.`,
            }
          : {
              severity: 'success',
              text: `Exported ${matched.toLocaleString()} row${matched === 1 ? '' : 's'} to CSV.`,
            }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export audit log');
    } finally {
      setExporting(false);
    }
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
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 2,
          flexWrap: 'wrap',
        }}
      >
        <Box>
          <Typography variant="h4" fontWeight={700} gutterBottom>
            Audit Log
          </Typography>
          <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
            Track all actions performed in the system.
          </Typography>
        </Box>
        <Tooltip
          title={
            userSearch
              ? 'Exports every row matching the action and date filters. The user search box is a client-side filter over the current page only, so it is NOT applied to the export.'
              : 'Download every row matching the current filters as CSV — not just this page.'
          }
        >
          <span>
            <Button
              variant="outlined"
              startIcon={exporting ? <CircularProgress size={16} /> : <ExportIcon />}
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? 'Exporting...' : 'Export CSV'}
            </Button>
          </span>
        </Tooltip>
      </Box>

      <HelpWell id="audit.list" title={helpContent.audit.list?.headline ?? 'Audit Log'}>
        {helpContent.audit.list?.well ?? helpContent.audit.well}
      </HelpWell>

      {/* Filters */}
      <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={3}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
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
              <InfoTooltip text={helpContent.audit.list?.columnTooltips?.actionFilter} />
            </Box>
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <TextField
                label="Search User"
                fullWidth
                size="small"
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Name or email..."
              />
              <InfoTooltip text={helpContent.audit.list?.columnTooltips?.userSearch} />
            </Box>
          </Grid>
          <Grid item xs={6} sm={6} md={3}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <TextField
                label="Date From"
                type="date"
                fullWidth
                size="small"
                value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
                InputLabelProps={{ shrink: true }}
              />
              <InfoTooltip text={helpContent.audit.list?.columnTooltips?.dateRange} />
            </Box>
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

      {exportNotice && (
        <Alert severity={exportNotice.severity} sx={{ mb: 2 }} onClose={() => setExportNotice(null)}>
          {exportNotice.text}
          {userSearch && ' The user search filter is client-side and was not applied to the export.'}
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
                  <TableCell padding="checkbox">
                    <InfoTooltip text={helpContent.audit.list?.columnTooltips?.details} />
                  </TableCell>
                  <TableCell>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      Timestamp
                      <InfoTooltip text={helpContent.audit.list?.columnTooltips?.timestamp} />
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      User
                      <InfoTooltip text={helpContent.audit.list?.columnTooltips?.user} />
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      Action
                      <InfoTooltip text={helpContent.audit.list?.columnTooltips?.action} />
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      Resource
                      <InfoTooltip text={helpContent.audit.list?.columnTooltips?.resource} />
                    </Box>
                  </TableCell>
                  <TableCell>
                    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                      IP Address
                      <InfoTooltip text={helpContent.audit.list?.columnTooltips?.ipAddress} />
                    </Box>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredEntries.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} sx={{ p: 0, border: 0 }}>
                      <EmptyState
                        title={helpContent.audit.list?.emptyTitle ?? 'No audit entries'}
                        description={helpContent.audit.list?.emptyDescription}
                      />
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
