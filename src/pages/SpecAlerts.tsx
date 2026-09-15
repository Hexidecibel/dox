/**
 * Out of Spec — the register of every result that failed an acceptance limit.
 *
 * The review queue is where a bad result gets caught by whoever happens to be
 * reviewing. This page is the standing answer to "what has come in out of spec",
 * which is a different question with a different audience: the person who owns
 * food safety, an auditor, or a customer asking what happened to lot L26-0842.
 *
 * WHAT THIS PAGE DELIBERATELY CANNOT DO: change a verdict. Acknowledging records
 * that a person has seen a result and accepted it, with their reason. Nothing
 * here can make an out-of-spec result read as in-spec, because a register you
 * can edit is not evidence.
 *
 * `not_checked` has its own tab and it is not an afterthought — it means we held
 * a limit for that test and could not honestly apply it. A reader who assumes
 * "not listed as failing" means "passed" is exactly who this feature has to
 * protect, so the count of unjudgeable results is always one click away.
 *
 * WHO JUDGED IT (migration 0103) is shown on every row and filterable. A result
 * a reviewer had in front of them at approval and one `bin/backfill-spec-register`
 * computed over history are different events: nobody reviewed the second at
 * approval and nobody was emailed about it. Rendering the two identically would
 * let a script's arithmetic pass for a person's judgement.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
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
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  ErrorOutline as OutOfSpecIcon,
  HelpOutline as NotCheckedIcon,
  CheckCircleOutline as AckIcon,
} from '@mui/icons-material';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  SPEC_CRITICALITY_COLOR,
  SPEC_CRITICALITY_LABELS,
  isSpecCriticality,
} from '../../shared/specCriticality';
import type { SpecCriticality } from '../../shared/specCriticality';
import type { ApiSpecCheck } from '../lib/types';
import { EmptyState } from '../components/EmptyState';
import { ConversionChip, conversionFromSnapshot } from '../components/SpecWarnings';

type TabKey = 'open' | 'acknowledged' | 'not_checked';

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'open', label: 'Open', hint: 'Out of spec, nobody has signed off yet' },
  { key: 'acknowledged', label: 'Acknowledged', hint: 'Out of spec, a person accepted it' },
  {
    key: 'not_checked',
    label: 'Could not check',
    hint: 'We held a limit and could not honestly apply it — NOT a pass',
  },
];

type OriginKey = 'all' | 'approval' | 'bulk_recheck';

const ORIGINS: Array<{ key: OriginKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'approval', label: 'Reviewed at approval' },
  { key: 'bulk_recheck', label: 'Bulk re-check' },
];

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString();
}

/** The limit as it stood when this result was judged — not as it stands now. */
function snapshotText(check: ApiSpecCheck): string {
  if (!check.limit_snapshot) return '—';
  try {
    const s = JSON.parse(check.limit_snapshot);
    if (s.printed) return `${s.printed} (COA's own)`;
    if (s.text) return s.text;
    if (s.operator === 'between') return `${s.value_min}–${s.value_max} ${s.unit ?? ''}`.trim();
    if (s.operator === 'absent') return 'absent';
    const bound = s.value_max ?? s.value_min;
    return `${s.operator}${bound} ${s.unit ?? ''}`.trim();
  } catch {
    return '—';
  }
}

/**
 * The tier this result was FILED UNDER, read out of the frozen snapshot rather
 * than from the limit as it stands today (migration 0095). That is the same
 * argument the thresholds make: someone may have promoted or demoted the limit
 * since, and a register that re-labelled old rows to match today's ranking
 * would be answering a different question than the one an auditor asked.
 *
 * null for a result judged against the COA's own printed spec, and for anything
 * recorded before the tier existed — neither has a ranking to show, and
 * inventing one would be a claim about a decision nobody made.
 */
