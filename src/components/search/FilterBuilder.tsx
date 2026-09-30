import { useEffect, useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  IconButton,
  ListSubheader,
  MenuItem,
  Select,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import AddRoundedIcon from '@mui/icons-material/AddRounded';
import type { FacetCount } from '../../../shared/types';
import {
  enumLabel,
  enumOptions,
  FIELD_KEYS,
  SEARCH_FIELDS,
  validateClause,
  type ClauseOp,
  type FacetField,
  type FieldKey,
  type SearchEntity,
} from '../../../shared/searchFields';
import { replaceClause, withClause, withoutClause, type Clause, type SearchQuery } from '../../../shared/searchQuery';
import { dateInputText, parseDateInput, sourceWords } from '../../lib/searchChips';
import { api } from '../../lib/api';
import { AI_VIOLET } from './ClauseChip';

/**
 * The Advanced filter builder (search Phase 3): one row per clause —
 *
 *   [where / and] [field ▾] [operator ▾] [value(s)] [Include | Exclude] [×]
 *
 * The rows ARE the query's clauses — the same `Clause[]` the Easy chips show —
 * so switching modes loses nothing: a chip is a row, a row is a chip, and the
 * words left in the box are a "Mentions" row. A row whose field does not apply
 * to the current result mode is greyed with "doesn't apply to lots" and kept.
 *
 * A row is sent only once it would validate (the server's own rule,
 * `validateClause`); until then it is a draft that says what is missing.
 * Exclude is offered only on scope fields: "not lot X" is not a question a
 * document can cover.
 */
export interface FilterBuilderProps {
  query: SearchQuery;
  labels: Record<string, string>;
  facets: Partial<Record<FacetField, FacetCount[]>>;
  onChange: (next: SearchQuery) => void;
  notApplied: string[];
  entity: SearchEntity;
  tenantId?: string;
  onLabel?: (id: string, name: string) => void;
}

const OP_WORDS: Record<ClauseOp, string> = {
  in: 'is any of',
  is: 'is',
  starts: 'starts with',
  on: 'on',
  between: 'between',
  before: 'before',
  after: 'after',
  within: 'in the last',
  older_than: 'more than',
  contains: 'contains',
  missing: 'is not recorded',
};

const SCOPE_KEYS = FIELD_KEYS.filter((k) => SEARCH_FIELDS[k].class === 'scope');
const IDENT_KEYS = FIELD_KEYS.filter((k) => SEARCH_FIELDS[k].class === 'identifying');

function defaultValues(field: FieldKey, op: ClauseOp): string[] {
  if (op === 'within' || op === 'older_than') return ['30'];
  if (op === 'missing') return ['1'];
  if (field === 'status') return ['active'];
  return [];
}

function blank(field: FieldKey, id: string): Clause {
  const def = SEARCH_FIELDS[field];
  return { id, field, op: def.defaultOp, values: defaultValues(field, def.defaultOp), source: 'builder', ...(field === 'date' ? { role: 'any' as const } : {}) };
}

const segSx = { '& .MuiToggleButton-root': { textTransform: 'none', py: 0.25, px: 1, fontSize: '0.78rem' } } as const;

export function FilterBuilder({ query, labels, facets, onChange, notApplied, entity, tenantId, onLabel }: FilterBuilderProps) {
  const [drafts, setDrafts] = useState<Clause[]>([]);
  const rows: Array<{ clause: Clause; draft: boolean }> = [
    ...query.clauses.map((c) => ({ clause: c, draft: false })),
    ...drafts.map((c) => ({ clause: c, draft: true })),
  ];

  const commit = (row: { clause: Clause; draft: boolean }, next: Clause) => {
    if (row.draft) {
      setDrafts((d) => d.filter((x) => x.id !== row.clause.id));
      const { id: _id, ...rest } = next;
      onChange(withClause(query, rest));
    } else {
      onChange(replaceClause(query, row.clause.id, next));
    }
  };
  /** A row that cannot run yet: a draft. A committed row turned incomplete leaves the query until it is whole again. */
  const updateDraft = (row: { clause: Clause; draft: boolean }, next: Clause) => {
    if (row.draft) {
      setDrafts((d) => d.map((x) => (x.id === row.clause.id ? next : x)));
      return;
    }
    setDrafts((d) => [...d, { ...next, id: `new-${Date.now()}-${d.length}` }]);
    onChange(withoutClause(query, row.clause.id));
  };
  const remove = (row: { clause: Clause; draft: boolean }) => {
    if (row.draft) setDrafts((d) => d.filter((x) => x.id !== row.clause.id));
    else onChange(withoutClause(query, row.clause.id));
  };

  return (
    <Box data-testid="filter-builder" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 1, bgcolor: 'background.paper' }}>
      {rows.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1, py: 1.5 }}>
          No filters. Tick a facet, add a filter, or type above.
        </Typography>
      )}
      {rows.map((row, i) => (
        <FilterRow
          key={row.clause.id}
          index={i}
          clause={row.clause}
          draft={row.draft}
          labels={labels}
          facets={facets}
          notApplied={notApplied.includes(row.clause.id)}
          entity={entity}
          tenantId={tenantId}
          onLabel={onLabel}
          onCommit={(next) => commit(row, next)}
          onDraft={(next) => updateDraft(row, next)}
          onRemove={() => remove(row)}
        />
      ))}
      <Button
        size="small"
        startIcon={<AddRoundedIcon />}
        onClick={() => setDrafts((d) => [...d, blank('supplier', `new-${Date.now()}-${d.length}`)])}
        sx={{ textTransform: 'none', mt: 0.5 }}
        data-testid="add-filter"
      >
        Add filter
      </Button>
    </Box>
  );
}

