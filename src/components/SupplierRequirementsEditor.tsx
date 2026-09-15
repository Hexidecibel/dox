/**
 * SupplierRequirementsEditor — "what this supplier owes", editable.
 *
 * Written for the QA lead who fills it in, not for an engineer, and modelled on
 * `src/pages/admin/ClaimRules.tsx`: configuration rendered as SENTENCES, the
 * unconfigured state sorted to the top and visibly flagged rather than left to
 * look clean.
 *
 * THE TIER IS THE LOAD-BEARING CONTROL, so it is a two-button toggle sitting on
 * the row itself, not a field inside a dialog. The gap report counts `required`
 * and ignores `recommended` by default, and the reasoning behind that default
 * is the client's own: a report that flags everything gets muted, and a muted
 * report is worse than no report because people still believe it is running.
 * Somebody deciding "this one is nice-to-have" has to be able to act on that
 * thought in one click, or every item ends up required and the report dies.
 *
 * NOTHING CONFIGURED IS NOT NOTHING OUTSTANDING. A supplier with no rows reads
 * as "nothing set up yet" in warning colours, in the same words
 * `SupplierRequirementGaps` uses on the same page — the two surfaces sit inches
 * apart and must not disagree about what an empty checklist means.
 *
 * Grouped by the requirement's `checklist` field because that is how the
 * vocabulary is already organised (an SOP number, a programme name), so the
 * person attaching items recognises the grouping from their own paperwork.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Paper,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  Delete as DeleteIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type {
  ApiRequirement,
  ApiSupplierRequirement,
  SupplierRequirementTier,
} from '../lib/types';

/** Requirement rows grouped under their checklist heading, headings sorted. */
export function groupByChecklist<T extends { checklist?: string | null; name?: string }>(
  rows: T[],
): Array<{ checklist: string; rows: T[] }> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = (row.checklist || '').trim() || 'Ungrouped';
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }
  return [...groups.entries()]
    .sort((a, b) => {
      // "Ungrouped" is a fallback, not a real heading — it goes last.
      if ((a[0] === 'Ungrouped') !== (b[0] === 'Ungrouped')) return a[0] === 'Ungrouped' ? 1 : -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([checklist, rows]) => ({ checklist, rows }));
}

/**
 * Order attached rows for reading: required before recommended, then by
 * checklist and name.
 *
 * Required first because that is the set the gap report actually counts. A list
 * that interleaves the two makes somebody read the tier chip on every line to
 * work out what is being enforced.
 */
export function orderAttached(rows: ApiSupplierRequirement[]): ApiSupplierRequirement[] {
  return [...rows].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'required' ? -1 : 1;
    const ac = (a.requirement_checklist || '').localeCompare(b.requirement_checklist || '');
    if (ac !== 0) return ac;
    return (a.requirement_name || '').localeCompare(b.requirement_name || '');
  });
}

/** Counts for the one-line summary sentence. */
export function tierCounts(rows: ApiSupplierRequirement[]): {
  required: number;
  recommended: number;
} {
  return {
    required: rows.filter((r) => r.tier === 'required').length,
    recommended: rows.filter((r) => r.tier === 'recommended').length,
  };
}

/**
 * The required/recommended switch.
 *
 * Both options are always visible and always one click apart. A dropdown or a
 * dialog would hide the distinction the whole gap report turns on.
 */