function snapshotCriticality(check: ApiSpecCheck): SpecCriticality | null {
  if (!check.limit_snapshot) return null;
  try {
    const parsed = JSON.parse(check.limit_snapshot) as { criticality?: unknown };
    return isSpecCriticality(parsed.criticality) ? parsed.criticality : null;
  } catch {
    return null;
  }
}

export function SpecAlerts() {
  const [tab, setTab] = useState<TabKey>('open');
  const [origin, setOrigin] = useState<OriginKey>('all');
  const [checks, setChecks] = useState<ApiSpecCheck[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ackOpen, setAckOpen] = useState(false);
  const [ackNote, setAckNote] = useState('');
  const [saving, setSaving] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params =
        tab === 'not_checked'
          ? ({ verdict: 'not_checked' } as const)
          : ({ verdict: 'out_of_spec', acknowledged: tab === 'open' ? '0' : '1' } as const);
      const res = await api.specChecks.list({ ...params, origin, limit: 200 });
      setChecks(res.specChecks);
      setTotal(res.total);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load the register');
    } finally {
      setLoading(false);
    }
  }, [tab, origin]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const acknowledge = async () => {
    setSaving(true);
    try {
      await api.specChecks.acknowledge([...selected], ackNote.trim() || undefined);
      setAckOpen(false);
      setAckNote('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to acknowledge');
    } finally {
      setSaving(false);
    }
  };

  const canAcknowledge = tab === 'open' && selected.size > 0;

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          mb: 1,
          flexWrap: 'wrap',
          gap: 1,
        }}
      >
        <Typography variant="h4" fontWeight={700}>
          Out of Spec
        </Typography>
        {canAcknowledge && (
          <Button variant="contained" startIcon={<AckIcon />} onClick={() => setAckOpen(true)}>
            Acknowledge {selected.size}
          </Button>
        )}
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Results that fell outside an acceptance limit. Acknowledging records that
        you have seen one and accepted it — it never changes the result.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 1,
          mb: 2,
        }}
      >
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          {TABS.map((t) => (
            <Tab
              key={t.key}
              value={t.key}
              label={<Tooltip title={t.hint} arrow><span>{t.label}</span></Tooltip>}
            />
          ))}
        </Tabs>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={origin}
          onChange={(_, v: OriginKey | null) => v && setOrigin(v)}
          aria-label="Who judged the result"
        >
          {ORIGINS.map((o) => (
            <ToggleButton key={o.key} value={o.key} sx={{ textTransform: 'none' }}>
              {o.label}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : checks.length === 0 ? (
        <EmptyState
          title={tab === 'open' ? 'Nothing out of spec' : 'Nothing here'}
          description={
            origin !== 'all'
              ? `Nothing here among results judged by ${origin === 'approval' ? 'a reviewer at approval' : 'the bulk re-check'}. Switch the filter to All to see everything.`
              : tab === 'open'
                ? 'No unacknowledged out-of-spec results. This only covers tests you hold a limit for — configure more in Settings › Spec Limits.'
                : tab === 'not_checked'
                  ? 'No results were skipped. When one is, it appears here rather than passing silently.'
                  : 'Nothing has been acknowledged yet.'
          }
        />
      ) : (
        <Paper variant="outlined">
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {tab === 'open' && <TableCell padding="checkbox" />}
                  <TableCell sx={{ fontWeight: 600 }}>Test</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Result</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Judged against</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Document</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Supplier</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>When</TableCell>
                  {tab === 'acknowledged' && <TableCell sx={{ fontWeight: 600 }}>Accepted by</TableCell>}
                  {tab === 'not_checked' && <TableCell sx={{ fontWeight: 600 }}>Why not</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {checks.map((c) => (
                  <TableRow key={c.id} hover>
                    {tab === 'open' && (
                      <TableCell padding="checkbox">
                        <Checkbox checked={selected.has(c.id)} onChange={() => toggle(c.id)} />
                      </TableCell>
                    )}
                    <TableCell>
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        {c.verdict === 'out_of_spec' ? (
                          <OutOfSpecIcon sx={{ fontSize: 16, color: 'error.main' }} />
                        ) : (
                          <NotCheckedIcon sx={{ fontSize: 16, color: 'text.secondary' }} />
                        )}
                        <span>{c.spec_test_name || c.test_name_raw}</span>
                        {c.judgement_origin === 'bulk_recheck' && (
                          <Tooltip
                            arrow
                            title={`Judged over history on ${fmtDate(c.bulk_run_at)}. Nobody reviewed this result at approval and nobody was emailed.`}
                          >
                            <Chip size="small" variant="outlined" label="Bulk re-check" />
                          </Tooltip>
                        )}
                        {(() => {
                          const tier = snapshotCriticality(c);
                          if (!tier) return null;
                          return (
                            <Tooltip
                              arrow
                              title="How this limit was ranked when the result was judged. Re-ranking it since does not change this row."
                            >
                              <Chip
                                size="small"
                                variant={tier === 'high' ? 'filled' : 'outlined'}
                                color={SPEC_CRITICALITY_COLOR[tier]}
                                label={SPEC_CRITICALITY_LABELS[tier]}
                              />
                            </Tooltip>
                          );
                        })()}
                      </Stack>
                    </TableCell>
                    <TableCell
                      sx={{ fontWeight: 700, color: c.verdict === 'out_of_spec' ? 'error.main' : 'inherit' }}
                    >
                      {c.value_raw || '—'}
                      {c.unit_raw ? ` ${c.unit_raw}` : ''}
                      <ConversionChip conversion={conversionFromSnapshot(c.limit_snapshot, c.unit_raw)} />
                    </TableCell>
                    <TableCell>
                      {snapshotText(c)}
                      {c.source === 'printed' && (
                        <Chip size="small" variant="outlined" label="COA's own" sx={{ ml: 0.5 }} />
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        size="small"
                        sx={{ textTransform: 'none', p: 0, minWidth: 0 }}
                        onClick={() => navigate(`/documents/${c.document_id}`)}
                      >
                        {c.document_title || c.document_id}
                      </Button>
                      {c.result_location && (
                        <Tooltip
                          arrow
                          title="Where on the certificate this result was printed. A certificate covering several lots lists the same test once per lot."
                        >
                          <Typography variant="caption" color="text.secondary" display="block">
                            {c.result_location}
                          </Typography>
                        </Tooltip>
                      )}
                    </TableCell>
                    <TableCell>{c.supplier_name || '—'}</TableCell>
                    <TableCell>{fmtDate(c.created_at)}</TableCell>
                    {tab === 'acknowledged' && (
                      <TableCell>
                        {c.acknowledged_by_name || '—'}
                        {c.acknowledgement_note && (
                          <Typography variant="caption" color="text.secondary" display="block">
                            {c.acknowledgement_note}
                          </Typography>
                        )}
                      </TableCell>
                    )}
                    {tab === 'not_checked' && (
                      <TableCell>
                        <Typography variant="caption" color="text.secondary">
                          {c.reason || '—'}
                        </Typography>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {total > checks.length && (
            <Typography variant="caption" color="text.secondary" sx={{ p: 1.5, display: 'block' }}>
              Showing {checks.length} of {total}.
            </Typography>
          )}
        </Paper>
      )}

      <Dialog open={ackOpen} onClose={() => setAckOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>Acknowledge {selected.size} result{selected.size === 1 ? '' : 's'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            This records that you have seen these results and accepted them. The
            results themselves do not change.
          </Typography>
          <TextField
            label="Why is this acceptable?"
            value={ackNote}
            onChange={(e) => setAckNote(e.target.value)}
            fullWidth
            multiline
            rows={3}
            placeholder="Retest confirmed within limit; supplier CAPA on file."
            helperText="Optional, but this is the sentence an auditor will read."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAckOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={acknowledge} disabled={saving}>
            Acknowledge
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default SpecAlerts;
