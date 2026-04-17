/**
 * /eval — Tinder-style A/B comparison of text vs VLM extraction.
 *
 * The reviewer sees the source document on the left and two blind-labeled
 * extraction cards ("Method A" / "Method B") on the right. They pick the
 * winner (A, B, or Tie / both wrong), optionally leave a comment, and the
 * page auto-advances to the next unevaluated doc.
 *
 * Blind labels are load-bearing — the identity of each card (text vs VLM)
 * lives only in the `a_side` value the backend sends, which we echo back on
 * submit. We never render "text" or "vlm" anywhere in the DOM for cards A/B.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  Paper,
  Stack,
  Tooltip,
  Typography,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
} from '@mui/material';
import {
  CheckCircleOutline as CheckIcon,
  BalanceOutlined as TieIcon,
  NavigateNext as NextIcon,
  AssessmentOutlined as ReportIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type {
  EvalNextResponse,
  ExtractedTable,
  ExtractionEvalSide,
  ExtractionEvalWinner,
  ProcessingQueueItem,
} from '../lib/types';
import { AUTH_TOKEN_KEY } from '../lib/types';
import PdfViewer from '../components/PdfViewer';

// ---------- parsing helpers ----------

function parseFields(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (v == null) continue;
      out[k] = String(v);
    }
    return out;
  } catch {
    return {};
  }
}

function parseTables(raw: string | null | undefined): ExtractedTable[] {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t) => t && typeof t === 'object' && Array.isArray(t.headers) && Array.isArray(t.rows)
    ) as ExtractedTable[];
  } catch {
    return [];
  }
}

/**
 * Given the queue item and which real side is labeled "A", produce both
 * cards' field+table payloads. Keys intentionally don't include "text" or
 * "vlm" — we want to ensure no blind leak via inspection.
 */
function cardPayloads(
  item: ProcessingQueueItem,
  aSide: ExtractionEvalSide
): { a: { fields: Record<string, string>; tables: ExtractedTable[] }; b: { fields: Record<string, string>; tables: ExtractedTable[] } } {
  const textPayload = {
    fields: parseFields(item.ai_fields),
    tables: parseTables(item.tables),
  };
  const vlmPayload = {
    fields: parseFields(item.vlm_extracted_fields),
    tables: parseTables(item.vlm_extracted_tables),
  };
  return aSide === 'text'
    ? { a: textPayload, b: vlmPayload }
    : { a: vlmPayload, b: textPayload };
}

// ---------- subcomponents ----------

function FieldList({ fields }: { fields: Record<string, string> }) {
  const entries = Object.entries(fields);
  if (entries.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
        No fields extracted.
      </Typography>
    );
  }
  return (
    <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'minmax(120px, 200px) 1fr', rowGap: 0.75, columnGap: 2 }}>
      {entries.map(([k, v]) => (
        <>
          <Typography key={`k-${k}`} component="dt" variant="caption" sx={{ color: 'text.secondary', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.3 }}>
            {k}
          </Typography>
          <Typography key={`v-${k}`} component="dd" variant="body2" sx={{ m: 0, wordBreak: 'break-word' }}>
            {v || <span style={{ color: '#aaa' }}>—</span>}
          </Typography>
        </>
      ))}
    </Box>
  );
}

