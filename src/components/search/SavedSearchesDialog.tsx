import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
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
 * Dialog with two surfaces in one:
 *   1) Top section — "Save current search as…" with a name input + Save.
 *   2) Bottom section — list of existing saved searches, each row a
 *      one-click load + a delete affordance.
 *
 * The component is presentational; CRUD goes through props (which the
 * parent wires to `useSavedSearches`).
 */
export interface SavedSearchesDialogProps {
  open: boolean;
  onClose: () => void;
  /** The current SearchState — used as the body of "Save current". */
  currentState: SearchState;
  /** Existing saved-search rows. */
  saved: SavedSearch[];
  /** Save the current state under a name. Throws on UNIQUE collision. */
  onSave: (name: string) => Promise<void>;
  /** Replace the panel state with a saved row. */
  onLoad: (saved: SavedSearch) => void;
  onDelete: (id: string) => Promise<void>;
}

export function SavedSearchesDialog({
  open,
  onClose,
  currentState,
  saved,
  onSave,
  onLoad,
  onDelete,
}: SavedSearchesDialogProps) {
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentUrlPreview = encodeSearchState(currentState).toString();

  const handleSave = async () => {
    if (!name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim());
      setName('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

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
            <Button
              variant="contained"
              onClick={handleSave}
              disabled={!name.trim() || saving}
            >
              Save
            </Button>
          </Stack>
          {currentUrlPreview && (
            <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: 'block' }}>
              ?{currentUrlPreview}
            </Typography>
          )}
        </Box>
        <Divider sx={{ my: 1 }} />
        <Typography variant="subtitle2" sx={{ mt: 1, mb: 0.5 }}>
          Your saved searches
        </Typography>
        {saved.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            None yet. Saved searches appear here.
          </Typography>
        ) : (
          <List dense disablePadding>
            {saved.map((s) => (
              <ListItem
                key={s.id}
                disablePadding
                secondaryAction={
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
                }
              >
                <ListItemButton
                  onClick={() => {
                    onLoad(s);
                    onClose();
                  }}
                >
                  <ListItemText
                    primary={s.name}
                    secondary={
                      // Render a compact preview from the stored query.
                      typeof s.query?.q === 'string' ? `"${s.query.q}"` : undefined
                    }
                  />
                </ListItemButton>
              </ListItem>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
