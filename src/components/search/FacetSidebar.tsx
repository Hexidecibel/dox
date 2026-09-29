import { Box, Button, Stack, Typography } from '@mui/material';
import { FacetGroup } from './FacetGroup';
import type { FacetCount } from '../../../shared/types';
import {
  selectedValues,
  withFieldValues,
  withoutScope,
  type SearchQuery,
} from '../../../shared/searchQuery';
import { FACET_FIELDS, uploadedBucketOf, UPLOADED_BUCKETS, type FacetField } from '../../../shared/searchFields';

/**
 * Side rail of facet groups for `<DocumentSearchPanel>`.
 *
 * Owns NO selection state — it renders the query the panel hands it and
 * emits the NEXT query. Every tick goes through `withFieldValues`, which
 * replaces only that field's clause: ticking a product never drops the
 * supplier ticked before it, and clearing one keeps the rest (AJ's I1 — the
 * old panel sent only the first supplier and type and never the product or
 * status at all).
 *
 * Uploaded is single-select: each option's value IS the clause it selects
 * (`within:30`), so the facet, the URL and the server share one vocabulary.
 */
export interface FacetSidebarProps {
  query: SearchQuery;
  facets: Partial<Record<FacetField, FacetCount[]>>;
  onChange: (next: SearchQuery) => void;
  loading?: boolean;
}

const TITLES: Record<FacetField, string> = {
  supplier: 'Supplier',
  document_type: 'Document Type',
  product: 'Product',
  status: 'Status',
  uploaded: 'Uploaded',
};

export function FacetSidebar({ query, facets, onChange, loading = false }: FacetSidebarProps) {
  const hasAny = FACET_FIELDS.some((k) => (facets[k]?.length ?? 0) > 0);

  return (
    <Box
      component="aside"
      sx={{
        width: { xs: '100%', md: 260 },
        flexShrink: 0,
        bgcolor: 'background.paper',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 1,
        overflow: 'hidden',
      }}
    >
      <Box sx={{ px: 2, py: 1.25, display: 'flex', alignItems: 'center', gap: 1 }}>
        <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>
          Filters
        </Typography>
        <Button size="small" variant="text" onClick={() => onChange(withoutScope(query))} sx={{ textTransform: 'none' }}>
          Clear
        </Button>
      </Box>
      {loading && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Typography variant="caption" color="text.secondary">
            Updating counts…
          </Typography>
        </Box>
      )}
      {!hasAny ? (
        <Box sx={{ px: 2, py: 3 }}>
          <Typography variant="caption" color="text.secondary">
            Run a search to see filter options.
          </Typography>
        </Box>
      ) : (
        <Stack>
          {FACET_FIELDS.map((field) => {
            const opts = facets[field] ?? [];
            if (opts.length === 0) return null;
            if (field === 'uploaded') {
              const current = query.clauses.find((c) => c.field === 'uploaded' && !c.exclude);
              const sel = current ? [uploadedBucketOf(current)].filter((v): v is string => !!v) : [];
              return (
                <FacetGroup
                  key={field}
                  title={TITLES[field]}
                  options={opts}
                  selected={sel}
                  onChange={(next) => {
                    const pick = next.filter((v) => !sel.includes(v)).pop();
                    const bucket = UPLOADED_BUCKETS.find((b) => b.value === pick);
                    onChange(bucket
                      ? withFieldValues(query, 'uploaded', [String(bucket.days)], bucket.op)
                      : withFieldValues(query, 'uploaded', []));
                  }}
                />
              );
            }
            return (
              <FacetGroup
                key={field}
                title={TITLES[field]}
                options={opts}
                selected={selectedValues(query, field)}
                onChange={(next) => onChange(withFieldValues(query, field, next))}
              />
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
