import { Box, Chip, Stack } from '@mui/material';
import type { SearchState, FacetCount, FacetKind } from '../../../shared/types';

/**
 * Compact strip of selected-filter chips above the results grid.
 *
 * Each chip lets the user remove a single value without opening the
 * sidebar. Clicking a chip emits a patch that drops that one entry
 * (or unsets the date). The ID-only state arrays don't carry display
 * labels, so we look up labels from the current `facets` snapshot —
 * if a label isn't present (rare race) the chip falls back to the raw
 * id.
 */
export interface ActiveFilterChipsProps {
  state: SearchState;
  facets: Partial<Record<FacetKind, FacetCount[]>>;
  onChange: (patch: Partial<SearchState>) => void;
}

const KIND_PREFIX: Partial<Record<FacetKind, string>> = {
  supplier: 'Supplier:',
  doc_type: 'Type:',
  product: 'Product:',
  status: 'Status:',
  date: 'Date:',
};

function labelFor(kind: FacetKind, value: string, facets: ActiveFilterChipsProps['facets']): string {
  const opt = facets[kind]?.find((f) => f.value === value);
  return opt?.label ?? value;
}

export function ActiveFilterChips({ state, facets, onChange }: ActiveFilterChipsProps) {
  const chips: Array<{ key: string; label: string; onDelete: () => void }> = [];

  for (const kind of ['supplier', 'doc_type', 'product', 'status'] as const) {
    const values = state[kind];
    if (!values || values.length === 0) continue;
    for (const v of values) {
      chips.push({
        key: `${kind}:${v}`,
        label: `${KIND_PREFIX[kind]} ${labelFor(kind, v, facets)}`,
        onDelete: () => {
          const next = values.filter((x) => x !== v);
          onChange({ [kind]: next.length > 0 ? next : undefined } as Partial<SearchState>);
        },
      });
    }
  }

  if (state.date && state.date !== 'any') {
    chips.push({
      key: `date:${state.date}`,
      label: `${KIND_PREFIX.date} ${labelFor('date', state.date, facets)}`,
      onDelete: () => onChange({ date: undefined }),
    });
  }

  if (chips.length === 0) return null;

  return (
    <Box sx={{ mb: 1.5 }}>
      <Stack direction="row" spacing={0.75} useFlexGap flexWrap="wrap">
        {chips.map((chip) => (
          <Chip
            key={chip.key}
            label={chip.label}
            size="small"
            onDelete={chip.onDelete}
            variant="outlined"
            sx={{ bgcolor: 'background.paper' }}
          />
        ))}
      </Stack>
    </Box>
  );
}
