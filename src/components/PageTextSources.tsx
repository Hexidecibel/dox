import { Box, Chip, Typography } from '@mui/material';
import { summarizePageSources, type PageTextProvenance } from '../../shared/pdfPageOcr';

/**
 * Which pages the model read from the file's own text layer, and which it read
 * by OCR (migration 0116).
 *
 * WHY A REVIEWER IS TOLD. Extraction now decides OCR one page at a time, so one
 * document's text can come from two different reads. That distinction is not
 * cosmetic: a value off a text layer is the document's own characters, while a
 * value off a rasterised image is a guess at glyph shapes — `0` and `O`, `1` and
 * `l`, a certificate number, an expiry date. The reviewer who has to confirm
 * those values is the person who needs to know which kind they are looking at.
 *
 * ABSENT MEANS NOTHING UNUSUAL HAPPENED. The worker stores this column only
 * when a page was actually read by OCR, so an ordinary document renders exactly
 * what it rendered before — no row, no chip, no noise. Both components below
 * return null on a NULL / unparseable value for the same reason: a broken
 * sidecar must never cost a reviewer the card.
 */
export function parsePageSources(raw: string | null | undefined): PageTextProvenance[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as PageTextProvenance[];
  } catch {
    return null;
  }
}

/** One line, shown on the collapsed "Extracted text" header. */
export function PageSourceNote({ raw }: { raw: string | null | undefined }) {
  const rows = parsePageSources(raw);
  const summary = rows ? summarizePageSources(rows) : null;
  if (!summary) return null;
  return (
    <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
      {summary} — values on those pages were read from an image, not from the file's own text
    </Typography>
  );
}

/**
 * The full per-page breakdown, inside the expanded panel. Every page is listed,
 * not only the OCR'd ones: "page 7 came from the text layer" is as much a part
 * of the record as "page 6 did not".
 */
export function PageSourceTable({ raw }: { raw: string | null | undefined }) {
  const rows = parsePageSources(raw);
  if (!rows) return null;
  const label = (r: PageTextProvenance) =>
    r.source === 'ocr' ? 'OCR' : r.source === 'text-layer+ocr' ? 'text + OCR' : 'text layer';
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
        Where each page's text came from
      </Typography>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
        {rows.map((r) => (
          <Chip
            key={r.page}
            size="small"
            variant={r.source === 'text-layer' ? 'outlined' : 'filled'}
            color={r.source === 'text-layer' ? 'default' : 'warning'}
            label={`p${r.page} · ${label(r)}`}
            title={
              r.source === 'text-layer'
                ? `${r.text_layer_chars} characters from the text layer` +
                  (r.reason === 'ocr_budget_exhausted' ? ' — this page looks like an unread image but the OCR budget was reached' : '')
                : `${r.text_layer_chars} characters in the text layer, ${r.ocr_chars ?? 0} read by OCR; ` +
                  `largest image covers ${Math.round((r.image_coverage || 0) * 100)}% of the page`
            }
          />
        ))}
      </Box>
    </Box>
  );
}
