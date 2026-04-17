/**
 * /eval/report — Aggregate results for the A/B extraction eval flow.
 *
 * Unblinds the Method A / Method B labels: shows text vs VLM win totals,
 * per-supplier and per-doctype breakdowns, and a list of all reviewer
 * comments. Also lets the user export a flat CSV of every evaluation for
 * offline analysis.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import {
  Download as DownloadIcon,
  ArrowBack as BackIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type {
  EvalReportResponse,
  EvalReportBreakdownRow,
} from '../lib/types';

function pct(num: number, denom: number): string {
  if (denom === 0) return '0%';
  return `${Math.round((num / denom) * 100)}%`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleString();
}

function winnerFor(row: EvalReportBreakdownRow): 'text' | 'vlm' | 'tie' {
  if (row.text_wins > row.vlm_wins) return 'text';
  if (row.vlm_wins > row.text_wins) return 'vlm';
  return 'tie';
}

function Summary({ totals }: { totals: EvalReportResponse['totals'] }) {
  const big = { fontWeight: 800, fontSize: { xs: '2rem', md: '2.5rem' }, lineHeight: 1 };
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 700, letterSpacing: 1 }}>
        Headline
      </Typography>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={3} alignItems="center" sx={{ mt: 1 }}>
        <Box sx={{ flex: 1, textAlign: 'center' }}>
          <Typography sx={big} color="primary">
            {totals.text_wins}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            Text wins
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {pct(totals.text_wins, totals.evaluated)} of evaluated
          </Typography>
        </Box>
        <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
        <Box sx={{ flex: 1, textAlign: 'center' }}>
          <Typography sx={big} color="secondary">
            {totals.vlm_wins}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            VLM wins
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {pct(totals.vlm_wins, totals.evaluated)} of evaluated
          </Typography>
        </Box>
        <Divider orientation="vertical" flexItem sx={{ display: { xs: 'none', sm: 'block' } }} />
        <Box sx={{ flex: 1, textAlign: 'center' }}>
          <Typography sx={big} color="text.secondary">
            {totals.ties}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>
            Tie / both wrong
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {pct(totals.ties, totals.evaluated)} of evaluated
          </Typography>
        </Box>
      </Stack>
      <Box sx={{ mt: 3 }}>
        <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
            Progress
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {totals.evaluated} / {totals.total} evaluated ({totals.remaining} remaining)
          </Typography>
        </Stack>
        <LinearProgress
          variant="determinate"
          value={totals.total === 0 ? 0 : (totals.evaluated / totals.total) * 100}
          sx={{ height: 8, borderRadius: 1 }}
        />
      </Box>
    </Paper>
  );
}

function BreakdownTable({
  title,
  rows,
  keyLabel,
}: {
  title: string;
  rows: EvalReportBreakdownRow[];
  keyLabel: string;
}) {
  if (rows.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          No evaluations yet.
        </Typography>
      </Paper>
    );
  }

  return (
    <Paper variant="outlined">
      <Box sx={{ p: 2, pb: 0 }}>
        <Typography variant="h6" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
      </Box>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 700 }}>{keyLabel}</TableCell>
              <TableCell align="right" sx={{ fontWeight: 700 }}>Text wins</TableCell>
              <TableCell align="right" sx={{ fontWeight: 700 }}>VLM wins</TableCell>
              <TableCell align="right" sx={{ fontWeight: 700 }}>Ties</TableCell>
              <TableCell align="right" sx={{ fontWeight: 700 }}>Winner</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => {
              const winner = winnerFor(r);
              const total = r.text_wins + r.vlm_wins + r.ties;
              return (
                <TableRow key={r.key || '(unknown)'} hover>
                  <TableCell sx={{ fontWeight: 500 }}>
                    {r.key || <span style={{ color: '#999', fontStyle: 'italic' }}>(unknown)</span>}{' '}
                    <Typography component="span" variant="caption" color="text.secondary">
                      · {total} eval{total === 1 ? '' : 's'}
                    </Typography>
                  </TableCell>
                  <TableCell align="right">{r.text_wins}</TableCell>
                  <TableCell align="right">{r.vlm_wins}</TableCell>
                  <TableCell align="right">{r.ties}</TableCell>
                  <TableCell align="right">
                    <Chip
                      size="small"
                      label={winner === 'tie' ? 'Tie' : winner.toUpperCase()}
                      color={winner === 'text' ? 'primary' : winner === 'vlm' ? 'secondary' : 'default'}
                      sx={{ fontWeight: 700, minWidth: 52 }}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

function CommentsList({ comments }: { comments: EvalReportResponse['comments'] }) {
  if (comments.length === 0) {
    return (
      <Paper variant="outlined" sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 700, mb: 1 }}>
          Comments
        </Typography>
        <Typography variant="body2" color="text.secondary">
          No reviewer comments yet.
        </Typography>
      </Paper>
    );
  }
  return (
    <Paper variant="outlined" sx={{ p: 3 }}>
      <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>
        Comments <Typography component="span" variant="body2" color="text.secondary">({comments.length})</Typography>
      </Typography>
      <Stack spacing={2} divider={<Divider flexItem />}>
        {comments.map((c, i) => (
          <Box key={`${c.queue_item_id}-${i}`}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5, flexWrap: 'wrap' }}>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {c.file_name}
              </Typography>
              <Chip
                size="small"
                label={
                  c.winning_side === 'text'
                    ? 'Text won'
                    : c.winning_side === 'vlm'
                    ? 'VLM won'
                    : 'Tie'
                }
                color={c.winning_side === 'text' ? 'primary' : c.winning_side === 'vlm' ? 'secondary' : 'default'}
                sx={{ fontWeight: 700 }}
              />
              <Typography variant="caption" color="text.secondary">
                {c.evaluator_name ?? '—'} · {formatDate(c.evaluated_at)}
              </Typography>
            </Stack>
            <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
              {c.comment}
            </Typography>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

/**
 * Build a CSV of every evaluation row. Keeps the blind (a_side) and unblind
 * (winning_side) columns both so downstream analysis can verify the logic.
 */
