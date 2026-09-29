import { useEffect, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  ButtonBase,
  Chip,
  Divider,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { Clause } from '../../../shared/searchQuery';
import { clauseWords } from '../../../shared/searchQuery';
import {
  SEARCH_FIELDS,
  STATUS_LABELS,
  UPLOADED_BUCKETS,
  validateClause,
  type ClauseOp,
  type FieldKey,
} from '../../../shared/searchFields';
import type { SearchConstraint } from '../../../shared/types';
import { chipParts, dateInputText, parseDateInput, sourceWords } from '../../lib/searchChips';
import { AI_VIOLET } from './ClauseChip';

/**
 * The clause editor (search redesign Phase 2) — opened from a chip, and the
 * same editor the Advanced builder will host (Phase 3). It edits ONE clause
 * and hands back the next one; the workspace re-runs the search.
 *
 * What it lets a person change is exactly what the reading could have got
 * wrong:
 *   - a date's ROLE (production ↔ code date ↔ best-by ↔ any) and its operator;
 *   - a lot as an exact lot or a prefix, and its sublot;
 *   - what a number IS (PO / invoice / order / any identifier);
 *   - which of an ambiguous phrase's products was meant — or keep them all;
 *   - include ↔ exclude, for scope filters only (an identifying clause cannot
 *     be excluded: "not lot X" is not a question a document covers).
 * And for every clause read out of words: "treat it as text", which is the
 * rejection — the words go back as a text chip and are never re-read.
 *
 * A change that would not validate is refused on the spot with the reason,
 * never sent.
 */
export interface ClauseEditorProps {
  clause: Clause;
  labels?: Record<string, string>;
  constraint?: SearchConstraint | null;
  /** Per-product counts for an ambiguous product ("2 covering"). */
  productCounts?: Record<string, number>;
  /** What the counts count: 'covering' or 'documents'. */
  countNoun?: string;
  onChange: (next: Clause) => void;
  onAsText: () => void;
  onRemove: () => void;
  onClose: () => void;
}

const DATE_FIELDS: Array<{ field: FieldKey; role?: Clause['role']; label: string }> = [
  { field: 'production_date', label: 'Production' },
  { field: 'code_date', label: 'Code date' },
  { field: 'best_by_date', label: 'Best-by' },
  { field: 'date', role: 'any', label: 'Any date' },
];

const NUMBER_FIELDS: Array<{ field: FieldKey; label: string }> = [
  { field: 'po', label: 'PO' },
  { field: 'invoice', label: 'Invoice' },
  { field: 'order', label: 'Order' },
  { field: 'identifier', label: 'Any' },
];

const DATE_OPS: Array<{ op: ClauseOp; label: string }> = [
  { op: 'on', label: 'On' },
  { op: 'before', label: 'Before' },
  { op: 'after', label: 'After' },
  { op: 'between', label: 'Between' },
];

function isDateField(f: FieldKey): boolean {
  return f === 'production_date' || f === 'code_date' || f === 'best_by_date' || f === 'date';
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ pt: 1.25 }}>
      <Typography variant="overline" sx={{ display: 'block', color: 'text.secondary', lineHeight: 1.6, fontSize: '0.65rem', letterSpacing: '0.08em' }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

const segSx = {
  '& .MuiToggleButton-root': { textTransform: 'none', py: 0.35, px: 1.1, fontSize: '0.8rem', lineHeight: 1.4 },
} as const;

export function ClauseEditor({
  clause,
  labels = {},
  constraint,
  productCounts,
  countNoun = 'covering',
  onChange,
  onAsText,
  onRemove,
  onClose,
}: ClauseEditorProps) {
  const def = SEARCH_FIELDS[clause.field];
  const [error, setError] = useState<string | null>(null);
  const [text0, setText0] = useState('');
  const [text1, setText1] = useState('');
  const [sub, setSub] = useState(clause.sublot ?? '');

  useEffect(() => {
    setError(null);
    if (isDateField(clause.field) || clause.field === 'uploaded') {
      setText0(dateInputText(clause.values[0]));
      setText1(dateInputText(clause.values[1]));
    } else {
      setText0(clause.values.join(' '));
    }
    setSub(clause.sublot ?? '');
  }, [clause]);

  const commit = (next: Clause) => {
    const err = validateClause(next);
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    onChange(next);
  };

  const parts = chipParts(clause, labels, constraint);
  const readFromWords = clause.field !== 'text' && (clause.source === 'detected' || clause.source === 'ai' || !!clause.raw);
  const words = clauseWords(clause, labels);

  const applyDates = (op: ClauseOp, a: string, b: string) => {
    // A span may be year-less at both ends ("Apr 1 – Apr 30", any year) on an identifying date.
    const spanYearless = op === 'between' && def.class === 'identifying';
    const v0 = parseDateInput(a, op === 'on' || spanYearless);
    if (!v0) {
      setError(`"${a || '(empty)'}" is not a date. Try Sep 2 or 2026-09-02.`);
      return;
    }
    if (op === 'between') {
      const v1 = parseDateInput(b, spanYearless);
      if (!v1) {
        setError(`"${b || '(empty)'}" is not a date.`);
        return;
      }
      if (v0.startsWith('--') !== v1.startsWith('--')) {
        setError('Give both dates a year, or neither (any year).');
        return;
      }
      commit({ ...clause, op, values: [v0, v1] });
      return;
    }
    commit({ ...clause, op, values: [v0] });
  };

  return (
    <Box sx={{ width: { xs: 'calc(100vw - 32px)', sm: 360 }, maxWidth: 380, p: 2 }} data-testid="clause-editor" role="dialog" aria-label={`Edit ${def.label}`}>
      <Stack direction="row" alignItems="baseline" spacing={1}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>{def.label}</Typography>
        <Typography
          variant="caption"
          sx={{ color: clause.source === 'ai' ? AI_VIOLET : 'text.secondary', fontWeight: clause.source === 'ai' ? 600 : 400 }}
          data-testid="clause-editor-source"
        >
          {sourceWords(clause)}
        </Typography>
      </Stack>
      <Typography variant="body2" sx={{ mt: 0.25, fontWeight: 600 }}>
        {parts.value}
        {parts.note && <Box component="span" sx={{ color: 'text.secondary', fontWeight: 400 }}> · {parts.note}</Box>}
      </Typography>
      {clause.raw && clause.field !== 'text' && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
          From your words: “{clause.raw}”
        </Typography>
      )}
      {clause.note && (
        <Box
          data-testid="clause-editor-note"
          sx={{
            mt: 1,
            px: 1.25,
            py: 0.75,
            borderRadius: 1.5,
            fontSize: '0.8rem',
            lineHeight: 1.45,
            bgcolor: clause.source === 'ai' ? alpha(AI_VIOLET, 0.07) : 'action.hover',
            color: clause.source === 'ai' ? AI_VIOLET : 'text.secondary',
            border: '1px solid',
            borderColor: clause.source === 'ai' ? alpha(AI_VIOLET, 0.25) : 'divider',
          }}
        >
          {clause.source === 'ai' ? '✦ ' : ''}{clause.note}
        </Box>
      )}

      {/* ---- dates --------------------------------------------------------- */}
      {isDateField(clause.field) && (
        <>
          <Section title="Read this date as">
            <ToggleButtonGroup
              exclusive
              size="small"
              sx={segSx}
              value={clause.field === 'date' ? 'date' : clause.field}
              onChange={(_, f: FieldKey | null) => {
                if (!f) return;
                const d = DATE_FIELDS.find((x) => x.field === f)!;
                const { role: _r, ...rest } = clause;
                commit({ ...rest, field: f, ...(d.role ? { role: d.role } : {}) });
              }}
              aria-label="Date role"
            >
              {DATE_FIELDS.map((d) => (
                <ToggleButton key={d.field} value={d.field} data-testid={`date-role-${d.field}`}>{d.label}</ToggleButton>
              ))}
            </ToggleButtonGroup>
          </Section>
          <Section title="Match">
            <ToggleButtonGroup
              exclusive
              size="small"
              sx={segSx}
              value={clause.op}
              onChange={(_, op: ClauseOp | null) => {
                if (!op || op === clause.op) return;
                if (op === 'between') {
                  const v0 = parseDateInput(text0, false);
                  if (!v0) {
                    setError('Give the first date a year to search a range.');
                    return;
                  }
                  commit({ ...clause, op, values: [v0, v0] });
                  return;
                }
                const v0 = parseDateInput(text0, op === 'on');
                if (!v0) {
                  setError('Give the date a year to search before or after it.');
                  return;
                }
                commit({ ...clause, op, values: [v0] });
              }}
              aria-label="Date operator"
            >
              {DATE_OPS.map((o) => <ToggleButton key={o.op} value={o.op} data-testid={`date-op-${o.op}`}>{o.label}</ToggleButton>)}
            </ToggleButtonGroup>
            <Stack
              component="form"
              direction="row"
              spacing={1}
              alignItems="center"
              sx={{ mt: 1 }}
              onSubmit={(e) => {
                e.preventDefault();
                applyDates(clause.op, text0, text1);
              }}
            >
              <TextField
                size="small"
                value={text0}
                onChange={(e) => setText0(e.target.value)}
                onBlur={() => text0 !== dateInputText(clause.values[0]) && applyDates(clause.op, text0, text1)}
                placeholder="Sep 2"
                inputProps={{ 'aria-label': 'Date', 'data-testid': 'date-input-0' }}
                sx={{ flex: 1 }}
              />
              {clause.op === 'between' && (
                <>
                  <Typography variant="body2" color="text.secondary">and</Typography>
                  <TextField
                    size="small"
                    value={text1}
                    onChange={(e) => setText1(e.target.value)}
                    onBlur={() => text1 !== dateInputText(clause.values[1]) && applyDates(clause.op, text0, text1)}
                    placeholder="Sep 10"
                    inputProps={{ 'aria-label': 'End date', 'data-testid': 'date-input-1' }}
                    sx={{ flex: 1 }}
                  />
                </>
              )}
            </Stack>
            {clause.op === 'on' && /^--/.test(clause.values[0] ?? '') && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                No year was given, so that day in any year matches. Type a year to pin it.
              </Typography>
            )}
          </Section>
        </>
      )}

      {/* ---- lots ---------------------------------------------------------- */}
      {clause.field === 'lot' && (
        <Section title="Lot matching">
          <ToggleButtonGroup
            exclusive
            size="small"
            sx={segSx}
            value={clause.op}
            onChange={(_, op: ClauseOp | null) => {
              if (!op || op === clause.op) return;
              const { sublot: _s, note: _n, ...rest } = clause;
              commit(op === 'starts' ? { ...rest, op } : { ...rest, op, note: null });
            }}
            aria-label="Lot matching"
          >
            <ToggleButton value="is" data-testid="lot-op-is">Exact lot</ToggleButton>
            <ToggleButton value="starts" data-testid="lot-op-starts">Starts with</ToggleButton>
          </ToggleButtonGroup>
          <Stack
            component="form"
            direction="row"
            spacing={1}
            sx={{ mt: 1 }}
            onSubmit={(e) => {
              e.preventDefault();
              commit({ ...clause, values: [text0.trim()], ...(clause.op === 'is' && sub.trim() ? { sublot: sub.trim() } : { sublot: undefined }) });
            }}
          >
            <TextField size="small" label="Lot" value={text0} onChange={(e) => setText0(e.target.value)} sx={{ flex: 2 }} inputProps={{ 'data-testid': 'lot-input' }} />
            {clause.op === 'is' && (
              <TextField size="small" label="Sublot" value={sub} onChange={(e) => setSub(e.target.value)} sx={{ flex: 1 }} inputProps={{ 'data-testid': 'sublot-input' }} />
            )}
            <Button type="submit" size="small" variant="outlined" sx={{ textTransform: 'none' }}>Apply</Button>
          </Stack>
        </Section>
      )}

      {/* ---- numbers ------------------------------------------------------- */}
      {(clause.field === 'po' || clause.field === 'invoice' || clause.field === 'order' || clause.field === 'identifier') && (
        <Section title="This number is">
          <ToggleButtonGroup
            exclusive
            size="small"
            sx={segSx}
            value={clause.field}
            onChange={(_, f: FieldKey | null) => {
              if (!f || f === clause.field) return;
              commit({ ...clause, field: f, op: 'is', note: null });
            }}
            aria-label="Number kind"
          >
            {NUMBER_FIELDS.map((n) => <ToggleButton key={n.field} value={n.field} data-testid={`number-kind-${n.field}`}>{n.label}</ToggleButton>)}
          </ToggleButtonGroup>
          {clause.field === 'identifier' && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Any kind of number printed on a document or carried by an order answers — nothing is picked.
            </Typography>
          )}
        </Section>
      )}

      {/* ---- an ambiguous product ------------------------------------------ */}
      {clause.field === 'product' && clause.ambiguous && clause.values.length > 1 && (
        <Section title="Which product did you mean?">
          <Stack spacing={0.5}>
            {clause.values.map((pid) => (
              <ButtonBase
                key={pid}
                onClick={() => commit({ ...clause, values: [pid], ambiguous: false, note: `You picked ${labels[pid] ?? 'this product'}.` })}
                data-testid={`pick-product-${pid}`}
                sx={{
                  justifyContent: 'space-between',
                  textAlign: 'left',
                  px: 1.25,
                  py: 0.75,
                  borderRadius: 1.5,
                  border: '1px solid',
                  borderColor: 'divider',
                  gap: 1,
                  '&:hover': { borderColor: 'info.main', bgcolor: 'action.hover' },
                }}
              >
                <Typography variant="body2" sx={{ fontWeight: 600 }}>{labels[pid] ?? pid}</Typography>
                {productCounts && (
                  <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                    {productCounts[pid] ?? 0} {countNoun}
                  </Typography>
                )}
              </ButtonBase>
            ))}
            <Button size="small" onClick={onClose} sx={{ textTransform: 'none', alignSelf: 'flex-start' }}>
              Keep all — shown per product
            </Button>
          </Stack>
        </Section>
      )}

      {/* ---- scope values -------------------------------------------------- */}
      {def.class === 'scope' && clause.field !== 'uploaded' && !(clause.field === 'product' && clause.ambiguous) && (
        <Section title={clause.values.length > 1 ? 'Any of' : 'Value'}>
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {clause.values.map((v) => (
              <Chip
                key={v}
                size="small"
                label={labels[v] ?? (clause.field === 'status' ? STATUS_LABELS[v] ?? v : v)}
                onDelete={clause.values.length > 1 ? () => commit({ ...clause, values: clause.values.filter((x) => x !== v) }) : undefined}
              />
            ))}
          </Stack>
        </Section>
      )}

      {clause.field === 'uploaded' && (
        <Section title="Uploaded">
          <Stack direction="row" spacing={0.5} useFlexGap sx={{ flexWrap: 'wrap' }}>
            {UPLOADED_BUCKETS.map((b) => (
              <Chip
                key={b.value}
                size="small"
                label={b.label}
                variant={`${clause.op}:${clause.values[0]}` === b.value ? 'filled' : 'outlined'}
                color={`${clause.op}:${clause.values[0]}` === b.value ? 'primary' : 'default'}
                onClick={() => commit({ ...clause, op: b.op, values: [String(b.days)] })}
              />
            ))}
          </Stack>
        </Section>
      )}

      {clause.field === 'text' && (
        <Section title="Words">
          <Stack
            component="form"
            direction="row"
            spacing={1}
            onSubmit={(e) => {
              e.preventDefault();
              if (text0.trim()) commit({ ...clause, values: [text0.trim()] });
            }}
          >
            <TextField size="small" value={text0} onChange={(e) => setText0(e.target.value)} sx={{ flex: 1 }} inputProps={{ 'aria-label': 'Words', 'data-testid': 'text-input' }} />
            <Button type="submit" size="small" variant="outlined" sx={{ textTransform: 'none' }}>Apply</Button>
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            Matched as words in the title, file name and text. Not read for lots, dates or numbers.
          </Typography>
        </Section>
      )}

      {error && (
        <Alert severity="warning" sx={{ mt: 1.25, py: 0 }} data-testid="clause-editor-error">
          {error}
        </Alert>
      )}

      <Divider sx={{ mt: 1.75, mb: 1.25 }} />
      <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap' }}>
        {def.excludable && (
          <Button size="small" variant="outlined" onClick={() => commit({ ...clause, exclude: !clause.exclude })} sx={{ textTransform: 'none' }} data-testid="clause-exclude">
            {clause.exclude ? 'Include instead' : 'Exclude these'}
          </Button>
        )}
        {readFromWords && (
          <Button size="small" variant="outlined" onClick={onAsText} sx={{ textTransform: 'none', maxWidth: '100%' }} data-testid="clause-as-text">
            <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              Treat “{words.length > 22 ? `${words.slice(0, 22)}…` : words}” as text
            </Box>
          </Button>
        )}
        <Button size="small" color="inherit" onClick={onRemove} sx={{ textTransform: 'none', color: 'text.secondary' }} data-testid="clause-remove">
          Remove
        </Button>
      </Stack>
    </Box>
  );
}
