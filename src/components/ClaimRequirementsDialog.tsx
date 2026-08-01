/**
 * ClaimRequirementsDialog — the claim -> requirement mapping editor.
 *
 * This is where "conditional triggers" get configured: a QA manager states,
 * ONCE, that a document claiming Organic makes an Organic Certificate
 * required. Every document that later asserts that claim reuses the rule, and
 * gap detection reads it back to name the missing document.
 *
 * Design constraints (the person filling this in is not technical):
 *   - The whole dialog reads as ONE SENTENCE — "When a document claims
 *     Organic … these documents become required". No jargon, no ids, no
 *     mention of tables or junctions.
 *   - Ticking a box is the whole interaction. Required vs Recommended is a
 *     two-word toggle that only appears once a box is ticked, so the default
 *     path is literally "find it, tick it, save".
 *   - Requirements are grouped by the checklist they came from, in the order
 *     the tenant configured, so the list mirrors the paper checklist the user
 *     already knows. A search box handles long lists.
 *   - A live read-back sentence at the bottom states what will be saved, and
 *     an explicit warning appears when nothing is ticked — because a claim
 *     with no rule is silently inert, which is the failure mode that would
 *     otherwise be invisible until gap detection reported nothing.
 *   - Saving posts the WHOLE set (PUT /api/claim-rules). What you see ticked
 *     is what exists afterwards; there is no half-applied state.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  InputAdornment,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import {
  Close as CloseIcon,
  Search as SearchIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiClaimType, ApiClaimRule, ApiRequirement } from '../lib/types';

export interface ClaimRequirementsDialogProps {
  open: boolean;
  /** The claim being configured. Null renders nothing. */
  claimType: ApiClaimType | null;
  /** The tenant's active requirements, already loaded by the parent page. */
  requirements: ApiRequirement[];
  onClose: () => void;
  /** Called after a successful save so the parent can refresh its counts. */
  onSaved?: (rules: ApiClaimRule[]) => void;
}

/** Selection state per requirement: unticked, required, or advisory. */
type Selection = Map<string, { is_required: number }>;

const UNGROUPED = 'Other';