interface FilterRowProps {
  index: number;
  clause: Clause;
  draft: boolean;
  labels: Record<string, string>;
  facets: Partial<Record<FacetField, FacetCount[]>>;
  notApplied: boolean;
  entity: SearchEntity;
  tenantId?: string;
  onLabel?: (id: string, name: string) => void;
  onCommit: (next: Clause) => void;
  onDraft: (next: Clause) => void;
  onRemove: () => void;
}

function FilterRow({ index, clause, draft, labels, facets, notApplied, entity, tenantId, onLabel, onCommit, onDraft, onRemove }: FilterRowProps) {
  const def = SEARCH_FIELDS[clause.field];
  const [error, setError] = useState<string | null>(null);

  const attempt = (next: Clause) => {
    const err = validateClause(next);
    if (err) {
      setError(err);
      if (draft) onDraft(next);
      return;
    }
    setError(null);
    onCommit(next);
  };

  const changeField = (field: FieldKey) => {
    const b = blank(field, clause.id);
    setError(null);
    // A field change is a new question: a draft until it has a value.
    if (validateClause(b)) onDraft(b);
    else onCommit(b);
  };

  const changeOp = (op: ClauseOp) => {
    const values = op === 'within' || op === 'older_than' || op === 'missing' ? defaultValues(clause.field, op)
      : op === 'between' ? [clause.values[0] ?? '', clause.values[1] ?? clause.values[0] ?? ''] : clause.values.slice(0, 1);
    attempt({ ...clause, op, values });
  };

  const src = clause.source === 'ai' ? '✦ AI' : clause.source === 'detected' ? 'read' : clause.source === 'facet' ? 'facet' : null;

  return (
    <Box
      data-testid={`filter-row-${index}`}
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr 1fr', md: '58px 170px 130px minmax(0,1fr) auto 30px' },
        gap: 1,
        alignItems: 'center',
        px: 0.5,
        py: 0.75,
        borderRadius: 1.5,
        opacity: notApplied ? 0.55 : 1,
        bgcolor: clause.exclude ? 'rgba(211,47,47,0.04)' : 'transparent',
        '& + &': { borderTop: '1px dashed', borderColor: 'divider' },
      }}
    >
      <Box sx={{ gridColumn: { xs: '1 / -1', md: 'auto' }, display: 'flex', flexDirection: { xs: 'row', md: 'column' }, gap: 0.5 }}>
        <Typography variant="caption" sx={{ textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 650, color: 'text.secondary' }}>
          {index ? 'and' : 'where'}
        </Typography>
        {src && (
          <Tooltip title={sourceWords(clause)}>
            <Typography variant="caption" sx={{ fontSize: '0.65rem', color: clause.source === 'ai' ? AI_VIOLET : 'text.disabled' }}>{src}</Typography>
          </Tooltip>
        )}
      </Box>
      <Select
        size="small"
        value={clause.field}
        onChange={(e) => changeField(e.target.value as FieldKey)}
        inputProps={{ 'aria-label': 'Field', 'data-testid': `filter-field-${index}` }}
        sx={{ fontSize: '0.85rem' }}
      >
        <ListSubheader>Narrow to</ListSubheader>
        {SCOPE_KEYS.map((k) => <MenuItem key={k} value={k}>{SEARCH_FIELDS[k].label}</MenuItem>)}
        <ListSubheader>Find what covers</ListSubheader>
        {IDENT_KEYS.map((k) => <MenuItem key={k} value={k}>{SEARCH_FIELDS[k].label}</MenuItem>)}
        <ListSubheader>Words</ListSubheader>
        <MenuItem value="text">Mentions</MenuItem>
      </Select>
      <Select
        size="small"
        value={clause.op}
        onChange={(e) => changeOp(e.target.value as ClauseOp)}
        disabled={def.ops.length < 2}
        inputProps={{ 'aria-label': 'Operator', 'data-testid': `filter-op-${index}` }}
        sx={{ fontSize: '0.85rem' }}
      >
        {def.ops.map((op) => <MenuItem key={op} value={op}>{OP_WORDS[op]}</MenuItem>)}
      </Select>
      <Box sx={{ gridColumn: { xs: '1 / -1', md: 'auto' }, minWidth: 0 }}>
        <ValueEditor clause={clause} labels={labels} facets={facets} tenantId={tenantId} onLabel={onLabel} onValues={(next) => attempt(next)} />
      </Box>
      <ToggleButtonGroup
        exclusive
        size="small"
        sx={segSx}
        value={clause.exclude ? 'ex' : 'in'}
        onChange={(_, v: 'in' | 'ex' | null) => v && attempt({ ...clause, exclude: v === 'ex' ? true : undefined })}
        disabled={!def.excludable}
        aria-label="Include or exclude"
      >
        <ToggleButton value="in">Include</ToggleButton>
        <Tooltip title={def.excludable ? '' : def.class === 'identifying' ? `"Not ${def.label.toLowerCase()} X" is not a question a document can cover.` : 'Cannot be excluded.'}>
          <span>
            <ToggleButton value="ex" disabled={!def.excludable} data-testid={`filter-exclude-${index}`}>Exclude</ToggleButton>
          </span>
        </Tooltip>
      </ToggleButtonGroup>
      <IconButton size="small" onClick={onRemove} aria-label={`Remove ${def.label} filter`} data-testid={`filter-remove-${index}`}>
        <CloseRoundedIcon fontSize="small" />
      </IconButton>
      {(notApplied || error || clause.note || draft) && (
        <Box sx={{ gridColumn: { xs: '1 / -1', md: '2 / -1' }, mt: -0.25 }}>
          {notApplied && (
            <Typography variant="caption" sx={{ display: 'block', fontStyle: 'italic', color: 'text.secondary' }} data-testid={`filter-na-${index}`}>
              Doesn't apply to {entity}. Kept, and applies again when you switch back.
            </Typography>
          )}
          {error && <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>{error}</Typography>}
          {!error && draft && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Choose a value to apply this filter.</Typography>}
          {clause.note && (
            <Typography variant="caption" sx={{ display: 'block', color: clause.source === 'ai' ? AI_VIOLET : clause.ambiguous ? 'warning.dark' : 'text.secondary' }}>
              {clause.source === 'ai' ? '✦ ' : ''}{clause.note}
            </Typography>
          )}
        </Box>
      )}
    </Box>
  );
}