function TableList({ tables }: { tables: ExtractedTable[] }) {
  if (tables.length === 0) return null;
  return (
    <Stack spacing={2} sx={{ mt: 2 }}>
      {tables.map((t, ti) => (
        <Box key={ti}>
          <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary', display: 'block', mb: 0.5 }}>
            {t.name || `Table ${ti + 1}`}
          </Typography>
          <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 260 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {t.headers.map((h, hi) => (
                    <TableCell key={hi} sx={{ fontWeight: 700, fontSize: '0.72rem' }}>
                      {h}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {t.rows.map((r, ri) => (
                  <TableRow key={ri} hover>
                    {r.map((c, ci) => (
                      <TableCell key={ci} sx={{ fontSize: '0.75rem', whiteSpace: 'nowrap', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {c}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Box>
      ))}
    </Stack>
  );
}

/**
 * A single blind extraction card. The only thing tying the card back to the
 * real method is the `variant` ('a' or 'b'), which the parent has already
 * laundered through the random a_side mapping before calling us.
 */
function MethodCard({
  label,
  fields,
  tables,
  selected,
  onPick,
}: {
  label: string;
  fields: Record<string, string>;
  tables: ExtractedTable[];
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <Card
      variant="outlined"
      onClick={onPick}
      sx={{
        cursor: 'pointer',
        borderColor: selected ? 'success.main' : 'divider',
        borderWidth: selected ? 2 : 1,
        transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
        '&:hover': { boxShadow: 2 },
        flex: 1,
        minWidth: 0,
      }}
    >
      <CardContent sx={{ pb: 2 }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 700 }}>
            {label}
          </Typography>
          {selected && <CheckIcon color="success" />}
        </Stack>
        <Divider sx={{ mb: 2 }} />
        <FieldList fields={fields} />
        <TableList tables={tables} />
      </CardContent>
    </Card>
  );
}

function DocPreview({ item }: { item: ProcessingQueueItem }) {
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setUrl(null);
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    fetch(`/api/queue/${item.id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error(`Preview failed (${r.status})`);
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        blobRef.current = objectUrl;
        setUrl(objectUrl);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'Preview failed'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current);
        blobRef.current = null;
      }
    };
  }, [item.id]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', flex: 1 }}>
        <CircularProgress />
      </Box>
    );
  }
  if (error || !url) {
    return (
      <Box sx={{ p: 2 }}>
        <Alert severity="warning">{error ?? 'Preview unavailable'}</Alert>
      </Box>
    );
  }

  const mime = item.mime_type || '';
  if (mime === 'application/pdf') {
    return <PdfViewer url={url} fileName={item.file_name} />;
  }
  if (mime.startsWith('image/')) {
    return (
      <Box sx={{ p: 2, display: 'flex', justifyContent: 'center', alignItems: 'flex-start', overflow: 'auto', flex: 1 }}>
        <img
          src={url}
          alt={item.file_name}
          style={{ maxWidth: '100%', maxHeight: '90vh', objectFit: 'contain' }}
        />
      </Box>
    );
  }
  return (
    <Box sx={{ p: 2 }}>
      <Alert severity="info">
        Inline preview not supported for {mime || 'this file type'}.{' '}
        <a href={url} target="_blank" rel="noopener noreferrer">Open file in new tab.</a>
      </Alert>
    </Box>
  );
}

// ---------- the page ----------

export default function Eval() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<EvalNextResponse | null>(null);
  const [comment, setComment] = useState('');
  const [tentativeWinner, setTentativeWinner] = useState<ExtractionEvalWinner | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchNext = useCallback(async () => {
    setLoading(true);
    setError(null);
    setComment('');
    setTentativeWinner(null);
    try {
      const next = await api.eval.next();
      setData(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load next doc');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchNext();
  }, [fetchNext]);

  const payloads = useMemo(() => {
    if (!data?.item || !data.a_side) return null;
    return cardPayloads(data.item, data.a_side);
  }, [data]);

  const submit = useCallback(
    async (winner: ExtractionEvalWinner) => {
      if (!data?.item || !data.a_side || submitting) return;
      setSubmitting(true);
      setTentativeWinner(winner);
      try {
        await api.eval.submit(data.item.id, {
          winner,
          a_side: data.a_side,
          comment: comment.trim() || undefined,
        });
        await fetchNext();
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to submit evaluation');
        setTentativeWinner(null);
      } finally {
        setSubmitting(false);
      }
    },
    [data, comment, submitting, fetchNext]
  );

  // ---------- render ----------

  if (loading && !data) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '70vh' }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error && !data) {
    return (
      <Box sx={{ p: 4 }}>
        <Alert severity="error">{error}</Alert>
        <Button sx={{ mt: 2 }} variant="outlined" onClick={fetchNext}>
          Retry
        </Button>
      </Box>
    );
  }

  // Completion screen
  if (data && (!data.item || data.remaining === 0)) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', p: 6, minHeight: '70vh' }}>
        <CheckIcon color="success" sx={{ fontSize: 64, mb: 2 }} />
        <Typography variant="h4" sx={{ fontWeight: 700, mb: 1 }}>
          All done!
        </Typography>
        <Typography variant="body1" color="text.secondary" sx={{ mb: 3 }}>
          {data.total === 0
            ? 'No documents are ready for A/B evaluation yet. Once the worker finishes extracting both methods on a queue item, it will show up here.'
            : `You evaluated ${data.total} of ${data.total} eligible documents.`}
        </Typography>
        <Stack direction="row" spacing={2}>
          <Button
            component={RouterLink}
            to="/eval/report"
            variant="contained"
            startIcon={<ReportIcon />}
          >
            View report
          </Button>
          <Button variant="outlined" onClick={fetchNext}>
            Refresh
          </Button>
        </Stack>
      </Box>
    );
  }

  if (!data || !data.item || !payloads) {
    return null;
  }

  const item = data.item;
  const { a, b } = payloads;

  const currentIndex = data.total - data.remaining + 1;
  const progressPct = data.total > 0 ? ((currentIndex - 1) / data.total) * 100 : 0;

  const commonBtnSx = { minWidth: 140, fontWeight: 700 };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 64px)', bgcolor: 'background.default' }}>
      {/* Top progress bar */}
      <Box sx={{ px: 3, py: 1.5, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'background.paper' }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Extraction A/B evaluation
          </Typography>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" color="text.secondary">
              Doc {currentIndex} of {data.total}
            </Typography>
            <Button
              component={RouterLink}
              to="/eval/report"
              size="small"
              startIcon={<ReportIcon />}
              variant="outlined"
            >
              Report
            </Button>
          </Stack>
        </Stack>
        <LinearProgress variant="determinate" value={progressPct} sx={{ height: 6, borderRadius: 1 }} />
      </Box>

      <Box sx={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left: doc preview */}
        <Box sx={{ width: '50%', borderRight: '1px solid', borderColor: 'divider', display: 'flex', flexDirection: 'column', bgcolor: 'background.paper' }}>
          <Box sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
            <Typography variant="body2" sx={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {item.file_name}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {item.supplier ?? 'Unknown supplier'}
              {item.document_type_name ? ` · ${item.document_type_name}` : ''}
            </Typography>
          </Box>
          <Box sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
            <DocPreview item={item} />
          </Box>
        </Box>

        {/* Right: two method cards + controls */}
        <Box sx={{ width: '50%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <Box sx={{ flex: 1, overflow: 'auto', p: 2 }}>
            <Stack direction={{ xs: 'column', lg: 'row' }} spacing={2} alignItems="stretch">
              <MethodCard
                label="Method A"
                fields={a.fields}
                tables={a.tables}
                selected={tentativeWinner === 'a'}
                onPick={() => !submitting && submit('a')}
              />
              <MethodCard
                label="Method B"
                fields={b.fields}
                tables={b.tables}
                selected={tentativeWinner === 'b'}
                onPick={() => !submitting && submit('b')}
              />
            </Stack>
          </Box>

          {/* Bottom action bar */}
          <Box sx={{ borderTop: '1px solid', borderColor: 'divider', p: 2, bgcolor: 'background.paper' }}>
            {error && (
              <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
            <Stack direction="row" spacing={1.5} sx={{ mb: 2 }} justifyContent="center">
              <Button
                variant="contained"
                color="success"
                size="large"
                sx={commonBtnSx}
                disabled={submitting}
                onClick={() => submit('a')}
              >
                A wins
              </Button>
              <Button
                variant="contained"
                color="success"
                size="large"
                sx={commonBtnSx}
                disabled={submitting}
                onClick={() => submit('b')}
              >
                B wins
              </Button>
              <Button
                variant="contained"
                size="large"
                sx={{ ...commonBtnSx, bgcolor: 'grey.600', '&:hover': { bgcolor: 'grey.700' } }}
                startIcon={<TieIcon />}
                disabled={submitting}
                onClick={() => submit('tie')}
              >
                Tie / both wrong
              </Button>
            </Stack>
            <TextField
              fullWidth
              multiline
              minRows={1}
              maxRows={3}
              size="small"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder='Optional: why? (e.g., "A got the lot number right, B hallucinated")'
              disabled={submitting}
              inputProps={{ maxLength: 2000 }}
            />
            <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1 }}>
              <Typography variant="caption" color="text.secondary">
                Picking a side auto-advances. Blind-labeled — you'll see which method won on the report.
              </Typography>
              <Tooltip title="Skip to next doc (no evaluation recorded)">
                <span>
                  <IconButton
                    size="small"
                    onClick={fetchNext}
                    disabled={submitting}
                  >
                    <NextIcon />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
