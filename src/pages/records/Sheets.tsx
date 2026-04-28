import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Skeleton,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
  TableViewOutlined as TableIcon,
} from '@mui/icons-material';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { recordsApi } from '../../lib/recordsApi';
import { SheetCard } from '../../components/SheetCard';
import type { ApiRecordSheet } from '../../../shared/types';

/**
 * Records — Sheets index. Entry point to the Records experience. Renders
 * a generously-spaced grid of sheet cards. Readers see the same layout
 * but without create / mutate affordances.
 *
 * Data shape note: `recordsApi.sheets.list` always hits the per-tenant
 * endpoint. For non-super_admin users the backend overrides the tenant
 * to their own; super_admin can pass a `tenant_id` filter from the
 * sidebar's TenantContext selector.
 */
export function Sheets() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { selectedTenantId } = useTenant();

  const isReader = user?.role === 'reader';
  const canMutate = !isReader;

  // Active list
  const [sheets, setSheets] = useState<ApiRecordSheet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Archive surfacing
  const [archivedSheets, setArchivedSheets] = useState<ApiRecordSheet[] | null>(null);
  const [hasArchived, setHasArchived] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [creating, setCreating] = useState(false);

  // Rename dialog
  const [renameTarget, setRenameTarget] = useState<ApiRecordSheet | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameDescription, setRenameDescription] = useState('');
  const [renaming, setRenaming] = useState(false);

  // Archive confirm
  const [archiveTarget, setArchiveTarget] = useState<ApiRecordSheet | null>(null);
  const [archiving, setArchiving] = useState(false);

  const tenantParam = selectedTenantId || undefined;

  const loadSheets = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await recordsApi.sheets.list({ tenant_id: tenantParam, limit: 200 });
      setSheets(result.sheets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sheets');
    } finally {
      setLoading(false);
    }
  };

  // Cheap probe to know whether to render the archive toggle.
  const probeArchived = async () => {
    try {
      const result = await recordsApi.sheets.list({ tenant_id: tenantParam, archived: true, limit: 1 });
      setHasArchived(result.total > 0);
    } catch {
      setHasArchived(false);
    }
  };

  const loadArchivedFull = async () => {
    try {
      const result = await recordsApi.sheets.list({ tenant_id: tenantParam, archived: true, limit: 200 });
      setArchivedSheets(result.sheets);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load archived sheets');
    }
  };

  useEffect(() => {
    loadSheets();
    probeArchived();
    setShowArchived(false);
    setArchivedSheets(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantParam]);

  useEffect(() => {
    if (showArchived && archivedSheets === null) {
      loadArchivedFull();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  const openCreate = () => {
    setFormName('');
    setFormDescription('');
    setCreateOpen(true);
  };

  const handleCreate = async () => {
    if (!formName.trim()) return;
    setCreating(true);
    setError('');
    try {
      const result = await recordsApi.sheets.create({
        name: formName.trim(),
        description: formDescription.trim() || null,
        tenant_id: tenantParam,
      });
      setCreateOpen(false);
      navigate(`/records/${result.sheet.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create sheet');
    } finally {
      setCreating(false);
    }
  };

  const openRename = (sheet: ApiRecordSheet) => {
    setRenameTarget(sheet);
    setRenameValue(sheet.name);
    setRenameDescription(sheet.description || '');
  };

  const handleRename = async () => {
    if (!renameTarget || !renameValue.trim()) return;
    setRenaming(true);
    setError('');
    try {
      const result = await recordsApi.sheets.update(renameTarget.id, {
        name: renameValue.trim(),
        description: renameDescription.trim() || null,
      });
      setSheets((prev) => prev.map((s) => (s.id === result.sheet.id ? { ...s, ...result.sheet } : s)));
      setRenameTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename sheet');
    } finally {
      setRenaming(false);
    }
  };

  const openArchive = (sheet: ApiRecordSheet) => setArchiveTarget(sheet);

  const handleArchive = async () => {
    if (!archiveTarget) return;
    setArchiving(true);
    setError('');
    try {
      await recordsApi.sheets.archive(archiveTarget.id);
      setSheets((prev) => prev.filter((s) => s.id !== archiveTarget.id));
      setArchiveTarget(null);
      setHasArchived(true);
      // Force the archived list to re-fetch on next toggle.
      setArchivedSheets(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive sheet');
    } finally {
      setArchiving(false);
    }
  };

  const visibleSheets = useMemo(() => sheets, [sheets]);

  const gridSx = {
    display: 'grid',
    gap: 2.5,
    gridTemplateColumns: {
      xs: '1fr',
      sm: 'repeat(2, 1fr)',
      lg: 'repeat(3, 1fr)',
    },
  } as const;

  return (
    <Box sx={{ maxWidth: 1280, mx: 'auto' }}>
      {/* Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: { xs: 'flex-start', sm: 'center' },
          justifyContent: 'space-between',
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 2,
          mb: 4,
        }}
      >
        <Box>
          <Typography variant="h4" fontWeight={700} sx={{ mb: 0.5 }}>
            Records
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Collaborative trackers for your team.
          </Typography>
        </Box>
        {canMutate && (
          <Button
            variant="contained"
            size="medium"
            startIcon={<AddIcon />}
            onClick={openCreate}
            sx={{ flexShrink: 0, alignSelf: { xs: 'stretch', sm: 'auto' } }}
          >
            New sheet
          </Button>
        )}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {/* Body */}
      {loading ? (
        <Box sx={gridSx}>
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton
              key={i}
              variant="rounded"
              height={188}
              sx={{ borderRadius: 1, bgcolor: 'rgba(26, 54, 93, 0.04)' }}
            />
          ))}
        </Box>
      ) : visibleSheets.length === 0 ? (
        <EmptyState canMutate={canMutate} onCreate={openCreate} />
      ) : (
        <>
          <Box sx={gridSx}>
            {visibleSheets.map((sheet, idx) => (
              <SheetCard
                key={sheet.id}
                sheet={sheet}
                index={idx}
                canMutate={canMutate}
                onOpen={(s) => navigate(`/records/${s.id}`)}
                onRename={openRename}
                onArchive={openArchive}
              />
            ))}
          </Box>
        </>
      )}

      {/* Archived toggle + section */}
      {hasArchived && !loading && (
        <Box sx={{ mt: 6 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', mb: 2 }}>
            <FormControlLabel
              control={
                <Switch
                  size="small"
                  checked={showArchived}
                  onChange={(_, v) => setShowArchived(v)}
                />
              }
              label={
                <Typography variant="body2" color="text.secondary">
                  Show archived
                </Typography>
              }
            />
          </Box>
          {showArchived && (
            <>
              <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                Archived
              </Typography>
              {archivedSheets === null ? (
                <Box sx={gridSx}>
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} variant="rounded" height={188} sx={{ borderRadius: 1, bgcolor: 'rgba(26, 54, 93, 0.04)' }} />
                  ))}
                </Box>
              ) : archivedSheets.length === 0 ? (
                <Typography variant="body2" color="text.secondary">No archived sheets.</Typography>
              ) : (
                <Box sx={{ ...gridSx, opacity: 0.78 }}>
                  {archivedSheets.map((sheet, idx) => (
                    <SheetCard
                      key={sheet.id}
                      sheet={sheet}
                      index={idx}
                      canMutate={false}
                      onOpen={(s) => navigate(`/records/${s.id}`)}
                      onRename={() => undefined}
                      onArchive={() => undefined}
                    />
                  ))}
                </Box>
              )}
            </>
          )}
        </Box>
      )}

      {/* Create dialog */}
      <Dialog
        open={createOpen}
        onClose={() => !creating && setCreateOpen(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          New sheet
          <IconButton size="small" onClick={() => setCreateOpen(false)} disabled={creating}>
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <TextField
              label="Name"
              fullWidth
              required
              autoFocus
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              disabled={creating}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && formName.trim() && !creating) {
                  e.preventDefault();
                  handleCreate();
                }
              }}
            />
            <TextField
              label="Description (optional)"
              fullWidth
              multiline
              rows={3}
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              disabled={creating}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setCreateOpen(false)} disabled={creating}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleCreate} disabled={!formName.trim() || creating}>
            {creating ? 'Creating…' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Rename dialog */}
      <Dialog
        open={renameTarget !== null}
        onClose={() => !renaming && setRenameTarget(null)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Rename sheet</DialogTitle>
        <DialogContent>
          <Stack spacing={2.5} sx={{ mt: 1 }}>
            <TextField
              label="Name"
              fullWidth
              required
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              disabled={renaming}
            />
            <TextField
              label="Description"
              fullWidth
              multiline
              rows={3}
              value={renameDescription}
              onChange={(e) => setRenameDescription(e.target.value)}
              disabled={renaming}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRenameTarget(null)} disabled={renaming}>
            Cancel
          </Button>
          <Button variant="contained" onClick={handleRename} disabled={!renameValue.trim() || renaming}>
            {renaming ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* Archive confirm */}
      <Dialog open={archiveTarget !== null} onClose={() => !archiving && setArchiveTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Archive this sheet?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            <strong>{archiveTarget?.name}</strong> will be hidden from the main list. Rows and columns are kept and the
            sheet can be restored later.
          </DialogContentText>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setArchiveTarget(null)} disabled={archiving}>
            Cancel
          </Button>
          <Button color="warning" variant="contained" onClick={handleArchive} disabled={archiving}>
            {archiving ? 'Archiving…' : 'Archive'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

interface EmptyStateProps {
  canMutate: boolean;
  onCreate: () => void;
}

function EmptyState({ canMutate, onCreate }: EmptyStateProps) {
  return (
    <Card variant="outlined" sx={{ borderStyle: 'dashed', borderColor: 'divider', bgcolor: 'transparent' }}>
      <CardContent sx={{ textAlign: 'center', py: { xs: 6, sm: 10 }, px: 3 }}>
        <Box
          sx={{
            width: 72,
            height: 72,
            borderRadius: 2,
            mx: 'auto',
            mb: 3,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'rgba(26, 54, 93, 0.05)',
            color: 'primary.main',
          }}
        >
          <TableIcon sx={{ fontSize: 36 }} />
        </Box>
        <Typography variant="h5" sx={{ mb: 1, fontWeight: 600 }}>
          Track anything that doesn't fit a document
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 460, mx: 'auto', mb: 4 }}>
          Quality issues. Approval workflows. New item requests. Build a sheet for any process your
          team manages outside the document library.
        </Typography>
        {canMutate ? (
          <Button variant="contained" size="large" startIcon={<AddIcon />} onClick={onCreate}>
            Create your first sheet
          </Button>
        ) : (
          <Typography variant="body2" color="text.secondary">
            Ask an admin or teammate to create the first sheet.
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}
