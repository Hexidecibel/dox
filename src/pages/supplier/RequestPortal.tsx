/**
 * /r/:token — the page a supplier opens when we ask them for documents.
 *
 * They have no account and will never have one. They got a message, they
 * tapped a link, and they are probably standing at a bench with a phone. That
 * is the whole design brief:
 *
 *   - MOBILE IS THE PRIMARY CASE, not the responsive afterthought. Single
 *     column at every width, controls sized for a thumb, the file input opens
 *     the camera roll, and nothing depends on hover.
 *   - NO TRAINING, NO MANUAL. Every item says what it is in plain language,
 *     what formats are acceptable, and what will be checked. If a supplier has
 *     to be told how to use this page, the page is wrong.
 *   - THE PROGRESS NUMBER COUNTS SATISFIED ITEMS, NEVER FILES. The server
 *     decides that (see `SupplierRequestProgress`); this component must never
 *     compute its own count from `history.length`, which is the flattering
 *     number and would undo the point.
 *
 * The server decides what may be shown — `buildSupplierRequestView` in
 * functions/lib/document-requests.ts is an allow-list. This component renders
 * the allow-listed payload and must never fetch a second endpoint to fill in a
 * field that is missing on purpose.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Collapse,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  TextField,
  Typography,
  alpha,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked';
import TaskAltIcon from '@mui/icons-material/TaskAlt';
import type {
  RequestLineStatus,
  SupplierRequestItem,
  SupplierRequestView,
  SupplierUploadResult,
} from '../../lib/types';

const ACCENT = '#1A365D';
const GOOD = '#1B5E20';
const WARN = '#8B5A00';
const DANGER = '#8B1A1A';

/** Every mime the server will take, so the picker offers the right things. */
const ACCEPT =
  'application/pdf,image/*,.pdf,.jpg,.jpeg,.png,.heic,.heif,.webp,.tif,.tiff,.doc,.docx,.xls,.xlsx,.txt,.csv';

/**
 * How each state reads to the person who has to act on it.
 *
 * Worded from THEIR side of the relationship, not ours. 'under_review' is not
 * "under review" — it is "with us, nothing for you to do", which is the actual
 * information they came for and the reason they do not phone to ask.
 */
const STATUS_UI: Record<
  RequestLineStatus,
  { label: string; color: string; icon: JSX.Element; theirMove: boolean }