interface ValueEditorProps {
  clause: Clause;
  labels: Record<string, string>;
  facets: Partial<Record<FacetField, FacetCount[]>>;
  tenantId?: string;
  onLabel?: (id: string, name: string) => void;
  onValues: (next: Clause) => void;
}

interface Opt { value: string; label: string; count?: number }

function ValueEditor({ clause, labels, facets, tenantId, onLabel, onValues }: ValueEditorProps) {
  const def = SEARCH_FIELDS[clause.field];
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [sub, setSub] = useState(clause.sublot ?? '');
  const isDate = def.valueKind === 'date';
  useEffect(() => {
    if (isDate && clause.op !== 'within' && clause.op !== 'older_than') {
      setA(dateInputText(clause.values[0]));
      setB(dateInputText(clause.values[1]));
    } else {
      setA(clause.values[0] ?? '');
      setB(clause.values[1] ?? '');
    }
    setSub(clause.sublot ?? '');
  }, [clause, isDate]);

  // --- scope: pick values (facet options with counts, or the closed vocabulary)
  const scopeOptions = useMemo<Opt[]>(() => {
    const fromFacet: Opt[] = (facets[clause.field as FacetField] ?? []).map((f) => ({ value: f.value, label: f.label, count: f.count }));
    const closed = enumOptions(clause.field) ?? [];
    const out: Opt[] = [...fromFacet];
    for (const c of closed) if (!out.some((o) => o.value === c.value)) out.push({ value: c.value, label: c.label });
    for (const v of clause.values) if (!out.some((o) => o.value === v)) out.push({ value: v, label: labels[v] ?? enumLabel(clause.field, v) });
    return out;
  }, [facets, clause.field, clause.values, labels]);

  // --- customer: looked up as typed
  const [customerOpts, setCustomerOpts] = useState<Opt[]>([]);
  const [customerText, setCustomerText] = useState('');
  useEffect(() => {
    if (clause.field !== 'customer') return;
    let live = true;
    const t = setTimeout(() => {
      Promise.resolve(api.customers.list({ tenant_id: tenantId, search: customerText || undefined, limit: 20 }) as Promise<unknown>)
        .then((res) => {
          if (!live) return;
          const list = ((res as { customers?: Array<{ id: string; name: string; customer_number?: string }> })?.customers ?? []);
          setCustomerOpts(list.map((c) => ({ value: c.id, label: c.customer_number ? `${c.name} (${c.customer_number})` : c.name })));
        })
        .catch(() => live && setCustomerOpts([]));
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [clause.field, customerText, tenantId]);

  if (clause.field === 'customer') {
    const current = clause.values[0] ? { value: clause.values[0], label: labels[clause.values[0]] ?? clause.values[0] } : null;
    return (
      <Autocomplete
        size="small"
        options={customerOpts}
        value={current}
        filterOptions={(x) => x}
        isOptionEqualToValue={(o, v) => o.value === v.value}
        getOptionLabel={(o) => o.label}
        onInputChange={(_, v) => setCustomerText(v)}
        onChange={(_, v) => {
          if (!v) return;
          onLabel?.(v.value, v.label);
          onValues({ ...clause, values: [v.value] });
        }}
        renderInput={(p) => <TextField {...p} placeholder="Customer name or number" inputProps={{ ...p.inputProps, 'data-testid': 'filter-customer' }} />}
      />
    );
  }

  if (def.class === 'scope' && !isDate) {
    const selected = scopeOptions.filter((o) => clause.values.includes(o.value));
    return (
      <Autocomplete
        multiple
        size="small"
        options={scopeOptions}
        value={selected}
        freeSolo={clause.field === 'owner'}
        isOptionEqualToValue={(o, v) => o.value === v.value}
        getOptionLabel={(o) => (typeof o === 'string' ? o : o.label)}
        renderOption={(props, o) => (
          <li {...props} key={o.value}>
            <Box sx={{ flex: 1 }}>{o.label}</Box>
            {o.count !== undefined && <Typography variant="caption" color="text.secondary">{o.count}</Typography>}
          </li>
        )}
        onChange={(_, vals) => {
          const values = (vals as Array<Opt | string>).map((v) => (typeof v === 'string' ? v.trim() : v.value)).filter(Boolean);
          for (const v of vals as Array<Opt | string>) if (typeof v !== 'string') onLabel?.(v.value, v.label);
          onValues({ ...clause, values });
        }}
        renderInput={(p) => <TextField {...p} placeholder={clause.values.length ? '' : 'Choose…'} inputProps={{ ...p.inputProps, 'data-testid': 'filter-values' }} />}
      />
    );
  }

  if (isDate) {
    if (clause.op === 'missing') return <Typography variant="body2" color="text.secondary">nothing recorded</Typography>;
    if (clause.op === 'within' || clause.op === 'older_than') {
      return (
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField
            size="small"
            type="number"
            value={a}
            onChange={(e) => setA(e.target.value)}
            onBlur={() => a !== clause.values[0] && onValues({ ...clause, values: [a.trim()] })}
            onKeyDown={(e) => e.key === 'Enter' && onValues({ ...clause, values: [a.trim()] })}
            inputProps={{ min: 1, 'aria-label': 'Days', 'data-testid': 'filter-days' }}
            sx={{ width: 100 }}
          />
          <Typography variant="body2" color="text.secondary">{clause.op === 'within' ? 'days' : 'days ago'}</Typography>
        </Stack>
      );
    }
    const yearless = def.class === 'identifying' && (clause.op === 'on' || clause.op === 'between');
    const apply = () => {
      const v0 = parseDateInput(a, yearless);
      if (!v0) return onValues({ ...clause, values: [a] });
      if (clause.op === 'between') {
        const v1 = parseDateInput(b, yearless);
        return onValues({ ...clause, values: [v0, v1 ?? b] });
      }
      return onValues({ ...clause, values: [v0] });
    };
    return (
      <Stack direction="row" spacing={1} alignItems="center" component="form" onSubmit={(e) => { e.preventDefault(); apply(); }}>
        <TextField size="small" value={a} onChange={(e) => setA(e.target.value)} onBlur={apply} placeholder={yearless ? 'Sep 2' : 'Sep 2, 2026'} inputProps={{ 'aria-label': 'Date', 'data-testid': 'filter-date-0' }} sx={{ flex: 1 }} />
        {clause.op === 'between' && (
          <>
            <Typography variant="body2" color="text.secondary">and</Typography>
            <TextField size="small" value={b} onChange={(e) => setB(e.target.value)} onBlur={apply} placeholder={yearless ? 'Sep 30' : 'Sep 30, 2026'} inputProps={{ 'aria-label': 'End date', 'data-testid': 'filter-date-1' }} sx={{ flex: 1 }} />
          </>
        )}
      </Stack>
    );
  }

  const applyText = () => {
    const v = a.trim();
    if (clause.field === 'lot') {
      const s = sub.trim();
      onValues({ ...clause, values: [v], ...(clause.op === 'is' && s ? { sublot: s } : { sublot: undefined }) });
      return;
    }
    onValues({ ...clause, values: [v] });
  };
  return (
    <Stack direction="row" spacing={1} component="form" onSubmit={(e) => { e.preventDefault(); applyText(); }}>
      <TextField
        size="small"
        value={a}
        onChange={(e) => setA(e.target.value)}
        onBlur={() => a.trim() && a.trim() !== (clause.values[0] ?? '') && applyText()}
        placeholder={clause.field === 'text' ? 'words' : clause.field === 'lot' ? 'lot' : 'number'}
        inputProps={{ 'aria-label': def.label, 'data-testid': 'filter-text' }}
        sx={{ flex: 2, '& input': { fontFamily: def.valueKind === 'identifier' || def.valueKind === 'lot' ? 'ui-monospace, monospace' : undefined } }}
      />
      {clause.field === 'lot' && clause.op === 'is' && (
        <TextField size="small" value={sub} onChange={(e) => setSub(e.target.value)} onBlur={() => a.trim() && applyText()} placeholder="sublot" inputProps={{ 'aria-label': 'Sublot' }} sx={{ flex: 1 }} />
      )}
    </Stack>
  );
}
