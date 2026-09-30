import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Button, Checkbox, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import BlockRoundedIcon from '@mui/icons-material/BlockRounded';
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import type { FacetCount } from '../../../shared/types';
import {
  excludedValues,
  selectedValues,
  toggleFacetValue,
  withFieldValues,
  withoutScope,
  type SearchQuery,
} from '../../../shared/searchQuery';
import { DATE_FACETS, FACET_FIELDS, SEARCH_FIELDS, UPLOADED_BUCKETS, uploadedBucketOf, type FacetField } from '../../../shared/searchFields';

/**
 * The Advanced facet rail (search Phase 3): every facet, with live counts that
 * CHANGE as filters stack — each facet's counts leave out that facet's own
 * selection (sticky exclusion), so a count is always "how many you would get
 * by adding this". A count that moved since the last answer shows by how much.
 *
 * Ticking a value adds it to (or extends) that field's clause row in the
 * builder, and removing either removes the other: they are the same clause.
 * `x` on a focused row — or the ⊘ button — EXCLUDES the value instead (scope
 * fields only; an excluded value is shown struck through with ↺ to undo).
 *
 * Presentational: it renders the query it is given and emits the next one.
 */
export interface AdvancedFacetRailProps {
  query: SearchQuery;
  facets: Partial<Record<FacetField, FacetCount[]>>;
  onChange: (next: SearchQuery) => void;
  loading?: boolean;
  /** For an identifying search the counts are over covering + likely answers. */
  countsAnswers?: boolean;
}

const TITLES: Record<FacetField, string> = {
  supplier: 'Supplier',
  document_type: 'Document type',
  product: 'Product',
  requirement: 'Satisfies requirement',
  claim: 'Triggers claim',
  renewal_state: 'Renewal',
  spec_verdict: 'Spec result',
  classification: 'Classification',
  owner: 'Owner',
  intake_source: 'Came in by',
  uploaded: 'Uploaded',
  approved: 'Approved',
  status: 'Status',
};

const LIMIT = 6;

