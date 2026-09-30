import {
  Box,
  Button,
  Checkbox,
  Chip,
  Link,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import { Link as RouterLink } from 'react-router-dom';
import type { SearchDocColumns, SearchGroupRow, SearchQueryResponse, UniversalSearchDocument } from '../../../shared/types';
import {
  enumLabel,
  INTAKE_SOURCE_LABELS,
  SEARCH_COLUMNS,
  SPEC_VERDICT_LABELS,
  type SearchEntity,
} from '../../../shared/searchFields';
import { viewColumns, withClause, type SearchQuery } from '../../../shared/searchQuery';
import { formatIsoHuman } from '../../../shared/searchDates';
import { ColumnChooser } from './ColumnChooser';
import type { SearchSelection } from './SelectableResult';

/**
 * The Advanced results (search Phase 3): a result MODE — Documents / Lots /
 * Products / Suppliers — over the same matching documents, and for Documents a
 * table whose columns are chosen (and saved with the view).
 *
 *   - Selection keeps the 0115 gates exactly: a covering row (or any row of a
 *     search that made no coverage claim) has a checkbox; a likely or nearby
 *     row needs an explicit "Include anyway" first.
 *   - A Lots / Products / Suppliers row counts the documents behind it — for a
 *     coverage search only those that cover or likely cover, never a nearby
 *     one — and "Show documents" narrows the Documents view to it.
 */
export interface AdvancedResultsProps {
  data: SearchQueryResponse;
  query: SearchQuery;
  onQuery: (next: SearchQuery) => void;
  selection?: SearchSelection;
  onActivate: (doc: UniversalSearchDocument, how?: 'click' | 'focus') => void;
  activeId: string | null;
}

const MODES: Array<{ value: SearchEntity; label: string }> = [
  { value: 'documents', label: 'Documents' },
  { value: 'lots', label: 'Lots' },
  { value: 'products', label: 'Products' },
  { value: 'suppliers', label: 'Suppliers' },
];

const BAND: Record<string, { label: string; color: 'success' | 'warning' | 'default' }> = {
  covering: { label: 'Covers', color: 'success' },
  likely_covering: { label: 'Likely · confirm', color: 'warning' },
  candidate_not_matching: { label: 'Nearby · does not cover', color: 'default' },
};

function day(v: unknown): string {
  if (typeof v !== 'string' || !v) return '—';
  const iso = v.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? formatIsoHuman(iso) : v;
}

function cell(key: string, doc: UniversalSearchDocument, cols: SearchDocColumns | undefined): React.ReactNode {
  const c = cols;
  const dash = <Typography component="span" variant="body2" color="text.disabled">—</Typography>;
  const text = (v: string | null | undefined, mono = false) => (v ? <Box component="span" sx={mono ? { fontFamily: 'ui-monospace, monospace', fontSize: '0.8rem' } : undefined}>{v}</Box> : dash);
  switch (key) {
    case 'type': return text(doc.document_type_name ?? null);
    case 'supplier': return text(doc.supplier_name ?? null);
    case 'products': return text(c?.products.join('; ') || null);
    case 'lots': return c?.lots.length ? text(c.lots.slice(0, 3).join(', ') + (c.lots.length > 3 ? ` +${c.lots.length - 3}` : ''), true) : dash;
    case 'production': return c?.production ? day(c.production) : dash;
    case 'code_best_by': return text(c?.code_best_by);
    case 'renewal_due': return c?.renewal_due ? day(c.renewal_due) : dash;
    case 'renewal_state': return c?.renewal_state ? enumLabel('renewal_state', c.renewal_state) : dash;
    case 'spec_verdict': {
      const v = c?.spec_verdict;
      if (!v) return dash;
      const color = v === 'out_of_spec' ? 'error' : v === 'not_checked' ? 'warning' : v === 'in_spec' ? 'success' : 'default';
      return <Chip size="small" variant="outlined" color={color} label={SPEC_VERDICT_LABELS[v] ?? v} />;
    }
    case 'classification': return c?.classification ? enumLabel('classification', c.classification) : dash;
    case 'owner': return text(c?.owner);
    case 'intake_source': return c?.intake_source ? INTAKE_SOURCE_LABELS[c.intake_source] ?? c.intake_source : <Typography component="span" variant="body2" color="text.disabled">Not recorded</Typography>;
    case 'uploaded': return day(doc.created_at);
    case 'approved': return c?.approved ? day(c.approved) : <Typography component="span" variant="body2" color="text.disabled">Not recorded</Typography>;
    case 'document_number': return text(c?.document_number, true);
    case 'certificate_number': return text(c?.certificate_number, true);
    case 'po': return text(c?.po, true);
    case 'shelf_life': return text(c?.shelf_life);
    default: return dash;
  }
}

export function AdvancedResults({ data, query, onQuery, selection, onActivate, activeId }: AdvancedResultsProps) {
  const entity = query.view.entity ?? 'documents';
  const claim = !!data.coverage && data.coverage !== 'unconstrained';
  const columns = viewColumns(query.view);
  const setView = (patch: Partial<SearchQuery['view']>) => onQuery({ ...query, view: { ...query.view, ...patch, page: undefined } });
  const count = entity === 'documents' ? data.total : data.groups?.total ?? 0;
  const unit = entity === 'documents' ? (data.total === 1 ? 'document' : 'documents') : entity;

  return (
    <Box data-testid="advanced-results">
      <Stack direction="row" alignItems="center" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', mb: 1 }}>
        <Typography variant="h6" component="p" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
          {count} <Typography component="span" variant="body2" color="text.secondary">{unit}</Typography>
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={entity}
          onChange={(_, v: SearchEntity | null) => v && setView({ entity: v === 'documents' ? 'documents' : v })}
          aria-label="Result mode"
          sx={{ '& .MuiToggleButton-root': { textTransform: 'none', py: 0.25, px: 1.25 } }}
        >
          {MODES.map((m) => <ToggleButton key={m.value} value={m.value} data-testid={`result-mode-${m.value}`}>{m.label}</ToggleButton>)}
        </ToggleButtonGroup>
        <Box sx={{ flex: 1 }} />
        {entity === 'documents' && <ColumnChooser columns={columns} onChange={(cols) => setView({ columns: cols })} />}
      </Stack>

      {entity === 'documents' ? (
        <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, maxWidth: '100%', overflowX: 'auto' }}>
          <Table size="small" data-testid="advanced-table">
            <TableHead>
              <TableRow>
                {selection && <TableCell padding="checkbox" />}
                {columns.map((k) => (
                  <TableCell key={k} sx={{ fontWeight: 650, whiteSpace: 'nowrap' }}>{SEARCH_COLUMNS.find((c) => c.key === k)?.label ?? k}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {data.documents.map((doc) => {
                const band = claim ? BAND[String(doc.match_status ?? '')] : undefined;
                const mode = !claim ? 'plain' : doc.match_status === 'covering' ? 'covering' : 'opt_in';
                const checked = selection?.selectedIds.has(doc.id) ?? false;
                const needsOptIn = mode === 'opt_in' && !checked && !selection?.includedAnyway.has(doc.id);
                return (
                  <TableRow
                    key={doc.id}
                    hover
                    selected={activeId === doc.id}
                    tabIndex={0}
                    data-nav-row
                    data-doc-id={doc.id}
                    onFocus={() => onActivate(doc, 'focus')}
                    onClick={() => onActivate(doc, 'click')}
                    sx={{ cursor: 'pointer', opacity: doc.match_status === 'candidate_not_matching' ? 0.7 : 1 }}
                  >
                    {selection && (
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        {needsOptIn ? (
                          <Tooltip title="This does not match everything you asked for. Include it anyway.">
                            <Button size="small" onClick={() => selection.onIncludeAnyway(doc)} sx={{ textTransform: 'none', minWidth: 0, px: 0.5, fontSize: '0.7rem', lineHeight: 1.2 }} data-testid={`include-anyway-${doc.id}`}>
                              Include anyway
                            </Button>
                          </Tooltip>
                        ) : (
                          <Checkbox size="small" checked={checked} onChange={() => selection.onToggle(doc)} inputProps={{ 'aria-label': `Select ${doc.title ?? 'document'}`, 'data-testid': `select-${doc.id}` } as React.InputHTMLAttributes<HTMLInputElement>} />
                        )}
                      </TableCell>
                    )}
                    {columns.map((k) => (
                      <TableCell key={k} sx={{ verticalAlign: 'top', maxWidth: k === 'title' ? 320 : 220 }}>
                        {k === 'title' ? (
                          <Stack spacing={0.25}>
                            <Link component={RouterLink} to={`/documents/${doc.id}`} underline="hover" onClick={(e) => e.stopPropagation()} sx={{ fontWeight: 600 }}>
                              {doc.title ?? doc.id}
                            </Link>
                            {band && <Chip size="small" color={band.color} variant={band.color === 'default' ? 'outlined' : 'filled'} label={band.label} sx={{ alignSelf: 'flex-start', height: 20 }} />}
                          </Stack>
                        ) : (
                          <Typography component="div" variant="body2" noWrap>
                            {cell(k, doc, data.columns?.[doc.id])}
                          </Typography>
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
              {data.documents.length === 0 && (
                <TableRow>
                  <TableCell colSpan={columns.length + (selection ? 1 : 0)} sx={{ py: 3, textAlign: 'center', color: 'text.secondary' }}>
                    No documents match every filter. The facet counts show where removing one would lead.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      ) : (
        <GroupTable
          entity={entity}
          rows={data.groups?.rows ?? []}
          capped={!!data.groups?.capped}
          claim={claim}
          onShow={(r) => onQuery(showGroup(query, entity, r))}
        />
      )}

      {(data.unreviewed_candidates ?? []).length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Typography variant="caption" color="text.secondary">
            Still in the Review Queue — not on file until approved:{' '}
            {(data.unreviewed_candidates ?? []).map((u, i) => (
              <span key={u.queue_id}>
                {i ? ', ' : ''}
                <Link component={RouterLink} to={u.review_url}>{u.file_name ?? u.queue_id}</Link>
              </span>
            ))}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

/** "Show documents": back to the Documents view, narrowed to the row. */
function showGroup(query: SearchQuery, entity: SearchEntity, r: SearchGroupRow): SearchQuery {
  const docs = { ...query, view: { ...query.view, entity: 'documents' as const, page: undefined } };
  if (entity === 'suppliers') return withClause(docs, { field: 'supplier', op: 'in', values: [r.key], source: 'builder' });
  if (entity === 'products') return withClause(docs, { field: 'product', op: 'in', values: [r.key], source: 'builder' });
  const [lot, sub] = r.label.split(' · sublot ');
  return withClause(docs, { field: 'lot', op: 'is', values: [lot.trim()], ...(sub ? { sublot: sub.trim() } : {}), source: 'builder' });
}

function GroupTable({ entity, rows, capped, claim, onShow }: {
  entity: SearchEntity;
  rows: SearchGroupRow[];
  capped: boolean;
  claim: boolean;
  onShow: (r: SearchGroupRow) => void;
}) {
  const noun = entity === 'lots' ? 'Lot' : entity === 'products' ? 'Product' : 'Supplier';
  return (
    <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
      <Table size="small" data-testid={`group-table-${entity}`}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 650 }}>{noun}</TableCell>
            <TableCell sx={{ fontWeight: 650 }} align="right">{claim ? 'Covering · likely' : 'Documents'}</TableCell>
            {entity !== 'suppliers' && <TableCell sx={{ fontWeight: 650 }} align="right">{entity === 'lots' ? 'Produced' : 'Lots'}</TableCell>}
            {entity === 'products' && <TableCell sx={{ fontWeight: 650 }}>Latest production</TableCell>}
            <TableCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.key} hover>
              <TableCell>
                <Stack spacing={0.1}>
                  {r.href ? (
                    <Link component={RouterLink} to={r.href} underline="hover" sx={{ fontWeight: 600, fontFamily: entity === 'lots' ? 'ui-monospace, monospace' : undefined }}>{r.label}</Link>
                  ) : (
                    <Typography variant="body2" sx={{ fontWeight: 600, fontFamily: entity === 'lots' ? 'ui-monospace, monospace' : undefined }}>{r.label}</Typography>
                  )}
                  {r.detail && <Typography variant="caption" color="text.secondary">{r.detail}</Typography>}
                </Stack>
              </TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {claim ? `${r.covering_count ?? 0} · ${r.likely_count ?? 0}` : r.document_count}
              </TableCell>
              {entity !== 'suppliers' && (
                <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {entity === 'lots' ? day(r.latest_production_date) : r.lot_count ?? 0}
                </TableCell>
              )}
              {entity === 'products' && <TableCell>{day(r.latest_production_date)}</TableCell>}
              <TableCell align="right">
                <Button size="small" onClick={() => onShow(r)} sx={{ textTransform: 'none' }} data-testid={`group-show-${r.key}`}>Show documents</Button>
              </TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} sx={{ py: 3, textAlign: 'center', color: 'text.secondary' }}>
                No {entity} {claim ? 'cover what you asked for' : 'match every filter'}.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {capped && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1 }}>Showing the first {rows.length}. Add a filter to narrow it.</Typography>}
    </TableContainer>
  );
}