export function TierToggle({
  tier,
  onChange,
  disabled,
  label,
}: {
  tier: SupplierRequirementTier;
  onChange: (next: SupplierRequirementTier) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <ToggleButtonGroup
      size="small"
      exclusive
      value={tier}
      disabled={disabled}
      aria-label={label ? `Tier for ${label}` : 'Tier'}
      onChange={(_e, next) => {
        // MUI hands back null when the active button is re-clicked. There is no
        // "no tier" state — a row exists or it does not — so ignore it.
        if (next) onChange(next as SupplierRequirementTier);
      }}
    >
      <ToggleButton value="required" aria-label="Required" sx={{ px: 1.5, py: 0.25 }}>
        Required
      </ToggleButton>
      <ToggleButton value="recommended" aria-label="Recommended" sx={{ px: 1.5, py: 0.25 }}>
        Recommended
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

export interface SupplierRequirementsEditorProps {
  supplierId: string;
  /** Display name, used in the sentences. Falls back to "this supplier". */
  supplierName?: string;
  /** super_admin acting inside a chosen tenant. */
  tenantId?: string;
  /** Fired after any successful write, so a host page can refresh its gap panel. */
  onChanged?: () => void;
}

export default function SupplierRequirementsEditor({
  supplierId,
  supplierName,
  tenantId,
  onChanged,
}: SupplierRequirementsEditorProps) {
  const [attached, setAttached] = useState<ApiSupplierRequirement[]>([]);
  const [vocab, setVocab] = useState<ApiRequirement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [addTier, setAddTier] = useState<SupplierRequirementTier>('required');
  const [saving, setSaving] = useState(false);

  const who = supplierName || 'this supplier';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rows, reqs] = await Promise.all([
        api.supplierRequirements.list({ supplier_id: supplierId, tenant_id: tenantId }),
        api.requirements.list({ tenant_id: tenantId, active: 1, limit: 500 }),
      ]);
      setAttached(rows.supplierRequirements);
      setVocab(reqs.requirements);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load supplier requirements');
    } finally {
      setLoading(false);
    }
  }, [supplierId, tenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const attachedIds = useMemo(
    () => new Set(attached.map((r) => r.requirement_id)),
    [attached],
  );
  const ordered = useMemo(() => orderAttached(attached), [attached]);
  const counts = useMemo(() => tierCounts(attached), [attached]);

  const available = useMemo(
    () => vocab.filter((r) => !attachedIds.has(r.id)),
    [vocab, attachedIds],
  );
  const availableGroups = useMemo(() => groupByChecklist(available), [available]);

  const afterWrite = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  const setTier = async (row: ApiSupplierRequirement, tier: SupplierRequirementTier) => {
    if (row.tier === tier) return;
    setBusyId(row.id);
    setError('');
    // Optimistic: the toggle is meant to feel like a switch, not a form submit.
    setAttached((prev) => prev.map((r) => (r.id === row.id ? { ...r, tier } : r)));
    try {
      await api.supplierRequirements.update(row.id, { tier });
      onChanged?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to change tier');
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const detach = async (row: ApiSupplierRequirement) => {
    setBusyId(row.id);
    setError('');
    try {
      await api.supplierRequirements.detach(row.id);
      await afterWrite();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove requirement');
    } finally {
      setBusyId(null);
    }
  };

  const openAdd = () => {
    setPicked(new Set());
    setAddTier('required');
    setAddOpen(true);
  };

  const confirmAdd = async () => {
    if (picked.size === 0) return;
    setSaving(true);
    setError('');
    try {
      for (const requirementId of picked) {
        await api.supplierRequirements.attach({
          supplier_id: supplierId,
          requirement_id: requirementId,
          tier: addTier,
          tenant_id: tenantId,
        });
      }
      setAddOpen(false);
      await afterWrite();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add requirements');
    } finally {
      setSaving(false);
    }
  };

  if (loading && attached.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
        <CircularProgress size={24} />
      </Box>
    );
  }

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Box
        sx={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          flexWrap: 'wrap',
          gap: 1,
          mb: 2,
        }}
      >
        <Box>
          <Typography variant="subtitle1" fontWeight={600}>
            What {who} owes
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {attached.length === 0 ? (
              'No requirements attached yet.'
            ) : (
              <>
                <strong>{counts.required}</strong> required
                {counts.recommended > 0 ? (
                  <>
                    {' '}
                    and <strong>{counts.recommended}</strong> recommended
                  </>
                ) : null}
                . Only required items are counted as gaps by default.
              </>
            )}
          </Typography>
        </Box>
        <Button
          size="small"
          variant={attached.length === 0 ? 'contained' : 'outlined'}
          startIcon={<AddIcon />}
          onClick={openAdd}
          disabled={vocab.length === 0}
        >
          Add requirements
        </Button>
      </Box>

      {/* The false-clean guard, in the same words SupplierRequirementGaps uses. */}
      {attached.length === 0 ? (
        vocab.length === 0 ? (
          <Alert severity="info">
            <AlertTitle>No requirements to draw from</AlertTitle>
            This tenant has no requirements yet. Add them under{' '}
            <strong>Settings → Requirements</strong> first — they are the vocabulary a supplier
            can be held to.
          </Alert>
        ) : (
          <Alert severity="warning">
            <AlertTitle>Nothing set up yet</AlertTitle>
            Nothing has been attached to {who}, so nothing is being checked. This is{' '}
            <strong>not</strong> the same as compliant — attach the requirements{' '}
            {who} owes before reading anything as clean.
          </Alert>
        )
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {ordered.map((row) => (
            <Paper
              key={row.id}
              variant="outlined"
              sx={{
                p: 1.5,
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                flexWrap: 'wrap',
              }}
            >
              <Box sx={{ flexGrow: 1, minWidth: 200 }}>
                <Typography variant="body2">
                  <strong>{who}</strong>{' '}
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    {row.tier === 'required' ? 'must provide' : 'should provide'}
                  </Box>{' '}
                  <strong>{row.requirement_name || row.requirement_slug}</strong>
                </Typography>
                {row.requirement_checklist ? (
                  <Chip
                    size="small"
                    variant="outlined"
                    label={row.requirement_checklist}
                    sx={{ mt: 0.5 }}
                  />
                ) : null}
                {row.requirement_active === 0 ? (
                  <Tooltip title="This requirement is deactivated, so it will not be counted.">
                    <Chip
                      size="small"
                      color="warning"
                      variant="outlined"
                      label="Item inactive"
                      sx={{ mt: 0.5, ml: 0.5 }}
                    />
                  </Tooltip>
                ) : null}
              </Box>

              <TierToggle
                tier={row.tier}
                disabled={busyId === row.id}
                label={row.requirement_name || row.requirement_slug || 'requirement'}
                onChange={(next) => setTier(row, next)}
              />

              <Tooltip title="Remove — this item will stop applying to this supplier">
                <span>
                  <IconButton
                    size="small"
                    disabled={busyId === row.id}
                    aria-label={`Remove ${row.requirement_name || 'requirement'}`}
                    onClick={() => detach(row)}
                  >
                    <DeleteIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Paper>
          ))}
        </Box>
      )}

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add requirements for {who}</DialogTitle>
        <DialogContent dividers>
          {available.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Every requirement is already attached to {who}.
            </Typography>
          ) : (
            <>
              <Box sx={{ mb: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 0.75 }}>
                  Add these as:
                </Typography>
                <TierToggle tier={addTier} onChange={setAddTier} label="new items" />
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.75 }}>
                  {addTier === 'required'
                    ? 'Required items are reported as gaps until a confirmed document closes them.'
                    : 'Recommended items are advisory and are left out of the gap report by default.'}
                </Typography>
              </Box>
              {availableGroups.map((group) => (
                <Box key={group.checklist} sx={{ mb: 1.5 }}>
                  <Typography variant="overline" color="text.secondary">
                    {group.checklist}
                  </Typography>
                  {group.rows.map((req) => (
                    <Box key={req.id}>
                      <FormControlLabel
                        control={
                          <Checkbox
                            size="small"
                            checked={picked.has(req.id)}
                            onChange={(e) => {
                              setPicked((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(req.id);
                                else next.delete(req.id);
                                return next;
                              });
                            }}
                          />
                        }
                        label={req.name}
                      />
                    </Box>
                  ))}
                </Box>
              ))}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={picked.size === 0 || saving}
            onClick={confirmAdd}
          >
            {saving
              ? 'Adding…'
              : `Add ${picked.size || ''} as ${addTier}`.replace(/\s+/g, ' ').trim()}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