function evaluationsToCsv(evals: EvalReportResponse['evaluations']): string {
  const header = [
    'queue_item_id',
    'file_name',
    'supplier',
    'document_type',
    'a_side',
    'winner',
    'winning_side',
    'evaluator',
    'evaluated_at',
    'comment',
  ];
  const esc = (v: string | number | null | undefined): string => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const rows = evals.map((e) =>
    [
      e.queue_item_id,
      e.file_name,
      e.supplier ?? '',
      e.document_type_name ?? '',
      e.a_side,
      e.winner,
      e.winning_side ?? 'tie',
      e.evaluator_name ?? '',
      new Date(e.evaluated_at).toISOString(),
      e.comment ?? '',
    ].map(esc).join(',')
  );
  return [header.join(','), ...rows].join('\n');
}

export default function EvalReport() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<EvalReportResponse | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.eval.report();
      setData(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleExport = () => {
    if (!data) return;
    const csv = evaluationsToCsv(data.evaluations);
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `extraction-evaluations-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const headline = useMemo(() => {
    if (!data) return '';
    const t = data.totals;
    if (t.evaluated === 0) return 'No evaluations submitted yet.';
    return `Text: ${t.text_wins} wins · VLM: ${t.vlm_wins} wins · Tie: ${t.ties}`;
  }, [data]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Alert severity="error">{error}</Alert>
        <Button onClick={load} sx={{ mt: 2 }} variant="outlined">Retry</Button>
      </Box>
    );
  }

  if (!data) return null;

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            Extraction A/B report
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {headline}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button
            component={RouterLink}
            to="/eval"
            startIcon={<BackIcon />}
            variant="outlined"
          >
            Back to eval
          </Button>
          <Button
            startIcon={<DownloadIcon />}
            variant="contained"
            onClick={handleExport}
            disabled={data.evaluations.length === 0}
          >
            Export CSV
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={3}>
        <Summary totals={data.totals} />
        <Card variant="outlined">
          <CardContent>
            <Typography variant="body2" color="text.secondary">
              Labels were blinded during evaluation (Method A / Method B). The report below unblinds
              them using the stored randomized mapping: "Text" is the Qwen3-8B text/OCR pipeline,
              "VLM" is the Qwen2.5-VL-7B vision pipeline.
            </Typography>
          </CardContent>
        </Card>
        <BreakdownTable title="By supplier" rows={data.by_supplier} keyLabel="Supplier" />
        <BreakdownTable title="By document type" rows={data.by_doctype} keyLabel="Document type" />
        <CommentsList comments={data.comments} />
      </Stack>
    </Box>
  );
}
