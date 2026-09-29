import { Box, Chip, Stack } from '@mui/material';
import type { FacetCount } from '../../../shared/types';
import {
  describeClause,
  withoutClause,
  withoutValue,
  type SearchQuery,
} from '../../../shared/searchQuery';
import { SEARCH_FIELDS, type FacetField } from '../../../shared/searchFields';

/**
 * Compact strip of the query's clauses above the results.
 *
 * A multi-value scope clause gets one chip per value (deleting it drops that
 * value); any other clause is one chip in its own words (`describeClause`).
 * Deleting a chip removes only what it names — every other clause stays.
 * Id values (suppliers, types, products) are named from the server's `labels`,
 * then from the current facets; a value neither knows falls back to the id.
 */
export interface ActiveFilterChipsProps {
  query: SearchQuery;
  facets: Partial<Record<FacetField, FacetCount[]>>;
  labels?: Record<string, string>;
  onChange: (next: SearchQuery) => void;
}

export function ActiveFilterChips({ query, facets, labels = {}, onChange }: ActiveFilterChipsProps) {
  const named = (field: string, v: string): string =>
    labels[v] ?? facets[field as FacetField]?.find((f) => f.value === v)?.label ?? v;

  const chips: Array<{ key: string; label: string; onDelete: () => void }> = [];
  for (const c of query.clauses) {
    const def = SEARCH_FIELDS[c.field];
    if (def.class === 'scope' && def.multi) {
      for (const v of c.values) {
        const one = { ...c, values: [v] };
        chips.push({
          key: `${c.id}:${v}`,
          label: describeClause(one, { [v]: named(c.field, v) }),
          onDelete: () => onChange(withoutValue(query, c.id, v)),
        });
      }
      continue;
    }
    chips.push({ key: c.id, label: describeClause(c, labels), onDelete: () => onChange(withoutClause(query, c.id)) });
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
            sx={{ bgcolor: 'background.paper', maxWidth: '100%' }}
          />
        ))}
      </Stack>
    </Box>
  );
}
