/**
 * "Closes these requirements" — the document-type -> requirement mapping
 * (migration 0100) edited OUTSIDE the setup wizard.
 *
 * Until this, the only editor was the wizard's teaching screen
 * (src/pages/setup/StepTeach.tsx), so a tenant past setup had no way to say
 * "a Country of Origin Statement closes Country of Origin" (AJ, 2026-09-20:
 * "where do I tell the portal that a Spec Sheet or a COO Statement can close
 * Country of Origin?"). Same endpoint as the wizard, `source: 'human'`.
 *
 * What a mapping DOES: approving a document of this type PROPOSES a link to
 * each requirement ticked here (status 'suggested'); a person still confirms
 * it. It never closes a requirement on its own, and it does not read the
 * document's fields.
 *
 * Controlled: the parent owns the selected ids and decides when to PUT.
 */
import { useEffect, useMemo, useState } from 'react';
import { Autocomplete, Box, Chip, TextField, Typography } from '@mui/material';
import { api } from '../lib/api';
import type { ApiRequirement } from '../lib/types';

export interface TypeClosesRequirementsFieldProps {
  tenantId: string | undefined;
  /** Selected requirement ids; null while the current mapping is still loading. */
  value: string[] | null;
  /** The mapping as stored when the dialog opened (to warn before clearing it). */
  initial: string[] | null;
  onChange: (ids: string[]) => void;
  disabled?: boolean;
}

export function TypeClosesRequirementsField({
  tenantId,
  value,
  initial,
  onChange,
  disabled,
}: TypeClosesRequirementsFieldProps) {
  const [options, setOptions] = useState<ApiRequirement[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    if (!tenantId) return;
    let cancelled = false;
    setLoadError('');
    api.requirements
      .list({ tenant_id: tenantId, active: 1, limit: 500 })
      .then((res) => {
        if (!cancelled) setOptions((res.requirements ?? []) as ApiRequirement[]);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Could not load requirements');
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  const byId = useMemo(() => new Map(options.map((r) => [r.id, r])), [options]);
  const selected = (value ?? []).map((id) => byId.get(id)).filter((r): r is ApiRequirement => !!r);
  const clearing = !!initial && initial.length > 0 && value !== null && value.length === 0;

  return (
    <Box sx={{ mb: 2 }}>
      <Autocomplete
        multiple
        size="small"
        options={options}
        value={selected}
        loading={value === null}
        disabled={disabled || value === null || !tenantId}
        groupBy={(r) => r.checklist || 'Ungrouped'}
        getOptionLabel={(r) => r.name}
        isOptionEqualToValue={(a, b) => a.id === b.id}
        onChange={(_e, rows) => onChange(rows.map((r) => r.id))}
        renderTags={(rows, getTagProps) =>
          rows.map((r, i) => {
            const { key, ...rest } = getTagProps({ index: i });
            return <Chip key={key} size="small" label={r.name} {...rest} />;
          })
        }
        renderInput={(params) => (
          <TextField {...params} label="Closes these requirements" placeholder={selected.length ? '' : 'None'} />
        )}
      />
      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
        Approving a document of this type proposes it against each requirement listed here; a
        reviewer still confirms each link. It goes by the type alone, not by what the document says.
      </Typography>
      {clearing && (
        <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
          Saving with nothing selected means documents of this type will no longer propose any
          requirement.
        </Typography>
      )}
      {loadError && (
        <Typography variant="body2" color="error" sx={{ mt: 0.5 }}>
          {loadError}
        </Typography>
      )}
    </Box>
  );
}