export function AdvancedFacetRail({ query, facets, onChange, loading = false, countsAnswers = false }: AdvancedFacetRailProps) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // How far each count moved since the previous answer (computed once per answer).
  const last = useRef<Record<string, number>>({});
  const moves = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [field, opts] of Object.entries(facets)) {
      for (const o of opts ?? []) {
        const k = `${field}:${o.value}`;
        if (last.current[k] !== undefined && last.current[k] !== o.count) out[k] = o.count - last.current[k];
      }
    }
    return out;
  }, [facets]);
  useEffect(() => {
    const now: Record<string, number> = {};
    for (const [field, opts] of Object.entries(facets)) for (const o of opts ?? []) now[`${field}:${o.value}`] = o.count;
    last.current = { ...last.current, ...now };
  }, [facets]);

  const dateSelection = (field: FacetField): string | null => {
    const c = query.clauses.find((x) => x.field === field && !x.exclude);
    if (!c) return null;
    if (c.op === 'missing') return 'missing:1';
    return uploadedBucketOf(c);
  };

  const pickDate = (field: FacetField, value: string, current: string | null) => {
    if (value === current) return onChange(withFieldValues(query, field, []));
    if (value === 'missing:1') return onChange(withFieldValues(query, field, ['1'], 'missing'));
    const b = UPLOADED_BUCKETS.find((x) => x.value === value);
    if (b) onChange(withFieldValues(query, field, [String(b.days)], b.op));
  };

  const groups = FACET_FIELDS.map((field) => {
    const opts = facets[field] ?? [];
    if (opts.length === 0) return null;
    const isDate = DATE_FACETS.has(field);
    const sel = isDate ? [dateSelection(field)].filter((v): v is string => !!v) : selectedValues(query, field);
    const ex = isDate ? [] : excludedValues(query, field);
    const excludable = SEARCH_FIELDS[field].excludable;
    let lastChosen = -1;
    opts.forEach((o, i) => {
      if (sel.includes(o.value) || ex.includes(o.value)) lastChosen = i;
    });
    const shown = open[field] ? opts : opts.slice(0, Math.max(LIMIT, lastChosen + 1));
    return (
      <Box key={field} data-testid={`facet-${field}`}>
        <Typography variant="overline" sx={{ display: 'block', color: 'text.secondary', fontSize: '0.66rem', letterSpacing: '0.08em', lineHeight: 1.8 }}>
          {TITLES[field]}
        </Typography>
        {shown.map((o) => {
          const delta = moves[`${field}:${o.value}`];
          const moved = delta !== undefined;
          const on = sel.includes(o.value);
          const off = ex.includes(o.value);
          const toggle = (exclude: boolean) => {
            if (isDate) pickDate(field, o.value, sel[0] ?? null);
            else onChange(toggleFacetValue(query, field, o.value, exclude));
          };
          return (
            <Box
              key={o.value}
              role="checkbox"
              aria-checked={on}
              tabIndex={0}
              data-facet={field}
              data-value={o.value}
              onClick={(e) => toggle(e.altKey && excludable)}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  toggle(false);
                } else if ((e.key === 'x' || e.key === 'X') && excludable && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  toggle(true);
                }
              }}
              sx={{
                display: 'grid',
                gridTemplateColumns: '18px minmax(0,1fr) auto 22px',
                alignItems: 'center',
                gap: 0.75,
                px: 0.5,
                py: 0.2,
                borderRadius: 1,
                cursor: 'pointer',
                opacity: o.count === 0 && !on && !off ? 0.5 : 1,
                '&:hover, &:focus-visible': { bgcolor: 'action.hover', outline: 'none' },
                '&:hover .facet-ex, &:focus-visible .facet-ex': { opacity: 1 },
              }}
            >
              <Checkbox size="small" checked={on} tabIndex={-1} onChange={() => {}} sx={{ p: 0 }} inputProps={{ 'aria-hidden': true }} />
              <Typography
                variant="body2"
                noWrap
                title={o.label}
                sx={{ textDecoration: off ? 'line-through' : 'none', color: off ? 'text.secondary' : 'text.primary' }}
              >
                {o.label}
              </Typography>
              <Typography variant="caption" sx={{ color: moved ? 'info.main' : 'text.secondary', fontVariantNumeric: 'tabular-nums', fontWeight: moved ? 700 : 400 }}>
                {moved && (
                  <Box component="span" sx={{ mr: 0.5, fontSize: '0.65rem' }}>
                    {delta > 0 ? '+' : '−'}{Math.abs(delta)}
                  </Box>
                )}
                {o.count}
              </Typography>
              {excludable && !isDate ? (
                <Tooltip title={off ? 'Stop excluding' : 'Exclude (x)'}>
                  <IconButton
                    size="small"
                    className="facet-ex"
                    aria-label={off ? `Stop excluding ${o.label}` : `Exclude ${o.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(true);
                    }}
                    sx={{ p: 0.25, opacity: off ? 1 : 0, transition: 'opacity .12s' }}
                    data-testid={`facet-exclude-${field}-${o.value}`}
                  >
                    {off ? <ReplayRoundedIcon sx={{ fontSize: 15 }} /> : <BlockRoundedIcon sx={{ fontSize: 15 }} />}
                  </IconButton>
                </Tooltip>
              ) : <span />}
            </Box>
          );
        })}
        {opts.length > shown.length && (
          <Button size="small" onClick={() => setOpen((s) => ({ ...s, [field]: true }))} sx={{ textTransform: 'none', py: 0, minWidth: 0 }}>
            {opts.length - shown.length} more
          </Button>
        )}
      </Box>
    );
  }).filter(Boolean);

  return (
    <Box component="aside" aria-label="Facets" data-testid="advanced-facets" sx={{ position: { md: 'sticky' }, top: 16, maxHeight: { md: 'calc(100vh - 32px)' }, overflowY: { md: 'auto' }, pr: 0.5 }}>
      <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ flex: 1, fontWeight: 700 }}>Filters</Typography>
        <Button size="small" onClick={() => onChange(withoutScope(query))} sx={{ textTransform: 'none' }}>Clear</Button>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        {loading ? 'Updating counts…' : countsAnswers ? 'Counts are documents that cover or likely cover what you asked.' : 'Each count is what adding that value would leave. x excludes.'}
      </Typography>
      {groups.length === 0 ? (
        <Typography variant="caption" color="text.secondary">Run a search to see filter options.</Typography>
      ) : (
        <Stack spacing={1.75}>{groups}</Stack>
      )}
    </Box>
  );
}