> = {
  not_started: {
    label: 'Not sent yet',
    color: '#666',
    icon: <RadioButtonUncheckedIcon fontSize="small" />,
    theirMove: true,
  },
  received: {
    label: 'Received — with us',
    color: ACCENT,
    icon: <HourglassTopIcon fontSize="small" />,
    theirMove: false,
  },
  under_review: {
    label: 'Being checked — nothing needed from you',
    color: ACCENT,
    icon: <HourglassTopIcon fontSize="small" />,
    theirMove: false,
  },
  accepted: {
    label: 'Accepted',
    color: GOOD,
    icon: <CheckCircleIcon fontSize="small" />,
    theirMove: false,
  },
  needs_attention: {
    label: 'Needs a new version',
    color: DANGER,
    icon: <ErrorOutlineIcon fontSize="small" />,
    theirMove: true,
  },
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso.includes('T') || iso.length > 10 ? iso : `${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * How the deadline reads. Honest in both directions: a date that has passed
 * says so, because a page that quietly stops mentioning an overdue deadline is
 * a page nobody trusts the second time.
 */
function dueText(due: string | null): { text: string; tone: string } {
  if (!due) return { text: 'No deadline set', tone: '#666' };
  const d = new Date(due.length === 10 ? `${due}T00:00:00` : due);
  if (Number.isNaN(d.getTime())) return { text: due, tone: '#666' };
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  if (days < 0) {
    return {
      text: `Was due ${formatDate(due)} — ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ago. You can still send it.`,
      tone: DANGER,
    };
  }
  if (days === 0) return { text: `Due today, ${formatDate(due)}`, tone: WARN };
  if (days <= 7) return { text: `Due ${formatDate(due)} — in ${days} day${days === 1 ? '' : 's'}`, tone: WARN };
  return { text: `Due ${formatDate(due)}`, tone: '#444' };
}

export function SupplierRequestPortal() {
  const { token } = useParams<{ token: string }>();
  const [view, setView] = useState<SupplierRequestView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refs of the items the pending file is claimed against.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [results, setResults] = useState<SupplierUploadResult[]>([]);
  const [label, setLabel] = useState('');
  const batchInput = useRef<HTMLInputElement | null>(null);
  const lineInput = useRef<HTMLInputElement | null>(null);
  const lineTarget = useRef<string | null>(null);

  const load = useCallback(async () => {
    if (!token) {
      setError('This link is not valid.');
      setLoading(false);
      return;
    }
    try {
      const res = await fetch(`/api/supplier-requests/public/${encodeURIComponent(token)}`);
      if (!res.ok) {
        setError(
          res.status === 429
            ? 'Too many requests just now. Wait a moment and refresh.'
            : 'This link has expired or is no longer valid. Reply to the message that brought you here and we will send a new one.',
        );
        setView(null);
        return;
      }
      setView((await res.json()) as SupplierRequestView);
      setError(null);
    } catch {
      setError('We could not load this page. Check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = view?.items ?? [];
  const byRef = useMemo(() => new Map(items.map((i) => [i.ref, i])), [items]);

  /**
   * Ticking one item pre-ticks the ones this supplier's own paperwork has
   * closed alongside it.
   *
   * THIS IS THE POINT OF THE PAGE, and it happens BEFORE the upload rather
   * than after. `also_covers` is evidence from their own confirmed documents,
   * computed server-side; the alternative — making them find and tick seven
   * boxes themselves — is work we would have moved onto them and then
   * congratulated ourselves for saving them.
   *
   * Suggestions are pre-ticked, not forced: unticking one is a plain checkbox,
   * and un-ticking the item that pulled them in does not rip them back out,
   * because a supplier who deliberately added an item should not lose it to a
   * side effect.
   */
  const toggle = (ref: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(ref)) {
        next.delete(ref);
      } else {
        next.add(ref);
        for (const also of byRef.get(ref)?.also_covers ?? []) next.add(also);
      }
      return next;
    });
  };

  const suggestedCount = useMemo(() => {
    let n = 0;
    for (const ref of selected) if ((byRef.get(ref)?.also_covers.length ?? 0) > 0) n += 1;
    return n;
  }, [selected, byRef]);

  const send = async (files: File[], refs: string[]) => {
    if (!token || files.length === 0 || refs.length === 0) return;
    setUploading(true);
    setUploadError(null);
    const done: SupplierUploadResult[] = [];
    try {
      // One request per file. A single multipart body with five phone photos in
      // it is the shape that fails on a plant's 4G, and a per-file request means
      // four successes and one retry rather than five losses.
      for (const file of files) {
        const body = new FormData();
        body.append('file', file);
        body.append('item_refs', JSON.stringify(refs));
        if (label.trim()) body.append('uploader_label', label.trim());
        const res = await fetch(
          `/api/supplier-requests/public/${encodeURIComponent(token)}/upload`,
          { method: 'POST', body },
        );
        const payload = (await res.json().catch(() => null)) as
          | SupplierUploadResult
          | { error?: string }
          | null;
        if (!res.ok) {
          setUploadError(
            (payload && 'error' in payload && payload.error) ||
              'That upload did not go through. Please try again.',
          );
          break;
        }
        done.push(payload as SupplierUploadResult);
      }
    } catch {
      setUploadError('That upload did not go through. Check your connection and try again.');
    } finally {
      setUploading(false);
    }
    if (done.length > 0) {
      setResults(done);
      setPending([]);
      setSelected(new Set());
      if (batchInput.current) batchInput.current.value = '';
      if (lineInput.current) lineInput.current.value = '';
      await load();
    }
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 10 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error || !view) {
    return (
      <Box sx={{ maxWidth: 640, mx: 'auto', p: 3 }}>
        <Alert severity="warning" sx={{ fontSize: '1rem' }}>
          {error ?? 'This link is no longer available.'}
        </Alert>
      </Box>
    );
  }

  const due = dueText(view.due_date);
  const pct =
    view.progress.required_total > 0
      ? (view.progress.required_satisfied / view.progress.required_total) * 100
      : 0;

  return (
    <Box
      sx={{
        maxWidth: 720,
        mx: 'auto',
        px: { xs: 2, sm: 3 },
        py: { xs: 3, sm: 5 },
        pb: 12,
      }}
    >
      {/* ── Who is asking, of whom, and by when ───────────────────────── */}
      <Typography variant="overline" sx={{ color: ACCENT, letterSpacing: 1 }}>
        {view.tenant_name} — document request
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 700, mt: 0.5, lineHeight: 1.25 }}>
        {view.title}
      </Typography>
      <Typography variant="body2" sx={{ color: '#555', mt: 0.5 }}>
        For {view.supplier_name}
      </Typography>
      <Typography variant="body2" sx={{ color: due.tone, fontWeight: 600, mt: 1.5 }}>
        {due.text}
      </Typography>
      {view.amended && (
        <Alert severity="info" sx={{ mt: 2 }}>
          This list has been updated since it was first sent. What you see here is the
          current version.
        </Alert>
      )}
      {view.intro && (
        <Typography variant="body1" sx={{ mt: 2, whiteSpace: 'pre-wrap', color: '#333' }}>
          {view.intro}
        </Typography>
      )}

      {/* ── Progress: SATISFIED ITEMS, never files ────────────────────── */}
      <Paper variant="outlined" sx={{ p: 2.5, mt: 3, borderRadius: 2 }}>
        {view.complete ? (
          <Stack direction="row" spacing={1.5} alignItems="center">
            <TaskAltIcon sx={{ color: GOOD }} />
            <Box>
              <Typography sx={{ fontWeight: 700, color: GOOD }}>
                Everything is in. Nothing further is needed from you.
              </Typography>
              <Typography variant="body2" sx={{ color: '#555' }}>
                All {view.progress.required_total} required item
                {view.progress.required_total === 1 ? ' has' : 's have'} been accepted. Your
                record of what you sent stays on this page.
              </Typography>
            </Box>
          </Stack>
        ) : (
          <>
            <Stack direction="row" justifyContent="space-between" alignItems="baseline">
              <Typography sx={{ fontWeight: 700 }}>
                {view.progress.required_satisfied} of {view.progress.required_total} accepted
              </Typography>
              <Typography variant="caption" sx={{ color: '#666' }}>
                required items
              </Typography>
            </Stack>
            <LinearProgress
              variant="determinate"
              value={pct}
              sx={{
                mt: 1.5,
                height: 10,
                borderRadius: 5,
                bgcolor: alpha(ACCENT, 0.12),
                '& .MuiLinearProgress-bar': { bgcolor: GOOD, borderRadius: 5 },
              }}
            />
            <Typography variant="caption" sx={{ color: '#666', display: 'block', mt: 1 }}>
              This counts items we have accepted, not files received — so it only moves once
              someone here has checked what you sent.
            </Typography>
            {view.progress.recommended_total > 0 && (
              <Typography variant="caption" sx={{ color: '#666', display: 'block' }}>
                Plus {view.progress.recommended_satisfied} of{' '}
                {view.progress.recommended_total} optional item
                {view.progress.recommended_total === 1 ? '' : 's'}.
              </Typography>
            )}
          </>
        )}
      </Paper>

      {/* ── The moment ────────────────────────────────────────────────── */}
      {results.length > 0 && (
        <Alert
          icon={<TaskAltIcon fontSize="inherit" />}
          severity="success"
          sx={{ mt: 2, fontSize: '1rem' }}
          onClose={() => setResults([])}
        >
          <Stack spacing={0.5}>
            {results.map((r, i) => (
              <Typography key={i} sx={{ fontWeight: r.covered_count > 1 ? 700 : 400 }}>
                {r.message}
              </Typography>
            ))}
          </Stack>
        </Alert>
      )}
      {uploadError && (
        <Alert severity="error" sx={{ mt: 2 }} onClose={() => setUploadError(null)}>
          {uploadError}
        </Alert>
      )}

      {/* ── The checklist ─────────────────────────────────────────────── */}
      <Typography variant="h6" sx={{ mt: 4, mb: 1, fontWeight: 700 }}>
        What we are asking for
      </Typography>
      <Stack spacing={1.5}>
        {items.map((item) => (
          <ItemCard
            key={item.ref}
            item={item}
            checked={selected.has(item.ref)}
            selectable={view.accepting_uploads}
            onToggle={() => toggle(item.ref)}
            onUploadHere={() => {
              lineTarget.current = item.ref;
              lineInput.current?.click();
            }}
          />
        ))}
      </Stack>

      {/* Per-line upload. One hidden input reused, so a targeted fix is one tap
          from the item it fixes rather than a trip back up to the batch box. */}
      <input
        ref={lineInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const ref = lineTarget.current;
          if (files.length > 0 && ref) {
            // ONLY this item. The batch control pre-ticks siblings, but it does
            // so VISIBLY — the boxes move and can be unticked. This button says
            // "just for this", and silently claiming six more items behind a
            // label that promises one would be the page being clever at the
            // supplier's expense. Targeted means targeted.
            void send(files, [ref]);
          }
        }}
      />

      {/* ── Batch upload ──────────────────────────────────────────────── */}
      {view.accepting_uploads ? (
        <Paper
          variant="outlined"
          sx={{ p: 2.5, mt: 3, borderRadius: 2, borderColor: alpha(ACCENT, 0.35) }}
        >
          <Typography sx={{ fontWeight: 700 }}>Send documents</Typography>
          <Typography variant="body2" sx={{ color: '#555', mt: 0.5 }}>
            Tick every item a file covers, then attach it. One document can cover several
            items — you only need to send it once.
          </Typography>

          {suggestedCount > 0 && (
            <Alert severity="info" sx={{ mt: 1.5 }}>
              We ticked the other items your documents have covered before. Untick anything
              that does not apply.
            </Alert>
          )}

          <TextField
            fullWidth
            size="medium"
            label="Your name (optional)"
            placeholder="So we know who to thank"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            sx={{ mt: 2 }}
          />

          <input
            ref={batchInput}
            type="file"
            accept={ACCEPT}
            multiple
            hidden
            onChange={(e) => setPending(Array.from(e.target.files ?? []))}
          />

          <Button
            fullWidth
            size="large"
            variant="outlined"
            startIcon={<CloudUploadIcon />}
            onClick={() => batchInput.current?.click()}
            sx={{ mt: 2, py: 1.5, fontSize: '1rem' }}
          >
            {pending.length > 0
              ? `${pending.length} file${pending.length === 1 ? '' : 's'} chosen`
              : 'Choose files or take a photo'}
          </Button>

          <Collapse in={pending.length > 0}>
            <Stack spacing={0.5} sx={{ mt: 1.5 }}>
              {pending.map((f) => (
                <Typography key={f.name} variant="body2" sx={{ color: '#555' }}>
                  {f.name} · {formatSize(f.size)}
                </Typography>
              ))}
            </Stack>
          </Collapse>

          <Button
            fullWidth
            size="large"
            variant="contained"
            disabled={uploading || pending.length === 0 || selected.size === 0}
            onClick={() => void send(pending, [...selected])}
            sx={{ mt: 2, py: 1.75, fontSize: '1rem', bgcolor: ACCENT }}
          >
            {uploading
              ? 'Sending…'
              : selected.size === 0
                ? 'Tick the items these files cover'
                : `Send for ${selected.size} item${selected.size === 1 ? '' : 's'}`}
          </Button>
          {uploading && <LinearProgress sx={{ mt: 1 }} />}
        </Paper>
      ) : (
        <Alert severity="info" sx={{ mt: 3 }}>
          This request is closed, so it is no longer taking files. Everything you sent is
          still listed below.
        </Alert>
      )}

      {/* ── Their own history ─────────────────────────────────────────── */}
      <Typography variant="h6" sx={{ mt: 4, mb: 1, fontWeight: 700 }}>
        What you have sent
      </Typography>
      {view.history.length === 0 ? (
        <Typography variant="body2" sx={{ color: '#666' }}>
          Nothing yet.
        </Typography>
      ) : (
        <Stack spacing={1}>
          {view.history.map((h, i) => (
            <Paper key={i} variant="outlined" sx={{ p: 1.75, borderRadius: 2 }}>
              <Typography sx={{ fontWeight: 600, wordBreak: 'break-all' }}>
                {h.file_name}
              </Typography>
              <Typography variant="caption" sx={{ color: '#666' }}>
                {formatDate(h.uploaded_at)} · {formatSize(h.size_bytes)}
                {h.uploader_label ? ` · sent by ${h.uploader_label}` : ''}
              </Typography>
              {h.covered_items.length > 0 && (
                <Box sx={{ mt: 1, display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
                  {h.covered_items.map((name) => (
                    <Chip key={name} label={name} size="small" variant="outlined" />
                  ))}
                </Box>
              )}
            </Paper>
          ))}
        </Stack>
      )}

      <Divider sx={{ mt: 5, mb: 2 }} />
      <Typography variant="caption" sx={{ color: '#888', display: 'block' }}>
        This link works until {formatDate(view.link_expires_at)}. If it stops working, reply
        to the message that brought you here and we will send a new one.
      </Typography>
    </Box>
  );
}

/**
 * One checklist item.
 *
 * Everything a supplier needs in order to answer it is on the card: what it is
 * in their language, one sentence of why, the formats we can read, what will be
 * checked, where it stands, and — when it has come back to them — what was
 * wrong and what the replacement must contain. The last of those is never the
 * bare word "rejected"; the server guarantees a sentence.
 */
function ItemCard({
  item,
  checked,
  selectable,
  onToggle,
  onUploadHere,
}: {
  item: SupplierRequestItem;
  checked: boolean;
  selectable: boolean;
  onToggle: () => void;
  onUploadHere: () => void;
}) {
  const ui = STATUS_UI[item.status];
  const attention = item.status === 'needs_attention';

  return (
    <Paper
      variant="outlined"
      sx={{
        p: 2,
        borderRadius: 2,
        borderColor: attention ? alpha(DANGER, 0.5) : undefined,
        borderWidth: attention ? 2 : 1,
        bgcolor: checked ? alpha(ACCENT, 0.04) : undefined,
      }}
    >
      <Stack direction="row" spacing={1} alignItems="flex-start">
        {selectable && (
          <Checkbox
            checked={checked}
            onChange={onToggle}
            sx={{ mt: -0.75, ml: -1 }}
            inputProps={{ 'aria-label': `This file covers ${item.name}` }}
          />
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            flexWrap="wrap"
            useFlexGap
            sx={{ rowGap: 0.5 }}
          >
            <Typography sx={{ fontWeight: 700 }}>{item.name}</Typography>
            {item.tier === 'recommended' && (
              <Chip label="Optional" size="small" variant="outlined" />
            )}
          </Stack>

          <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75 }}>
            <Box sx={{ color: ui.color, display: 'flex' }}>{ui.icon}</Box>
            <Typography variant="body2" sx={{ color: ui.color, fontWeight: 600 }}>
              {ui.label}
            </Typography>
            {item.received_count > 0 && (
              <Typography variant="caption" sx={{ color: '#777' }}>
                · {item.received_count} file{item.received_count === 1 ? '' : 's'} sent
              </Typography>
            )}
          </Stack>

          {attention && item.attention_reason && (
            <Alert severity="error" sx={{ mt: 1.25, py: 0.5 }}>
              {item.attention_reason}
            </Alert>
          )}

          {item.explanation && (
            <Typography variant="body2" sx={{ mt: 1, color: '#444' }}>
              {item.explanation}
            </Typography>
          )}
          {item.acceptable_formats && (
            <Typography variant="body2" sx={{ mt: 0.75, color: '#555' }}>
              <strong>Accepted formats:</strong> {item.acceptable_formats}
            </Typography>
          )}
          {item.criteria && (
            <Typography variant="body2" sx={{ mt: 0.5, color: '#555' }}>
              <strong>We will check:</strong> {item.criteria}
            </Typography>
          )}
          {/* Migration 0119. Said plainly to the person uploading, because the
              expensive alternative is us detecting a 36-page packet afterwards
              and asking one of our own people to carve it into 25 documents. */}
          {item.one_document_per_file && (
            <Typography variant="body2" sx={{ mt: 0.5, color: '#555' }}>
              <strong>Send this on its own:</strong> one document per file, please — not combined
              with other documents into a single PDF.
            </Typography>
          )}
          {checked && item.also_covers.length > 0 && (
            <Typography variant="caption" sx={{ mt: 1, display: 'block', color: ACCENT }}>
              Ticking this also ticked {item.also_covers.length} other item
              {item.also_covers.length === 1 ? '' : 's'} your documents have covered before.
            </Typography>
          )}

          {selectable && (
            <Button
              size="small"
              startIcon={<CloudUploadIcon />}
              onClick={onUploadHere}
              sx={{ mt: 1.25, ml: -1 }}
            >
              {attention ? 'Send a replacement for this' : 'Send a file just for this'}
            </Button>
          )}
        </Box>
      </Stack>
    </Paper>
  );
}