export function ClaimRequirementsDialog({
  open,
  claimType,
  requirements,
  onClose,
  onSaved,
}: ClaimRequirementsDialogProps) {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));

  const [selection, setSelection] = useState<Selection>(new Map());
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Load the claim's existing rules whenever the dialog opens for a claim.
  useEffect(() => {
    if (!open || !claimType) return;
    let cancelled = false;
    setLoading(true);
    setError('');
    setSearch('');
    api.claimRules
      .list({ claim_type_id: claimType.id, tenant_id: claimType.tenant_id })
      .then((res) => {
        if (cancelled) return;
        const next: Selection = new Map();
        for (const rule of res.rules) {
          next.set(rule.requirement_id, { is_required: rule.is_required ? 1 : 0 });
        }
        setSelection(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load rules');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, claimType]);

  const toggle = (requirementId: string) => {
    setSelection((prev) => {
      const next = new Map(prev);
      if (next.has(requirementId)) next.delete(requirementId);
      else next.set(requirementId, { is_required: 1 });
      return next;
    });
  };

  const setStrength = (requirementId: string, isRequired: number) => {
    setSelection((prev) => {
      const next = new Map(prev);
      next.set(requirementId, { is_required: isRequired });
      return next;
    });
  };

  // Group by checklist, preserving the tenant's configured ordering (the list
  // arrives sorted by checklist, sort_order, name).
  const groups = useMemo(() => {
    const term = search.trim().toLowerCase();
    const out = new Map<string, ApiRequirement[]>();
    for (const req of requirements) {
      if (term && !`${req.name} ${req.description ?? ''}`.toLowerCase().includes(term)) continue;
      const key = req.checklist || UNGROUPED;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(req);
    }
    return out;
  }, [requirements, search]);

  const byId = useMemo(() => {
    const m = new Map<string, ApiRequirement>();
    for (const r of requirements) m.set(r.id, r);
    return m;
  }, [requirements]);

  const requiredNames = [...selection.entries()]
    .filter(([, v]) => v.is_required === 1)
    .map(([id]) => byId.get(id)?.name)
    .filter(Boolean) as string[];
  const recommendedNames = [...selection.entries()]
    .filter(([, v]) => v.is_required === 0)
    .map(([id]) => byId.get(id)?.name)
    .filter(Boolean) as string[];

  const handleSave = async () => {
    if (!claimType) return;
    setSaving(true);
    setError('');
    try {
      const res = await api.claimRules.save({
        claim_type_id: claimType.id,
        requirements: [...selection.entries()].map(([requirement_id, v]) => ({
          requirement_id,
          is_required: v.is_required,
        })),
      });
      onSaved?.(res.rules);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save rules');
    } finally {
      setSaving(false);
    }
  };

  if (!claimType) return null;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth fullScreen={isMobile}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
        <Box>
          <Typography variant="h6" component="div" fontWeight={700}>
            When a document claims “{claimType.name}”…
          </Typography>
          <Typography variant="body2" color="text.secondary">
            …which documents does that make required? Tick everything that has to be on file.
          </Typography>
        </Box>
        <IconButton onClick={onClose} size="small" aria-label="Close">
          <CloseIcon />
        </IconButton>
      </DialogTitle>

      <DialogContent dividers>
        {error && (
          <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
            {error}
          </Alert>
        )}

        {loading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : requirements.length === 0 ? (
          <Alert severity="info">
            This tenant has no checklist items yet. Add them under Settings → Checklist first —
            a claim can only point at something already on the checklist.
          </Alert>
        ) : (
          <>
            <TextField
              fullWidth
              size="small"
              placeholder="Search the checklist…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ mb: 2 }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
              }}
            />

            {[...groups.entries()].map(([checklist, items]) => (
              <Box key={checklist} sx={{ mb: 2 }}>
                <Typography
                  variant="overline"
                  color="text.secondary"
                  sx={{ display: 'block', letterSpacing: 0.6 }}
                >
                  {checklist}
                </Typography>
                {items.map((req) => {
                  const sel = selection.get(req.id);
                  const checked = !!sel;
                  return (
                    <Box
                      key={req.id}
                      sx={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 1,
                        py: 0.5,
                        flexWrap: 'wrap',
                      }}
                    >
                      <Checkbox
                        checked={checked}
                        onChange={() => toggle(req.id)}
                        disabled={saving}
                        size="small"
                        sx={{ mt: -0.25 }}
                        inputProps={{ 'aria-label': req.name }}
                      />
                      <Box sx={{ flexGrow: 1, minWidth: 180 }}>
                        <Typography variant="body2" fontWeight={checked ? 600 : 400}>
                          {req.name}
                        </Typography>
                        {req.description && (
                          <Typography variant="caption" color="text.secondary">
                            {req.description}
                          </Typography>
                        )}
                      </Box>
                      {checked && (
                        <ToggleButtonGroup
                          size="small"
                          exclusive
                          value={sel!.is_required}
                          onChange={(_, v) => {
                            if (v !== null) setStrength(req.id, v);
                          }}
                          disabled={saving}
                        >
                          <ToggleButton value={1} sx={{ py: 0.25, px: 1, textTransform: 'none' }}>
                            Required
                          </ToggleButton>
                          <ToggleButton value={0} sx={{ py: 0.25, px: 1, textTransform: 'none' }}>
                            Recommended
                          </ToggleButton>
                        </ToggleButtonGroup>
                      )}
                    </Box>
                  );
                })}
              </Box>
            ))}

            {groups.size === 0 && (
              <Typography variant="body2" color="text.secondary" sx={{ py: 2 }}>
                Nothing on the checklist matches “{search}”.
              </Typography>
            )}
          </>
        )}
      </DialogContent>

      {/* Read-back: state in plain words exactly what saving will mean. */}
      <Box sx={{ px: 3, py: 2, bgcolor: 'action.hover' }}>
        <Divider sx={{ mb: 1, display: 'none' }} />
        {selection.size === 0 ? (
          <Alert severity="warning" sx={{ py: 0.5 }}>
            Nothing ticked — a document claiming “{claimType.name}” will not make any document
            required, so no gap will ever be reported for it.
          </Alert>
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {requiredNames.length > 0 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                <Typography variant="body2">
                  Claiming <strong>{claimType.name}</strong> requires:
                </Typography>
                {requiredNames.map((n) => (
                  <Chip key={n} size="small" color="primary" label={n} />
                ))}
              </Box>
            )}
            {recommendedNames.length > 0 && (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                <Typography variant="body2" color="text.secondary">
                  …and recommends:
                </Typography>
                {recommendedNames.map((n) => (
                  <Chip key={n} size="small" variant="outlined" label={n} />
                ))}
              </Box>
            )}
          </Box>
        )}
      </Box>

      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button variant="contained" onClick={handleSave} disabled={saving || loading}>
          {saving ? 'Saving…' : 'Save rules'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export default ClaimRequirementsDialog;
