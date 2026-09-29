import { Box, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import type { SearchDocLot, SearchMatchedLot, UniversalSearchDocument } from '../../../shared/types';

/**
 * Every lot on a certificate, with the rows that answer the search MARKED and
 * the others dimmed (search redesign Phase 2).
 *
 * One certificate often certifies several lots. The answer holds for the
 * row(s) that matched, never for the certificate as a whole — so the others
 * are shown for context, visibly not part of the answer. Renders nothing for a
 * certificate with one lot row (the matched-lot line already says it).
 */
export function answeringLotKeys(doc: UniversalSearchDocument): Set<string> {
  if (doc.match_status !== 'covering' && doc.match_status !== 'likely_covering') return new Set();
  const rows: SearchMatchedLot[] = doc.matched_lots?.length ? doc.matched_lots : doc.matched_lot ? [doc.matched_lot] : [];
  return new Set(rows.map((l) => `${l.lot_number}|${l.sub_lot_code ?? ''}`));
}

export function lotLabel(l: Pick<SearchDocLot, 'lot_number' | 'sub_lot_code'>): string {
  return l.sub_lot_code ? `${l.lot_number}-${l.sub_lot_code}` : l.lot_number;
}

export function LotStrip({ doc }: { doc: UniversalSearchDocument }) {
  const lots = doc.doc_lots ?? [];
  if (lots.length < 2) return null;
  const hit = answeringLotKeys(doc);
  return (
    <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap sx={{ mt: 0.75, flexWrap: 'wrap' }} data-testid="lot-strip">
      <Typography variant="caption" color="text.secondary" sx={{ mr: 0.25 }}>
        {lots.length} lots on this certificate:
      </Typography>
      {lots.map((l) => {
        const on = hit.has(`${l.lot_number}|${l.sub_lot_code ?? ''}`);
        return (
          <Box
            key={`${l.lot_number}|${l.sub_lot_code}`}
            component={on ? 'mark' : 'span'}
            data-answering={on ? '1' : undefined}
            title={on ? 'This row answers your search' : 'Another lot on the same certificate — not part of the answer'}
            sx={(t) => ({
              fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.72rem',
              px: 0.6,
              py: 0.1,
              borderRadius: 0.75,
              color: 'text.primary',
              ...(on
                ? { bgcolor: '#fff0b0', boxShadow: `inset 0 0 0 1px ${alpha('#e3bd3c', 0.9)}`, fontWeight: 600 }
                : { bgcolor: 'transparent', opacity: 0.5, border: `1px solid ${t.palette.divider}` }),
            })}
          >
            {lotLabel(l)}
          </Box>
        );
      })}
    </Stack>
  );
}
