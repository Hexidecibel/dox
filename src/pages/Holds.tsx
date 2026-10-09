import { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  FormControl,
  InputLabel,
  Link,
  MenuItem,
  Paper,
  Select,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { useTenant } from '../contexts/TenantContext';
import { EmptyState } from '../components/EmptyState';
import { HelpWell } from '../components/HelpWell';
import { HoldReasonDialog, holdWhere } from '../components/DocumentHolds';
import { announceHoldsChanged } from '../lib/holds';
import { helpContent } from '../lib/helpContent';
import { formatDateTime } from '../utils/format';
import { HOLD_SOURCES, HOLD_SOURCE_HELP, HOLD_SOURCE_LABELS, type HoldSource } from '../../shared/holds';
import type { ApiDocumentHold, HoldsListResponse } from '../../shared/types';

type State = 'active' | 'released' | 'all';
const ANY_SOURCE = 'any';

/**
 * Holds (decision C-005, migration 0139): every certificate that is on hold in
 * the organization, why, and since when.
 *
 * Anybody signed in can read it, because the person asking "why did this
 * certificate not go" is often not QA. Only QA or an administrator is offered
 * Release, and a release needs a written reason.
 */
export function Holds() {
  const { selectedTenantId } = useTenant();
  const [state, setState] = useState<State>('active');
  const [source, setSource] = useState<string>(ANY_SOURCE);
  const [data, setData] = useState<HoldsListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [releasing, setReleasing] = useState<ApiDocumentHold | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const load = useCallback(
    (quiet = false) => {
      if (!quiet) setLoading(true);
      api.holds
        .list({
          tenant_id: selectedTenantId || undefined,
          state,
          source: source === ANY_SOURCE ? undefined : (source as HoldSource),
        })
        .then((r) => {
          setData(r);
          setError('');
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the holds'))
        .finally(() => setLoading(false));
    },
    [selectedTenantId, state, source],
  );

  useEffect(() => {
    load();
  }, [load]);

  const release = async (reason: string) => {
    if (!releasing) return;
    setBusy(true);
    setDialogError('');
    try {
      await api.holds.release(releasing.id, reason);
      setNotice(`Released the hold on ${releasing.document_title || 'the certificate'}. It can be sent again.`);
      setReleasing(null);
      announceHoldsChanged();
      load(true);
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : 'The hold could not be released.');
    } finally {
      setBusy(false);
    }
  };

  const holds = data?.holds ?? [];

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4" fontWeight={700}>
          Holds
        </Typography>
        {data && (
          <Typography variant="body2" color="text.secondary" data-testid="holds-count">
            ({data.total})
          </Typography>
        )}
      </Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        A certificate on hold cannot be sent on an order, in a ZIP, by link, in a bundle or read with an API key until QA
        or an administrator releases the hold. It can still be opened in the portal. Nothing here reaches a warehouse
        system.
      </Typography>

      <HelpWell id="holds.list" title={helpContent.holds.headline}>
        {helpContent.holds.well}
      </HelpWell>

      <Stack direction="row" spacing={2} alignItems="center" sx={{ my: 2, flexWrap: 'wrap' }} useFlexGap>
        <ToggleButtonGroup size="small" exclusive value={state} onChange={(_, v: State | null) => v && setState(v)}>
          <ToggleButton value="active" data-testid="holds-state-active">
            On hold
          </ToggleButton>
          <ToggleButton value="released" data-testid="holds-state-released">
            Released
          </ToggleButton>
          <ToggleButton value="all" data-testid="holds-state-all">
            All
          </ToggleButton>
        </ToggleButtonGroup>
        <FormControl size="small" sx={{ minWidth: 240 }}>
          <InputLabel id="holds-source-label">Placed by</InputLabel>
          <Select
            labelId="holds-source-label"
            label="Placed by"
            value={source}
            onChange={(e) => setSource(e.target.value)}
            inputProps={{ 'data-testid': 'holds-source' }}
          >
            <MenuItem value={ANY_SOURCE}>Anything</MenuItem>
            {HOLD_SOURCES.map((s) => (
              <MenuItem key={s} value={s}>
                {HOLD_SOURCE_LABELS[s]}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')} data-testid="holds-notice">
          {notice}
        </Alert>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : holds.length === 0 ? (
        <EmptyState
          title={state === 'active' ? 'Nothing is on hold' : 'No holds match'}
          description={
            state === 'active'
              ? 'A hold is placed on a certificate from its own page, or automatically when a certificate is approved with a Critical result out of spec.'
              : 'Change the filter above to see other holds.'
          }
        />
      ) : (
        <Stack spacing={1.5}>
          {data?.truncated && (
            <Alert severity="info" data-testid="holds-truncated">
              Showing the first {holds.length} of {data.total}. Narrow the filter to see the rest.
            </Alert>
          )}
          {holds.map((h) => (
            <Paper key={h.id} variant="outlined" sx={{ p: 2 }} data-testid="hold-row">
              <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap' }}>
                <Box sx={{ flex: 1, minWidth: 260 }}>
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap' }}>
                    <Link component={RouterLink} to={`/documents/${h.document_id}`} underline="hover" sx={{ fontWeight: 600 }}>
                      {h.document_title || 'Untitled document'}
                    </Link>
                    <Chip size="small" color={h.active ? 'error' : 'default'} variant={h.active ? 'filled' : 'outlined'} label={h.active ? 'On hold' : 'Released'} />
                    <Chip size="small" variant="outlined" label={holdWhere(h)} />
                    <Chip size="small" variant="outlined" label={HOLD_SOURCE_LABELS[h.source]} title={HOLD_SOURCE_HELP[h.source]} />
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 0.25 }}>
                    {[h.supplier_name, h.document_type_name, h.product_names.join(', ')].filter(Boolean).join(' · ') || 'No supplier or type recorded'}
                  </Typography>
                  <Typography variant="body2" sx={{ mt: 1 }} data-testid="hold-row-reason">
                    {h.reason}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" component="div">
                    Placed{h.placed_by_name ? ` by ${h.placed_by_name}` : ' by the portal at approval'} on {formatDateTime(h.placed_at)}
                    {h.detail?.location ? ` · ${h.detail.location}` : ''}
                  </Typography>
                  {!h.active && (
                    <Typography variant="caption" color="text.secondary" component="div" data-testid="hold-row-release">
                      Released{h.released_by_name ? ` by ${h.released_by_name}` : ''}
                      {h.released_at ? ` on ${formatDateTime(h.released_at)}` : ''}: {h.release_reason}
                    </Typography>
                  )}
                </Box>
                {h.active && data?.can_release && (
                  <Button
                    variant="outlined"
                    size="small"
                    sx={{ textTransform: 'none' }}
                    onClick={() => {
                      setDialogError('');
                      setReleasing(h);
                    }}
                    data-testid="hold-row-release-button"
                  >
                    Release hold
                  </Button>
                )}
              </Box>
            </Paper>
          ))}
          {data && !data.can_release && state !== 'released' && (
            <Typography variant="caption" color="text.secondary" data-testid="holds-who-releases">
              QA or an administrator releases a hold.
            </Typography>
          )}
        </Stack>
      )}

      <HoldReasonDialog
        open={Boolean(releasing)}
        title="Release this hold"
        intro={
          releasing
            ? `${releasing.document_title || 'This certificate'}, ${holdWhere(releasing).toLowerCase()}: ${releasing.reason} Releasing it lets the certificate be sent again.`
            : ''
        }
        confirmLabel="Release hold"
        busy={busy}
        error={dialogError}
        onCancel={() => setReleasing(null)}
        onConfirm={release}
      />
    </Box>
  );
}
