import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box,
  Typography,
  Card,
  CardContent,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Slider,
  CircularProgress,
  Alert,
  Button,
  ToggleButtonGroup,
  ToggleButton,
  Snackbar,
  useMediaQuery,
  useTheme,
  Link,
} from '@mui/material';
import {
  NotificationsActive as NotifyIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useTenant } from '../contexts/TenantContext';
import { ExpirationBadge } from '../components/ExpirationBadge';
import type { ExpirationItem, ExpirationSummary } from '../lib/types';

type StatusFilter = 'all' | 'expired' | 'critical' | 'warning' | 'ok';

export function Expirations() {
  const { isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const [expirations, setExpirations] = useState<ExpirationItem[]>([]);
  const [summary, setSummary] = useState<ExpirationSummary>({ expired: 0, critical: 0, warning: 0, ok: 0, total: 0 });
  const [daysAhead, setDaysAhead] = useState(90);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notifying, setNotifying] = useState(false);
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity: 'success' | 'error' }>({
    open: false,
    message: '',
    severity: 'success',
  });

  const loadExpirations = async () => {
    setLoading(true);
    setError('');
    try {
      const params: { days_ahead: number; tenant_id?: string; include_expired?: boolean } = {
        days_ahead: daysAhead,
        include_expired: true,
      };
      if (isSuperAdmin && selectedTenantId) {
        params.tenant_id = selectedTenantId;
      }
      const result = await api.expirations.list(params);
      setExpirations(result.expirations);
      setSummary(result.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load expirations');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      loadExpirations();
    }, 300);
    return () => clearTimeout(timer);
  }, [daysAhead, selectedTenantId]);

  const handleNotify = async () => {
    setNotifying(true);
    try {
      const result = await api.expirations.notify();
      setSnackbar({
        open: true,
        message: `Sent ${result.sent} notification email${result.sent === 1 ? '' : 's'} to ${result.tenants_notified} tenant${result.tenants_notified === 1 ? '' : 's'}`,
        severity: 'success',
      });
    } catch (err) {
      setSnackbar({
        open: true,
        message: err instanceof Error ? err.message : 'Failed to send notifications',
        severity: 'error',
      });
    } finally {
      setNotifying(false);
    }
  };

  const filteredExpirations =
    statusFilter === 'all' ? expirations : expirations.filter((e) => e.status === statusFilter);

  const summaryCards: Array<{ label: string; count: number; color: string; filter: StatusFilter }> = [
    { label: 'Expired', count: summary.expired, color: '#b71c1c', filter: 'expired' },
    { label: 'Critical <14d', count: summary.critical, color: '#d32f2f', filter: 'critical' },
    { label: 'Warning <60d', count: summary.warning, color: '#ed6c02', filter: 'warning' },
    { label: 'OK', count: summary.ok, color: '#2e7d32', filter: 'ok' },
  ];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h4" fontWeight={700}>
          Expirations
        </Typography>
        {isSuperAdmin && (
          <Button
            variant="contained"
            startIcon={<NotifyIcon />}
            onClick={handleNotify}
            disabled={notifying || summary.total === 0}
          >
            {notifying ? 'Sending...' : 'Send Notifications'}
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Summary cards */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' }, gap: 2, mb: 3 }}>
        {summaryCards.map((card) => (
          <Card
            key={card.filter}
            variant="outlined"
            sx={{
              cursor: 'pointer',
              borderColor: statusFilter === card.filter ? card.color : 'divider',
              borderWidth: statusFilter === card.filter ? 2 : 1,
              '&:hover': { borderColor: card.color },
            }}
            onClick={() => setStatusFilter(statusFilter === card.filter ? 'all' : card.filter)}
          >
            <CardContent sx={{ textAlign: 'center', py: 2, '&:last-child': { pb: 2 } }}>
              <Typography variant="h4" fontWeight={700} sx={{ color: card.color }}>
                {card.count}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {card.label}
              </Typography>
            </CardContent>
          </Card>
        ))}
      </Box>

      {/* Days ahead slider */}
      <Box sx={{ mb: 3, px: 1 }}>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Look ahead: {daysAhead} days
        </Typography>
        <Slider
          value={daysAhead}
          onChange={(_, val) => setDaysAhead(val as number)}
          min={7}
          max={365}
          step={1}
          marks={[
            { value: 7, label: '7d' },
            { value: 30, label: '30d' },
            { value: 90, label: '90d' },
            { value: 180, label: '180d' },
            { value: 365, label: '1y' },
          ]}
          sx={{ maxWidth: 500 }}
        />
      </Box>

      {/* Status filter toggle */}
      <Box sx={{ mb: 2 }}>
        <ToggleButtonGroup
          value={statusFilter}
          exclusive
          onChange={(_, val) => { if (val !== null) setStatusFilter(val); }}
          size="small"
        >
          <ToggleButton value="all">All ({summary.total})</ToggleButton>
          <ToggleButton value="expired" sx={{ color: '#b71c1c' }}>Expired ({summary.expired})</ToggleButton>
          <ToggleButton value="critical" sx={{ color: '#d32f2f' }}>Critical ({summary.critical})</ToggleButton>
          <ToggleButton value="warning" sx={{ color: '#ed6c02' }}>Warning ({summary.warning})</ToggleButton>
          <ToggleButton value="ok" sx={{ color: '#2e7d32' }}>OK ({summary.ok})</ToggleButton>
        </ToggleButtonGroup>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : isMobile ? (
        /* Mobile card layout */
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {filteredExpirations.length === 0 ? (
            <Card variant="outlined">
              <CardContent sx={{ textAlign: 'center', py: 4 }}>
                <Typography color="text.secondary">No expiring documents found</Typography>
              </CardContent>
            </Card>
          ) : (
            filteredExpirations.map((item) => (
              <Card key={item.link_id} variant="outlined">
                <CardContent sx={{ pb: '12px !important' }}>
                  <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', mb: 0.5 }}>
                    <Box sx={{ minWidth: 0, flex: 1 }}>
                      <Link
                        component="button"
                        variant="body2"
                        fontWeight={600}
                        onClick={() => navigate(`/documents/${item.document_id}`)}
                        sx={{ textAlign: 'left' }}
                      >
                        {item.document_title}
                      </Link>
                      <Typography variant="caption" color="text.secondary" display="block">
                        {item.product_name}
                      </Typography>
                    </Box>
                    <ExpirationBadge expiresAt={item.expires_at} />
                  </Box>
                  {item.document_type_name && (
                    <Typography variant="caption" color="text.secondary">
                      Type: {item.document_type_name}
                    </Typography>
                  )}
                  {isSuperAdmin && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      Tenant: {item.tenant_name}
                    </Typography>
                  )}
                  {item.notes && (
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                      {item.notes}
                    </Typography>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </Box>
      ) : (
        /* Desktop table layout */
        <TableContainer component={Paper} variant="outlined">
          <Table>
            <TableHead>
              <TableRow>
                <TableCell>Product</TableCell>
                <TableCell>Document</TableCell>
                <TableCell>Type</TableCell>
                {isSuperAdmin && <TableCell>Tenant</TableCell>}
                <TableCell>Expires</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Notes</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredExpirations.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={isSuperAdmin ? 7 : 6} sx={{ textAlign: 'center', py: 4 }}>
                    <Typography color="text.secondary">No expiring documents found</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                filteredExpirations.map((item) => (
                  <TableRow key={item.link_id} hover>
                    <TableCell>
                      <Typography variant="body2" fontWeight={500}>
                        {item.product_name}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Link
                        component="button"
                        variant="body2"
                        onClick={() => navigate(`/documents/${item.document_id}`)}
                        sx={{ textAlign: 'left' }}
                      >
                        {item.document_title}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary">
                        {item.document_type_name || '-'}
                      </Typography>
                    </TableCell>
                    {isSuperAdmin && (
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {item.tenant_name}
                        </Typography>
                      </TableCell>
                    )}
                    <TableCell>
                      <Typography variant="body2">{item.expires_at}</Typography>
                    </TableCell>
                    <TableCell>
                      <ExpirationBadge expiresAt={item.expires_at} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.notes || '-'}
                      </Typography>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Snackbar
        open={snackbar.open}
        autoHideDuration={6000}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
      >
        <Alert
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
          severity={snackbar.severity}
          variant="filled"
        >
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
