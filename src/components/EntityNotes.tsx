/**
 * In-system notes on any record — the DCN parity item (migration 0088).
 *
 * ONE component for every parent. It takes an (entityType, entityId) pair and
 * nothing else record-specific, so wiring notes onto a new page is an import
 * and a line of JSX, not another component. That is the whole reason the table
 * is polymorphic.
 *
 * WHAT THIS IS NOT. It is not `documents.description`, which lives on the
 * document as a single overwritable field and stays exactly where it is. A
 * description says what a document IS; a note says what someone SAID about it,
 * and needs an author and a time to mean anything.
 *
 * APPEND-ONLY, VISIBLY. There is no edit control, on purpose — a note's text is
 * fixed once posted (see migrations/0088_entity_notes.sql). The affordance for
 * a correction is the composer that is always sitting right there: you add a
 * note, you do not rewrite one. Retracting is offered to the author and to
 * admins, and says "Retract", not "Delete", because the row is kept.
 *
 * Every note shows WHO and WHEN without hover or expansion. An unattributed or
 * undated note is the failure mode this replaces.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { api } from '../lib/api';
import { formatDateTime } from '../utils/format';
import { useAuth } from '../contexts/AuthContext';
import type { EntityNote, NoteEntityType } from '../lib/types';

/** Matches MAX_NOTE_LENGTH in functions/api/notes/index.ts. */
const MAX_NOTE_LENGTH = 10000;

function initials(name: string | null, email: string | null): string {
  const source = (name || email || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return source.slice(0, 2).toUpperCase();
}

function NoteRow({
  note,
  canRetract,
  onRetract,
  busy,
}: {
  note: EntityNote;
  canRetract: boolean;
  onRetract: (id: string) => void;
  busy: boolean;
}) {
  const author = note.author_name || note.author_email || 'Unknown user';
  return (
    <Box sx={{ display: 'flex', gap: 1.5, py: 1.5 }}>
      <Avatar sx={{ width: 32, height: 32, fontSize: 13 }}>
        {initials(note.author_name, note.author_email)}
      </Avatar>
      <Box sx={{ flexGrow: 1, minWidth: 0 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Typography variant="body2" fontWeight={600}>
            {author}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {formatDateTime(note.created_at)}
          </Typography>
          {note.deleted_at && (
            <Tooltip
              title={`Retracted ${formatDateTime(note.deleted_at)}${
                note.deleted_by_name ? ` by ${note.deleted_by_name}` : ''
              }. Kept because the record of what was said is the point.`}
            >
              <Chip size="small" color="warning" variant="outlined" label="retracted" />
            </Tooltip>
          )}
          {canRetract && !note.deleted_at && (
            <Button
              size="small"
              color="inherit"
              disabled={busy}
              onClick={() => onRetract(note.id)}
              sx={{ ml: 'auto', minWidth: 0, color: 'text.secondary' }}
            >
              Retract
            </Button>
          )}
        </Box>
        {/* pre-wrap: a note is typed prose and its line breaks are meaningful. */}
        <Typography
          variant="body2"
          sx={{
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            mt: 0.25,
            color: note.deleted_at ? 'text.disabled' : 'text.primary',
            textDecoration: note.deleted_at ? 'line-through' : 'none',
          }}
        >
          {note.body}
        </Typography>
      </Box>
    </Box>
  );
}

export default function EntityNotes({
  entityType,
  entityId,
  tenantId,
  title = 'Notes',
  description,
}: {
  entityType: NoteEntityType;
  entityId: string;
  /**
   * The tenant the RECORD belongs to. Required in practice for a super_admin,
   * who has `tenant_id: null` and therefore cannot be pinned to a tenant by the
   * server — the API makes them name one, matching resolveWriteTenant. Ignored
   * for everyone else, who is pinned to their own tenant server-side and cannot
   * widen it by passing this.
   */
  tenantId?: string;
  title?: string;
  /** Optional one-liner shown when the thread is empty. */
  description?: string;
}) {
  const { user } = useAuth();
  const [notes, setNotes] = useState<EntityNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const isAdmin = user?.role === 'super_admin' || user?.role === 'org_admin';
  // Matches the server gate: readers read, everyone else may post.
  const canPost = !!user && user.role !== 'reader';

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.notes.list({
        entity_type: entityType,
        entity_id: entityId,
        // Admins see retracted notes; the server enforces this too.
        include_deleted: isAdmin,
        // super_admin has no implicit tenant, so the server needs it named.
        tenant_id: user?.role === 'super_admin' ? tenantId : undefined,
      });
      setNotes(res.notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load notes');
    } finally {
      setLoading(false);
    }
  }, [entityType, entityId, tenantId, isAdmin, user]);

  useEffect(() => {
    void load();
  }, [load]);

  const handlePost = async () => {
    const body = draft.trim();
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      await api.notes.create({
        entity_type: entityType,
        entity_id: entityId,
        body,
        tenant_id: user?.role === 'super_admin' ? tenantId : undefined,
      });
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post note');
    } finally {
      setSaving(false);
    }
  };

  const handleRetract = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await api.notes.retract(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retract note');
    } finally {
      setBusyId(null);
    }
  };

  const live = notes.filter((n) => !n.deleted_at);

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 2.5 }, mb: 3 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
        <Typography variant="h6" fontWeight={600}>
          {title}
        </Typography>
        {live.length > 0 && (
          <Chip size="small" variant="outlined" label={live.length} />
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {canPost && (
        <Box sx={{ mb: 1 }}>
          <TextField
            fullWidth
            multiline
            minRows={2}
            size="small"
            placeholder="Add a note. Once posted it cannot be edited — post a follow-up to correct it."
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            inputProps={{ maxLength: MAX_NOTE_LENGTH }}
          />
          <Box
            sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1 }}
          >
            <Typography variant="caption" color="text.secondary">
              Notes are permanent and attributed to you.
            </Typography>
            <Button
              variant="contained"
              size="small"
              sx={{ ml: 'auto' }}
              disabled={saving || !draft.trim()}
              onClick={handlePost}
            >
              {saving ? 'Posting...' : 'Add note'}
            </Button>
          </Box>
        </Box>
      )}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
          <CircularProgress size={20} />
        </Box>
      ) : notes.length === 0 ? (
        <Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>
          {description || 'No notes yet.'}
        </Typography>
      ) : (
        <Box>
          {notes.map((note, i) => (
            <Box key={note.id}>
              {i > 0 && <Divider />}
              <NoteRow
                note={note}
                canRetract={isAdmin || note.author_id === user?.id}
                onRetract={handleRetract}
                busy={busyId === note.id}
              />
            </Box>
          ))}
        </Box>
      )}
    </Paper>
  );
}
