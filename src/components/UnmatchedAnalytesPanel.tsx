/**
 * "These spellings were skipped" — the alias gap, on the screen that can fix it.
 *
 * WHY IT IS HERE AND NOT ONLY IN A SCRIPT. A limit whose analyte name never
 * matches what a supplier prints is a limit that silently never runs, and the
 * out-of-spec register cannot report a check that never happened: the absence of
 * a row reads exactly like a pass. `bin/recheck-spec-limits` has reported this
 * since the feature shipped and it is how a real gap of eight spellings across
 * hundreds of results was found on the live tenant — but the person who
 * maintains the aliases does not have a terminal. The derivation is shared with
 * that script (`shared/unmatchedAnalytes.ts`), so the two cannot drift.
 *
 * ONE LINE PER ANALYTE, NOT PER SPELLING. "Flavor" and "FLAVOR" are one row,
 * because one alias fixes both — that is the same fold the matcher applies. The
 * other spellings are shown so a person can see what they are agreeing to.
 *
 * THREE ANSWERS, AND THE THIRD IS THE ONE THAT MAKES THE LIST USABLE. Add the
 * spelling to an analyte you already hold; create the analyte; or say it is not
 * a test at all. On the live tenant this list is 144 names and only a dozen are
 * analytes — the rest are "Flavor", "LOT CODE", "TIME IN", "Best By Date". A
 * worklist that can only ever grow is one nobody reads, which would lose the
 * dozen that matter. A dismissal changes no verdict, is audited, stays readable
 * and is undone with one click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  Link,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import RefreshIcon from '@mui/icons-material/Refresh';
import BlockIcon from '@mui/icons-material/Block';
import UndoIcon from '@mui/icons-material/Undo';
import { Link as RouterLink } from 'react-router-dom';
import { api } from '../lib/api';
import type {
  ApiIgnoredSpelling,
  ApiSpecTest,
  ApiUnmatchedAnalyteResponse,
  UnmatchedAnalyteGroup,
} from '../lib/types';

const PAGE_SIZE = 25;

export function UnmatchedAnalytesPanel({
  tenantId,
  specTests,
  reloadKey,
  onAliasAdded,
  onCreateAnalyte,
}: {
  tenantId?: string;
  /** The analytes this tenant holds — the picker's options. */
  specTests: ApiSpecTest[];
  /** Bumped by the page when analytes change, so the list re-reads. */
  reloadKey?: number;
  /** Called after a spelling is attached to an analyte. */
  onAliasAdded: () => void;
  /** Hand a group to the page's "add analyte" dialog, pre-filled. */
  onCreateAnalyte: (group: UnmatchedAnalyteGroup) => void;
}) {
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<ApiUnmatchedAnalyteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [busyKey, setBusyKey] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [showIgnored, setShowIgnored] = useState(false);
  const [ignored, setIgnored] = useState<ApiIgnoredSpelling[]>([]);

  const load = useCallback(
    async (nextOffset: number, withIgnored: boolean) => {
      // A super_admin who has not picked a tenant yet: there is no corpus to
      // read, and asking anyway would answer with a 400 dressed up as a
      // failure. Say which it is instead.
      if (!tenantId) {
        setData(null);
        return;
      }
      setLoading(true);
      setError('');
      try {
        const res = await api.specUnmatched.list({
          tenant_id: tenantId,
          limit: PAGE_SIZE,
          offset: nextOffset,
          include_ignored: withIgnored,
        });
        setData(res);
        setOffset(res.offset);
        if (withIgnored) setIgnored(res.ignored ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not check for unmatched spellings');
      } finally {
        setLoading(false);
      }
    },
    [tenantId]
  );

  useEffect(() => {
    if (!open) return;
    load(0, showIgnored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, reloadKey, open]);

  const groups = data?.unmatched ?? [];
  const total = data?.total_groups ?? 0;

  const analyteOptions = useMemo(
    () => [...specTests].sort((a, b) => a.name.localeCompare(b.name)),
    [specTests]
  );

  const addAlias = async (group: UnmatchedAnalyteGroup) => {
    const testId = picked[group.key];
    if (!testId) return;
    setBusyKey(group.key);
    setError('');
    try {
      // The spelling that actually appears most often is what gets stored; the
      // matcher normalises case and punctuation, so the rest of the group is
      // covered by it.
      await api.specTests.addAlias(testId, group.name);
      onAliasAdded();
      await load(offset, showIgnored);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add that spelling');
    } finally {
      setBusyKey('');
    }
  };

  const ignore = async (group: UnmatchedAnalyteGroup) => {
    setBusyKey(group.key);
    setError('');
    try {
      await api.specUnmatched.ignore({ name: group.name, tenant_id: tenantId });
      await load(offset, showIgnored);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not dismiss that spelling');
    } finally {
      setBusyKey('');
    }
  };

  const restore = async (row: ApiIgnoredSpelling) => {
    setBusyKey(row.name_key);
    setError('');
    try {
      await api.specUnmatched.restore({ name: row.name_raw, tenant_id: tenantId });
      await load(offset, true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore that spelling');
    } finally {
      setBusyKey('');
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2, mb: 3 }} data-testid="unmatched-analytes">
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Spellings no analyte recognises
        </Typography>
        {data && (
          <Chip
            size="small"
            color={total > 0 ? 'warning' : 'success'}
            variant={total > 0 ? 'filled' : 'outlined'}
            label={
              total > 0
                ? `${total} name${total === 1 ? '' : 's'} · ${data.total_results} result${data.total_results === 1 ? '' : 's'}`
                : 'nothing skipped'
            }
          />
        )}
        <Box sx={{ flexGrow: 1 }} />
        <Tooltip title="Re-read the approved documents">
          <span>
            <IconButton size="small" disabled={loading} onClick={() => load(offset, showIgnored)}>
              <RefreshIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton size="small" onClick={() => setOpen((v) => !v)}>
          {open ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
        </IconButton>
      </Stack>

      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        Every test name your approved certificates printed that none of your
        analytes answers to. Each one was skipped entirely — a limit that never
        matches a supplier&apos;s spelling never runs, and nothing else on this
        site can tell you that a check did not happen. Attach the spelling to the
        analyte it belongs to, create the analyte, or say it is not a test.
      </Typography>

      <Collapse in={open}>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {!tenantId ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            Pick a tenant to check its certificates.
          </Typography>
        ) : loading && !data ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <>
            {data && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                Read from {data.documents_with_results} of the {data.documents_scanned} most recent
                approved documents.
                {data.scan_truncated && (
                  <>
                    {' '}
                    <strong>
                      More documents exist than one check reads ({data.scan_cap}) — these counts are
                      a floor, not a total.
                    </strong>
                  </>
                )}
              </Typography>
            )}

            {groups.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                {data && data.ignored_count > 0
                  ? 'Nothing outstanding — every printed test name is recognised or has been dismissed.'
                  : 'Nothing outstanding — every test name printed on your certificates is recognised.'}
              </Typography>
            ) : (
              <TableContainer sx={{ mt: 1.5 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 600 }}>Printed as</TableCell>
                      <TableCell sx={{ fontWeight: 600 }} align="right">
                        Results
                      </TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>Seen on</TableCell>
                      <TableCell sx={{ fontWeight: 600 }}>Make it match</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {groups.map((g) => (
                      <TableRow key={g.key} hover>
                        <TableCell>
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {g.name}
                          </Typography>
                          {g.spellings.length > 1 && (
                            <Typography variant="caption" color="text.secondary">
                              also {g.spellings.slice(1).map((s) => s.name).join(', ')}
                            </Typography>
                          )}
                        </TableCell>
                        <TableCell align="right">
                          <Typography variant="body2" sx={{ fontWeight: 600 }}>
                            {g.results}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            in {g.documents} doc{g.documents === 1 ? '' : 's'}
                          </Typography>
                        </TableCell>
                        <TableCell>
                          <Typography variant="caption" color="text.secondary" display="block">
                            {g.suppliers
                              .slice(0, 2)
                              .map((s) => s.name || 'no supplier')
                              .join(', ')}
                            {g.suppliers.length > 2 && ` +${g.suppliers.length - 2}`}
                          </Typography>
                          {g.example && (
                            <Link
                              component={RouterLink}
                              to={`/documents/${g.example.document_id}`}
                              variant="caption"
                              underline="hover"
                            >
                              {g.example.document_title || g.example.document_id} — printed &quot;
                              {g.example.value_raw}
                              {g.example.unit_raw ? ` ${g.example.unit_raw}` : ''}&quot;
                            </Link>
                          )}
                        </TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                            <TextField
                              select
                              size="small"
                              label="Add as an alias of"
                              sx={{ minWidth: 190 }}
                              value={picked[g.key] || ''}
                              onChange={(e) =>
                                setPicked((p) => ({ ...p, [g.key]: e.target.value }))
                              }
                            >
                              {analyteOptions.map((t) => (
                                <MenuItem key={t.id} value={t.id}>
                                  {t.name}
                                </MenuItem>
                              ))}
                            </TextField>
                            <Button
                              size="small"
                              variant="contained"
                              disabled={!picked[g.key] || busyKey === g.key}
                              onClick={() => addAlias(g)}
                            >
                              Add
                            </Button>
                            <Button size="small" onClick={() => onCreateAnalyte(g)}>
                              New analyte
                            </Button>
                            <Tooltip title="Keep it off this list. Nothing about the certificate changes.">
                              <span>
                                <Button
                                  size="small"
                                  color="inherit"
                                  startIcon={<BlockIcon fontSize="small" />}
                                  disabled={busyKey === g.key}
                                  onClick={() => ignore(g)}
                                >
                                  Not a test
                                </Button>
                              </span>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}

            {total > PAGE_SIZE && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 1.5 }}>
                <Button
                  size="small"
                  disabled={offset === 0 || loading}
                  onClick={() => load(Math.max(0, offset - PAGE_SIZE), showIgnored)}
                >
                  Previous
                </Button>
                <Typography variant="caption" color="text.secondary">
                  {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
                </Typography>
                <Button
                  size="small"
                  disabled={offset + PAGE_SIZE >= total || loading}
                  onClick={() => load(offset + PAGE_SIZE, showIgnored)}
                >
                  Next
                </Button>
              </Stack>
            )}

            {data && data.ignored_count > 0 && (
              <Box sx={{ mt: 2 }}>
                <Button
                  size="small"
                  onClick={() => {
                    const next = !showIgnored;
                    setShowIgnored(next);
                    load(offset, next);
                  }}
                >
                  {showIgnored ? 'Hide' : 'Show'} {data.ignored_count} dismissed as not a test
                </Button>
                {showIgnored && (
                  <Stack spacing={0.5} sx={{ mt: 1 }}>
                    {ignored.map((row) => (
                      <Stack
                        key={row.id}
                        direction="row"
                        spacing={1}
                        alignItems="center"
                        sx={{ flexWrap: 'wrap' }}
                      >
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                          {row.name_raw}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          dismissed{row.created_by_name ? ` by ${row.created_by_name}` : ''}
                          {row.created_at ? ` on ${row.created_at.slice(0, 10)}` : ''}
                          {row.reason ? ` — ${row.reason}` : ''}
                        </Typography>
                        <Button
                          size="small"
                          startIcon={<UndoIcon fontSize="small" />}
                          disabled={busyKey === row.name_key}
                          onClick={() => restore(row)}
                        >
                          Put it back
                        </Button>
                      </Stack>
                    ))}
                  </Stack>
                )}
              </Box>
            )}
          </>
        )}
      </Collapse>
    </Paper>
  );
}

export default UnmatchedAnalytesPanel;
