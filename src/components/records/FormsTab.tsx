/**
 * FormsTab — list of forms for a sheet, embedded inside SheetDetail.
 *
 * Renders cards (one per form) showing status, public URL, submission
 * count, last activity. "+ New form" opens a small dialog (name + public
 * toggle) and on submit navigates to the form builder for the new form.
 */

import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardActionArea,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ContentCopy as CopyIcon,
  OpenInNew as OpenIcon,
} from '@mui/icons-material';
import { recordsApi } from '../../lib/recordsApi';
import { EmptyState } from '../EmptyState';
import type { RecordForm } from '../../../shared/types';

interface FormsTabProps {
  sheetId: string;
  canMutate: boolean;
}

export function FormsTab({ sheetId, canMutate }: FormsTabProps) {
  const navigate = useNavigate();
  const [forms, setForms] = useState<RecordForm[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await recordsApi.forms.list(sheetId);
      setForms(res.forms);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load forms');
    } finally {
      setLoading(false);
    }
  }, [sheetId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress size={28} />
      </Box>
    );
  }

  if (error) {
    return <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>;
  }

  return (
    <Box sx={{ pt: 1 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Box>
          <Typography variant="h6" sx={{ fontWeight: 600 }}>
            Forms
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Public intake links built from this sheet's columns.
          </Typography>
        </Box>
        {canMutate && (
          <Button
            startIcon={<AddIcon />}
            variant="contained"
            disableElevation
            onClick={() => setCreateOpen(true)}
            sx={{ minHeight: 44 }}
          >
            New form
          </Button>
        )}
      </Box>

      {forms.length === 0 ? (
        <EmptyState
          title="No forms yet"
          description="Forms are derived from this sheet's columns. Build one and share a public link to collect submissions."
          actionLabel={canMutate ? 'Create your first form' : undefined}
          onAction={canMutate ? () => setCreateOpen(true) : undefined}
        />
      ) : (
        <Stack spacing={1.5}>
          {forms.map((form) => (
            <FormCard
              key={form.id}
              form={form}
              onOpen={() => navigate(`/records/${sheetId}/forms/${form.id}`)}
            />
          ))}
        </Stack>
      )}

      <CreateFormDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreate={async (name, isPublic) => {
          const res = await recordsApi.forms.create(sheetId, {
            name,
            is_public: isPublic,
            status: 'draft',
          });
          setCreateOpen(false);
          navigate(`/records/${sheetId}/forms/${res.form.id}`);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------

function FormCard({ form, onOpen }: { form: RecordForm; onOpen: () => void }) {
  const isLivePublic = form.status === 'live' && form.is_public === 1 && form.public_slug;
  const publicUrl = form.public_slug ? `${window.location.origin}/f/${form.public_slug}` : null;

  return (
    <Card variant="outlined" sx={{ borderColor: 'divider' }}>
      <CardActionArea onClick={onOpen} sx={{ p: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2 }}>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography sx={{ fontSize: 16, fontWeight: 600, mb: 0.5 }}>
              {form.name}
            </Typography>
            {form.description && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                {form.description}
              </Typography>
            )}
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', gap: 0.5 }}>
              <StatusChip status={form.status} />
              {form.is_public === 1 && <Chip size="small" label="Public" color="primary" variant="outlined" />}
              <Typography variant="caption" color="text.secondary">
                {form.submission_count ?? 0} submission{form.submission_count === 1 ? '' : 's'}
              </Typography>
            </Stack>
          </Box>
          {isLivePublic && publicUrl && (
            <Box
              sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Tooltip title="Copy public URL">
                <IconButton
                  size="small"
                  onClick={() => {
                    void navigator.clipboard.writeText(publicUrl);
                  }}
                  sx={{ minWidth: 36, minHeight: 36 }}
                >
                  <CopyIcon fontSize="small" />
                </IconButton>
              </Tooltip>
              <Tooltip title="Open in new tab">
                <IconButton
                  size="small"
                  component="a"
                  href={publicUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  sx={{ minWidth: 36, minHeight: 36 }}
                >
                  <OpenIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
      </CardActionArea>
    </Card>
  );
}

function StatusChip({ status }: { status: RecordForm['status'] }) {
  if (status === 'live') return <Chip size="small" label="Live" color="success" />;
  if (status === 'archived') return <Chip size="small" label="Archived" />;
  return <Chip size="small" label="Draft" variant="outlined" />;
}

function CreateFormDialog({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, isPublic: boolean) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onCreate(name.trim(), isPublic);
      setName('');
      setIsPublic(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create form');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>New form</DialogTitle>
      <DialogContent>
        <TextField
          autoFocus
          fullWidth
          label="Form name"
          placeholder="Quality intake"
          value={name}
          onChange={(e) => setName(e.target.value)}
          margin="normal"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !submitting) {
              e.preventDefault();
              void handleCreate();
            }
          }}
        />
        <FormControlLabel
          control={<Switch checked={isPublic} onChange={(e) => setIsPublic(e.target.checked)} />}
          label="Generate a public link"
          sx={{ mt: 1 }}
        />
        {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button
          variant="contained"
          disableElevation
          onClick={handleCreate}
          disabled={submitting || !name.trim()}
        >
          {submitting ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
