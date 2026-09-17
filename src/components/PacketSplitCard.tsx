/**
 * "This looks like N documents in one file." (migration 0118)
 *
 * WHERE IT SITS AND WHY. At the TOP of the review card, above the extracted
 * fields — because if the file really is twenty-five documents then every field
 * below it is page 3's answer standing in for the other twenty-four, and a
 * reviewer who reads those first has already been misled. This is the question
 * that has to be settled before the card is worth reading.
 *
 * THREE ACTIONS, AND NOTHING HAPPENS WITHOUT ONE:
 *   Split into N documents   confirm the proposal as it stands
 *   Adjust                   edit the ranges first — merge two parts, move a
 *                            boundary, drop a part — then confirm those
 *   Not a packet             dismiss; remembered on the item, never asked again
 *
 * A reviewer who ignores all three loses nothing: the ordinary single-document
 * flow underneath is untouched, and the card can be approved exactly as it
 * could before.
 *
 * WHAT IT SHOWS ABOUT ITS OWN CONFIDENCE. The band is stated in words, not
 * implied by tone. A high-confidence proposal came from the file's own table of
 * contents; a low-confidence one came from page layout with the signals
 * disagreeing, and says so, because a reviewer deciding whether to check every
 * boundary needs to know which of those they are looking at.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import CallMergeIcon from '@mui/icons-material/CallMerge';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { api } from '../lib/api';
import { AUTH_TOKEN_KEY } from '../lib/types';
import type { PacketPart, QueuePacketView } from '../../shared/types';

/** A row in the Adjust editor. Kept separate from PacketPart so an in-progress edit is never mistaken for a proposal. */
interface EditRow {
  from: number;
  to: number;
  label: string | null;
  preview: string;
}

function rangeText(from: number, to: number): string {
  return from === to ? `page ${from}` : `pages ${from}-${to}`;
}

