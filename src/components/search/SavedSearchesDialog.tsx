import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import DeleteIcon from '@mui/icons-material/DeleteOutline';
import type { SavedSearch, SearchState } from '../../../shared/types';
import { encodeSearchState } from '../../lib/searchUrl';

/**
 * Saved searches and saved VIEWS (search Phase 3), in one dialog:
 *   1) "Save current view as…" — the query, the result mode, Easy/Advanced,
 *      the columns and the sort. An organization admin may tick "Share with
 *      the organization" to publish it.
 *   2) The caller's own views, then the views shared with their organization
 *      (named with who published them). A row loads in one click; the delete
 *      affordance appears only where the server says the caller may delete.
 *
 * Presentational: CRUD goes through props (the parent wires `useSavedSearches`).
 */
export interface SavedSearchesDialogProps {
  open: boolean;
  onClose: () => void;
  /** The current SearchState — used as the body of "Save current". */
  currentState: SearchState;
  /**
   * What "Save current" will store, as a URL-style preview. A caller on the
   * one query model (shared/searchQuery.ts) passes its encoded query here;
   * otherwise the legacy state is encoded.
   */
  currentPreview?: string;
  /** Existing saved-search rows (own and shared). */
  saved: SavedSearch[];
  /** Save the current view under a name; `shared` only when `canShare`. Throws on a collision. */
  onSave: (name: string, shared?: boolean) => Promise<void>;
  /** Replace the workspace state with a saved row. */
  onLoad: (saved: SavedSearch) => void;
  onDelete: (id: string) => Promise<void>;
  /** May this person publish to the organization (org_admin)? */
  canShare?: boolean;
}

/** One line describing what a stored view holds. */
function viewSummary(s: SavedSearch): string | undefined {
  const q = s.query as Record<string, unknown> | null;
  if (!q) return undefined;
  if (q.v === 1) {
    const clauses = Array.isArray(q.clauses) ? q.clauses.length : 0;
    const view = (q.view ?? {}) as { entity?: string; mode?: string; columns?: unknown[] };
    const parts = [
      typeof q.text === 'string' && q.text.trim() ? `“${q.text.trim()}”` : null,
      clauses ? `${clauses} filter${clauses === 1 ? '' : 's'}` : null,
      view.entity && view.entity !== 'documents' ? view.entity : null,
      view.mode === 'advanced' ? 'Advanced' : null,
    ].filter(Boolean);
    return parts.join(' · ') || undefined;
  }
  return typeof q.q === 'string' ? `"${q.q}"` : undefined;
}

export function SavedSearchesDialog({
  open,
  onClose,
  currentState,
  currentPreview,
  saved,
  onSave,
  onLoad,
  onDelete,
  canShare = false,
}: SavedSearchesDialogProps) {
  const [name, setName] = useState('');
  const [share, setShare] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentUrlPreview = currentPreview ?? encodeSearchState(currentState).toString();
  const mine = saved.filter((s) => s.mine !== false);
  const shared = saved.filter((s) => s.mine === false);

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      if (canShare) await onSave(name.trim(), share);
      else await onSave(name.trim());
      setName('');
      setShare(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const row = (s: SavedSearch) => (
    <ListItem
      key={s.id}
      disablePadding
      secondaryAction={
        s.can_delete === false ? undefined : (
          <IconButton
            edge="end"
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(s.id);
            }}
            aria-label={`delete ${s.name}`}
          >
            <DeleteIcon fontSize="small" />
          </IconButton>
        )
      }
    >
      <ListItemButton
        onClick={() => {
          onLoad(s);
          onClose();
        }}
      >
        <ListItemText
          primary={
            <Stack direction="row" spacing={1} alignItems="center" component="span">
              <span>{s.name}</span>
              {s.scope === 'shared' && s.mine !== false && <Chip size="small" label="Shared" variant="outlined" />}
            </Stack>
          }
          secondary={[viewSummary(s), s.mine === false && s.owner_name ? `Shared by ${s.owner_name}` : null].filter(Boolean).join(' · ') || undefined}
        />
      </ListItemButton>
    </ListItem>
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Saved searches</DialogTitle>
      <DialogContent>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {error}
          </Alert>
        )}
        <Box sx={{ mb: 2 }}>
          <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
            Save current search
          </Typography>
          <Stack direction="row" spacing={1}>
            <TextField
              size="small"
              fullWidth
              placeholder="e.g. Pending COAs from Acme"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleSave();
                }
              }}
            />
            <Button variant="contained" onClick={handleSave} disabled={!name.trim() || saving}>
              Save
            </Button>
          </Stack>
          {canShare && (
            <FormControlLabel
              sx={{ mt: 0.5 }}
              control={<Checkbox size="small" checked={share} onChange={(e) => setShare(e.target.checked)} />}
              label={<Typography variant="body2">Share with the organization (everyone can open it; only you can change it)</Typography>}
            />
          )}
          <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
            Saves the filters, the result mode, Easy or Advanced, the columns and the sort.
          </Typography>
          {currentUrlPreview && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', wordBreak: 'break-all' }}>
              ?{currentUrlPreview}
            </Typography>
          )}
        </Box>
        <Divider sx={{ my: 1 }} />
        <Typography variant="subtitle2" sx={{ mt: 1, mb: 0.5 }}>
          Your saved searches
        </Typography>
        {mine.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            None yet. Saved searches appear here.
          </Typography>
        ) : (
          <List dense disablePadding>{mine.map(row)}</List>
        )}
        {shared.length > 0 && (
          <>
            <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
              Shared with your organization
            </Typography>
            <List dense disablePadding data-testid="shared-views">{shared.map(row)}</List>
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
