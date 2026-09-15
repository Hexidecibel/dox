/**
 * Test results on a document page — every printed result the portal judged,
 * and every one it did NOT, in one table.
 *
 * SME rulings (AJ Conner, 2026-09-14) this panel exists to honour:
 *
 *   - An analyte printed with NO configured limit is not judged, and must say so
 *     ("No limit configured"), in a colour distinct from a checked result — the
 *     portal must never imply an assurance it did not give.
 *   - "Could not check" (verify it) is visually distinct from "Out of spec"
 *     (known out by your own definitions).
 *   - A unit conversion behind a comparison is shown on the value.
 *   - A required analyte for this supplier that the certificate did not report
 *     makes it incomplete — shown as its own row, never as a pass.
 *
 * Reads the register (`/api/spec-checks`, what was judged, with its frozen
 * limit) and its other half (`/api/spec-gaps`, what was not) — both written at
 * approval. Renders nothing for a document with neither, which is every
 * document that is not a certificate.
 */

import { useEffect, useState } from 'react';
import {
  Box,
  Chip,
  Paper,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  CheckCircleOutline as InSpecIcon,
  ErrorOutline as OutOfSpecIcon,
  HelpOutline as NotCheckedIcon,
  RemoveCircleOutline as NoLimitIcon,
  PlaylistRemove as MissingIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { ApiSpecCheck, ApiSpecGap } from '../lib/types';
import { NO_LIMIT_CONFIGURED_LABEL, watchEndedLabel } from '../../shared/specCheck';
import {
  COULD_NOT_CHECK_LABEL,
  ConversionChip,
  MISSING_REQUIRED_COLOR,
  conversionFromSnapshot,
  missingRequiredChipSx,
} from './SpecWarnings';

/** Every state a printed result can be in, and how each one looks. */
export type ResultState = 'in_spec' | 'out_of_spec' | 'not_checked' | 'unjudged' | 'missing_required';

export const RESULT_STATE_LABEL: Record<ResultState, string> = {
  in_spec: 'In spec',
  out_of_spec: 'Out of spec',
  not_checked: COULD_NOT_CHECK_LABEL,
  unjudged: NO_LIMIT_CONFIGURED_LABEL,
  missing_required: 'Required — not reported',
};

/** Ordered by what a reader must see first. */
const STATE_ORDER: ResultState[] = ['out_of_spec', 'missing_required', 'not_checked', 'unjudged', 'in_spec'];

export function ResultStateChip({ state }: { state: ResultState }) {
  const label = RESULT_STATE_LABEL[state];
  switch (state) {
    case 'out_of_spec':
      return <Chip size="small" color="error" icon={<OutOfSpecIcon />} label={label} />;
    case 'not_checked':
      return <Chip size="small" color="info" variant="outlined" icon={<NotCheckedIcon />} label={label} />;
    case 'missing_required':
      return (
        <Chip
          size="small"
          variant="outlined"
          icon={<MissingIcon sx={{ color: `${MISSING_REQUIRED_COLOR} !important` }} />}
          label={label}
          sx={missingRequiredChipSx}
        />
      );
    case 'in_spec':
      return <Chip size="small" color="success" variant="outlined" icon={<InSpecIcon />} label={label} />;
    default:
      // Grey and dashed — deliberately NOT the green of a checked result.
      return (
        <Chip
          size="small"
          variant="outlined"
          icon={<NoLimitIcon />}
          label={label}
          sx={{ borderStyle: 'dashed', color: 'text.secondary', borderColor: 'grey.400', bgcolor: 'grey.50' }}
        />
      );
  }
}

interface Row {
  key: string;
  state: ResultState;
  test: string;
  value: string;
  against: string;
  why: string | null;
  where: string | null;
  source?: 'printed' | 'limit';
  snapshot: string | null;
  unitRaw: string | null;
  reviewOverdueAt: string | null;
}

function snapshotText(snapshot: string | null): string {
  if (!snapshot) return '—';
  try {
    const s = JSON.parse(snapshot);
    if (s.printed) return `${s.printed} (COA's own)`;
    if (s.text) return s.text;
    return '—';
  } catch {
    return '—';
  }
}

function watchEndedAt(snapshot: string | null): string | null {
  if (!snapshot) return null;
  try {
    const s = JSON.parse(snapshot) as { review_by?: string; review_overdue?: boolean };
    return s.review_overdue && s.review_by ? s.review_by : null;
  } catch {
    return null;
  }
}

/** Register rows + gap rows → one list, most urgent first. Exported for tests. */
export function buildResultRows(checks: ApiSpecCheck[], gaps: ApiSpecGap[]): Row[] {
  const rows: Row[] = [
    ...checks.map((c) => ({
      key: c.id,
      state: c.verdict as ResultState,
      test: c.spec_test_name || c.test_name_raw,
      value: `${c.value_raw ?? '—'}${c.unit_raw ? ` ${c.unit_raw}` : ''}`,
      against: snapshotText(c.limit_snapshot),
      why: c.verdict === 'in_spec' ? null : c.reason,
      where: c.result_location ?? null,
      source: c.source,
      snapshot: c.limit_snapshot,
      unitRaw: c.unit_raw,
      reviewOverdueAt: watchEndedAt(c.limit_snapshot),
    })),
    ...gaps.map((g) => ({
      key: g.id,
      state: g.kind as ResultState,
      test: g.kind === 'missing_required' ? g.spec_test_name || g.test_name_raw : g.test_name_raw,
      value: g.kind === 'missing_required' ? '—' : `${g.value_raw ?? '—'}${g.unit_raw ? ` ${g.unit_raw}` : ''}`,
      against: g.kind === 'missing_required' ? 'Required for this supplier' : 'No limit on file',
      why: g.reason,
      where: g.result_location,
      snapshot: null,
      unitRaw: g.unit_raw,
      reviewOverdueAt: g.kind === 'missing_required' ? watchEndedAt(g.snapshot) : null,
    })),
  ];
  return rows.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
}

export function DocumentSpecResults({ documentId }: { documentId: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.specChecks.list({ document_id: documentId, verdict: 'all', limit: 200 }).catch(() => null),
      api.specGaps.list({ document_id: documentId, limit: 500 }).catch(() => null),
    ]).then(([checks, gaps]) => {
      if (cancelled) return;
      setRows(buildResultRows(checks?.specChecks ?? [], gaps?.specGaps ?? []));
    });
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  if (!rows || rows.length === 0) return null;

  const count = (s: ResultState) => rows.filter((r) => r.state === s).length;

  return (
    <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 }, mb: 3 }} data-testid="document-spec-results">
      <Typography variant="h6" fontWeight={600}>
        Test results
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', my: 1 }}>
        {STATE_ORDER.filter((s) => count(s) > 0).map((s) => (
          <Box key={s} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ResultStateChip state={s} />
            <Typography variant="caption" color="text.secondary">
              × {count(s)}
            </Typography>
          </Box>
        ))}
      </Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
        Judged at approval against the limits on file then, and the certificate&apos;s own printed
        specification. &quot;{NO_LIMIT_CONFIGURED_LABEL}&quot; means nothing was checked for that
        result — it is not a pass.
      </Typography>
      <TableContainer>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>Test</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Result</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>State</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Judged against</TableCell>
              <TableCell sx={{ fontWeight: 600 }}>Why</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.key}>
                <TableCell>
                  {r.test}
                  {r.where && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      {r.where}
                    </Typography>
                  )}
                </TableCell>
                <TableCell sx={{ fontWeight: r.state === 'out_of_spec' ? 700 : 400 }}>
                  {r.value}
                  <ConversionChip conversion={conversionFromSnapshot(r.snapshot, r.unitRaw)} />
                </TableCell>
                <TableCell>
                  <ResultStateChip state={r.state} />
                  {r.reviewOverdueAt && (
                    <Tooltip arrow title="When this was judged, the supplier watch behind it was past its review-by date. It still applied.">
                      <Typography variant="caption" color="warning.main" display="block">
                        {watchEndedLabel(r.reviewOverdueAt)}
                      </Typography>
                    </Tooltip>
                  )}
                </TableCell>
                <TableCell>{r.against}</TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">
                    {r.why || '—'}
                  </Typography>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Paper>
  );
}

export default DocumentSpecResults;
