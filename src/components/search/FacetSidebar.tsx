import { Box, Button, Stack, Typography } from '@mui/material';
import { FacetGroup } from './FacetGroup';
import type { FacetCount, FacetKind, SearchState } from '../../../shared/types';

/**
 * Side rail of facet groups for `<DocumentSearchPanel>`.
 *
 * Owns NO selection state — it renders whatever the parent panel hands
 * it via `state` and emits patch-shaped change events. The parent
 * applies them to its `useSearchParamsState` setter so the URL stays
 * the source of truth.
 *
 * Date is presented as a single-select bucket list (not a checkbox
 * grid) since "any" + 4 ranges is mutually exclusive — but we still
 * render it via FacetGroup for visual consistency, with selection
 * collapsed to one value.
 */
export interface FacetSidebarProps {
  state: SearchState;
  facets: Partial<Record<FacetKind, FacetCount[]>>;
  onChange: (patch: Partial<SearchState>) => void;
  loading?: boolean;
}

const KIND_TITLES: Record<FacetKind, string> = {
  supplier: 'Supplier',
  doc_type: 'Document Type',
  product: 'Product',
  status: 'Status',
  date: 'Date',
};

const ORDER: FacetKind[] = ['supplier', 'doc_type', 'product', 'status', 'date'];

export function FacetSidebar({
  state,
  facets,
  onChange,
  loading = false,
}: FacetSidebarProps) {
  const hasAny = ORDER.some((k) => (facets[k]?.length ?? 0) > 0);

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
      <Box
        sx={{
          px: 2,
          py: 1.25,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
        }}
      >
        <Typography variant="subtitle1" sx={{ flex: 1, fontWeight: 600 }}>
          Filters
        </Typography>
        <Button
          size="small"
          variant="text"
          onClick={() =>
            onChange({
              supplier: undefined,
              doc_type: undefined,
              product: undefined,
              status: undefined,
              customer: undefined,
              date: undefined,
            })
          }
          sx={{ textTransform: 'none' }}
        >
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
          {ORDER.map((kind) => {
            const opts = facets[kind] ?? [];
            if (opts.length === 0) return null;

            if (kind === 'date') {
              // Single-select bucket — emit `state.date` directly.
              const sel = state.date && state.date !== 'any' ? [state.date] : [];
              return (
                <FacetGroup
                  key={kind}
                  title={KIND_TITLES[kind]}
                  options={opts}
                  selected={sel}
                  onChange={(next) =>
                    onChange({ date: (next[next.length - 1] as SearchState['date']) ?? undefined })
                  }
                />
              );
            }

            const sel = (state[kind as keyof SearchState] as string[] | undefined) ?? [];
            return (
              <FacetGroup
                key={kind}
                title={KIND_TITLES[kind]}
                options={opts}
                selected={sel}
                onChange={(next) =>
                  onChange({ [kind]: next.length > 0 ? next : undefined } as Partial<SearchState>)
                }
              />
            );
          })}
        </Stack>
      )}
    </Box>
  );
}