/** Open the queue item's own file in a tab. Best-effort: a failure is silent. */
async function openFile(queueId: string): Promise<void> {
  try {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const res = await fetch(`/api/queue/${queueId}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) return;
    window.open(URL.createObjectURL(await res.blob()), '_blank');
  } catch {
    // The card's inline preview is still there; this is a convenience.
  }
}

function toRows(parts: PacketPart[]): EditRow[] {
  return parts.map((p) => ({ from: p.pages[0], to: p.pages[1], label: p.label, preview: p.preview }));
}

/**
 * What the reviewer is told about how sure this is. The words matter more than
 * the number: "the file's own index" is a different kind of claim from "the
 * pages look like it", and collapsing both to "82%" hides which one it is.
 */
function confidenceWords(view: QueuePacketView): string {
  const p = view.proposal;
  if (!p) return '';
  if (p.method === 'index') {
    return p.confidence_band === 'high'
      ? "Read off the file's own index page."
      : "Read off the file's own index page, but the pages do not line up with it — check the ranges.";
  }
  if (p.confidence_band === 'low') {
    return 'No index page and the layout signals disagree, so these boundaries are coarse. Expect to adjust them.';
  }
  return 'No index page — the boundaries come from the layout of the pages themselves.';
}

export function PacketSplitCard({
  queueId,
  onSplit,
}: {
  queueId: string;
  /** Called after a confirmed split, so the queue can reload. */
  onSplit?: (childIds: string[]) => void;
}) {
  const [view, setView] = useState<QueuePacketView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState<EditRow[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.queue.packet(queueId);
      setView(res);
    } catch {
      // A card must never be lost to this panel. Silence is the right failure
      // here: the reviewer keeps the ordinary single-document flow.
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [queueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const parts = view?.proposal?.parts ?? [];
  const editing = rows !== null;
  const effective = useMemo<EditRow[]>(() => rows ?? toRows(parts), [rows, parts]);

  const split = async (custom?: EditRow[]) => {
    setBusy(true);
    setError('');
    try {
      const payload = custom
        ? custom.map((r) => ({ pages: [r.from, r.to] as [number, number], label: r.label }))
        : undefined;
      const res = await api.queue.packetSplit(queueId, payload);
      onSplit?.(res.children.map((c) => c.id));
      await load();
      setRows(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Split failed');
    } finally {
      setBusy(false);
    }
  };

  const dismiss = async () => {
    setBusy(true);
    setError('');
    try {
      await api.queue.packetDismiss(queueId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not dismiss');
    } finally {
      setBusy(false);
    }
  };

  if (loading) return null;
  if (!view) return null;

  // ---- this item is one PART of a file somebody already split ----------
  if (view.parent) {
    return (
      <Alert severity="info" icon={false} sx={{ mb: 2 }} data-testid="packet-part-note">
        <Typography variant="body2">
          {view.part_of_pages
            ? `${rangeText(view.part_of_pages[0], view.part_of_pages[1])} of `
            : 'Part of '}
          <strong>{view.parent.file_name}</strong>
          {view.part_label ? ` — the index calls it "${view.part_label}".` : '.'}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          The index's own words are a hint, not a classification — it can be wrong about its own pages.
          Approving or rejecting this part does not affect the others.
        </Typography>
      </Alert>
    );
  }

  // ---- this item IS a container that was split ------------------------
  if (view.split_at) {
    const decided = view.children.filter((c) => c.status !== 'pending').length;
    return (
      <Alert severity="info" sx={{ mb: 2 }} data-testid="packet-container-note">
        <AlertTitle>
          Split into {view.children.length} documents — this file is not itself approved
        </AlertTitle>
        <Typography variant="body2" sx={{ mb: 1 }}>
          The parts below are the documents. This file stays as the source they were cut from.
          {decided > 0 ? ` ${decided} of ${view.children.length} decided so far.` : ''}
        </Typography>
        <Stack spacing={0.25}>
          {view.children.map((c) => (
            <Typography key={c.id} variant="caption" sx={{ display: 'block' }}>
              <Box component="span" sx={{ display: 'inline-block', minWidth: 78, color: 'text.secondary' }}>
                {c.pages ? rangeText(c.pages[0], c.pages[1]) : '—'}
              </Box>
              {c.label || c.file_name}
              {c.document_type_name ? ` · ${c.document_type_name}` : ''}
              <Chip
                size="small"
                variant="outlined"
                label={c.status === 'pending' ? c.processing_status : c.status}
                sx={{ ml: 1, height: 18, fontSize: 11 }}
              />
            </Typography>
          ))}
        </Stack>
      </Alert>
    );
  }

  // ---- nothing to ask ---------------------------------------------------
  if (!view.proposal || !view.proposal.looksLikePacket) return null;
  if (view.dismissed_at) {
    return (
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }} data-testid="packet-dismissed-note">
        Someone marked this "not a packet" — it is reviewed as one document.
      </Typography>
    );
  }

  const proposal = view.proposal;
  const total = effective.length;

  return (
    <Alert
      severity={proposal.confidence_band === 'low' ? 'info' : 'warning'}
      sx={{ mb: 2 }}
      data-testid="packet-proposal"
    >
      <AlertTitle>
        This looks like {total} documents in one file
        <Chip
          size="small"
          label={`${proposal.confidence_band} confidence`}
          variant="outlined"
          sx={{ ml: 1, height: 20 }}
        />
      </AlertTitle>

      <Typography variant="body2" sx={{ mb: 0.5 }}>
        {confidenceWords(view)}
      </Typography>
      {proposal.notes.map((n) => (
        <Typography key={n} variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          {n}
        </Typography>
      ))}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 1 }}>
        Nothing is split until you say so. The fields below were read from the whole file, so on a packet
        they answer for whichever document the model happened to read first.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Box sx={{ maxHeight: 340, overflow: 'auto', mb: 1 }}>
        <Table size="small" data-testid="packet-parts">
          <TableHead>
            <TableRow>
              <TableCell sx={{ width: 150 }}>Pages</TableCell>
              <TableCell>What it looks like</TableCell>
              {editing && <TableCell sx={{ width: 90 }} />}
            </TableRow>
          </TableHead>
          <TableBody>
            {effective.map((r, i) => (
              <TableRow key={`${r.from}-${r.to}-${i}`}>
                <TableCell>
                  {editing ? (
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <TextField
                        size="small"
                        type="number"
                        value={r.from}
                        inputProps={{ 'aria-label': `part ${i + 1} first page`, style: { width: 44 } }}
                        onChange={(e) =>
                          setRows((prev) =>
                            (prev || []).map((row, j) => (j === i ? { ...row, from: Number(e.target.value) } : row)),
                          )
                        }
                      />
                      <span>–</span>
                      <TextField
                        size="small"
                        type="number"
                        value={r.to}
                        inputProps={{ 'aria-label': `part ${i + 1} last page`, style: { width: 44 } }}
                        onChange={(e) =>
                          setRows((prev) =>
                            (prev || []).map((row, j) => (j === i ? { ...row, to: Number(e.target.value) } : row)),
                          )
                        }
                      />
                    </Stack>
                  ) : (
                    <Typography variant="body2">{rangeText(r.from, r.to)}</Typography>
                  )}
                </TableCell>
                <TableCell>
                  <Typography variant="body2">{r.label || r.preview.slice(0, 70) || '(no title on the page)'}</Typography>
                  {r.label && r.preview && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      {r.preview.slice(0, 90)}
                    </Typography>
                  )}
                </TableCell>
                {editing && (
                  <TableCell>
                    <Tooltip title="Merge with the part above" arrow>
                      <span>
                        <IconButton
                          size="small"
                          disabled={i === 0}
                          aria-label={`merge part ${i + 1} into the one above`}
                          onClick={() =>
                            setRows((prev) => {
                              const next = [...(prev || [])];
                              next[i - 1] = { ...next[i - 1], to: next[i].to };
                              next.splice(i, 1);
                              return next;
                            })
                          }
                        >
                          <CallMergeIcon fontSize="inherit" />
                        </IconButton>
                      </span>
                    </Tooltip>
                    <Tooltip title="Drop this part — its pages stay in the original file only" arrow>
                      <IconButton
                        size="small"
                        aria-label={`drop part ${i + 1}`}
                        onClick={() => setRows((prev) => (prev || []).filter((_, j) => j !== i))}
                      >
                        <DeleteOutlineIcon fontSize="inherit" />
                      </IconButton>
                    </Tooltip>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      {proposal.uncovered_pages.length > 0 && !editing && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          Page{proposal.uncovered_pages.length === 1 ? '' : 's'} {proposal.uncovered_pages.join(', ')} would be in no
          part. The original file keeps them either way.
        </Typography>
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button
          variant="contained"
          size="small"
          disabled={busy || total === 0}
          onClick={() => void split(editing ? effective : undefined)}
        >
          {busy ? <CircularProgress size={16} /> : `Split into ${total} document${total === 1 ? '' : 's'}`}
        </Button>
        {!editing ? (
          <Button size="small" disabled={busy} onClick={() => setRows(toRows(parts))}>
            Adjust
          </Button>
        ) : (
          <Button size="small" startIcon={<RestartAltIcon />} disabled={busy} onClick={() => setRows(null)}>
            Back to the proposal
          </Button>
        )}
        <Button size="small" color="inherit" disabled={busy} onClick={() => void dismiss()}>
          Not a packet
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        {/* The queue file endpoint takes a bearer token, so a bare window.open
            on it is a 401. Fetch it and hand the tab a blob, the same way the
            card's inline preview does — a reviewer checking 26 boundaries wants
            the real pages open beside them. */}
        <Link component="button" type="button" variant="caption" onClick={() => void openFile(queueId)}>
          Open the file
        </Link>
      </Stack>
    </Alert>
  );
}

/**
 * The one-glance signal on the COLLAPSED queue row. Reads the columns the list
 * endpoint already returns — no request per row.
 *
 * It says nothing on an ordinary upload and nothing on a file somebody already
 * called "not a packet": a chip that appears on every card is a chip nobody
 * reads, and the whole value here is that this one appears rarely.
 */
export function PacketChip({
  item,
}: {
  item: {
    packet_proposal?: string | null;
    packet_split_at?: string | null;
    packet_dismissed_at?: string | null;
    packet_part_count?: number | null;
    packet_parent_id?: string | null;
    packet_pages?: string | null;
  };
}) {
  if (item.packet_split_at) {
    return (
      <Tooltip title="Split into separate documents. This file is the source they were cut from and is not approved itself." arrow>
        <Chip
          label={`Split into ${item.packet_part_count ?? '?'}`}
          size="small"
          color="info"
          variant="outlined"
          sx={{ ml: 0.5 }}
        />
      </Tooltip>
    );
  }
  if (item.packet_parent_id) {
    let pages: [number, number] | null = null;
    try {
      const p = item.packet_pages ? (JSON.parse(item.packet_pages) as number[]) : null;
      if (Array.isArray(p) && p.length === 2) pages = [p[0], p[1]];
    } catch {
      pages = null;
    }
    return (
      <Tooltip title="One part of a file that was split. Deciding it does not affect the others." arrow>
        <Chip
          label={pages ? `Part · ${rangeText(pages[0], pages[1])}` : 'Part of a split file'}
          size="small"
          variant="outlined"
          sx={{ ml: 0.5 }}
        />
      </Tooltip>
    );
  }
  if (!item.packet_proposal || item.packet_dismissed_at) return null;
  let count: number | null = null;
  try {
    const parsed = JSON.parse(item.packet_proposal) as { looksLikePacket?: boolean; parts?: unknown[] };
    if (!parsed?.looksLikePacket || !Array.isArray(parsed.parts)) return null;
    count = parsed.parts.length;
  } catch {
    return null;
  }
  return (
    <Tooltip title="This one file looks like several documents. Open it to see the proposed split — nothing happens until you confirm." arrow>
      <Chip label={`Looks like ${count} documents`} size="small" color="warning" sx={{ ml: 0.5 }} />
    </Tooltip>
  );
}

export default PacketSplitCard;
