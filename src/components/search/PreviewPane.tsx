import { useEffect, useRef, useState } from 'react';
import { Alert, Box, Button, CircularProgress, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import { Link as RouterLink } from 'react-router-dom';
import { DocumentPreview } from '../DocumentPreview';
import { api } from '../../lib/api';
import type { DocumentVersion, SearchDocLot, UniversalSearchDocument } from '../../../shared/types';
import { formatIsoHuman } from '../../../shared/searchDates';
import { answeringLotKeys, lotLabel } from './LotStrip';

/**
 * The certificate beside the results (search redesign Phase 2), with the row
 * that answers the search NAMED: "Row 2 of 3 answers your search. Lot
 * 10426203 · sublot 03, produced Jul 22, 2026 (printed on the certificate).
 * The other rows are other lots on the same certificate and are not part of
 * the answer." The certificate's own lot table follows, the answering row
 * marked and the others dimmed, then the file itself (the existing
 * `DocumentPreview`: PDF, image, text, Word).
 *
 * The file is not re-rendered with a highlight drawn on it — dox does not know
 * where on the page a row is printed — so the row is named in words above it.
 */
const SOURCE_WORDS: Record<string, string> = {
  extracted: 'printed on the certificate',
  reviewer: 'entered by a reviewer',
  extracted_code_date_legacy: 'from an older code date — confirm it',
  lot_decode: "decoded from the lot code using the supplier's declared format — confirm it",
};

const STATUS: Record<string, { label: string; color: 'success' | 'warning' | 'default' }> = {
  covering: { label: 'Covers your search', color: 'success' },
  likely_covering: { label: 'Likely — confirm', color: 'warning' },
  candidate_not_matching: { label: 'Nearby — does not cover', color: 'default' },
};

const versionCache = new Map<string, DocumentVersion | null>();

export interface PreviewPaneProps {
  doc: UniversalSearchDocument | null;
  onClose?: () => void;
}

export function PreviewPane({ doc, onClose }: PreviewPaneProps) {
  const [version, setVersion] = useState<DocumentVersion | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    setError(null);
    if (!doc) {
      setVersion(undefined);
      return;
    }
    if (versionCache.has(doc.id)) {
      setVersion(versionCache.get(doc.id) ?? null);
      return;
    }
    setVersion(undefined);
    const mine = ++reqId.current;
    api.documents
      .getWithVersion(doc.id)
      .then((r) => {
        versionCache.set(doc.id, r.currentVersion);
        if (reqId.current === mine) setVersion(r.currentVersion);
      })
      .catch((e: unknown) => {
        if (reqId.current === mine) setError(e instanceof Error ? e.message : 'Could not load the file');
      });
  }, [doc?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!doc) {
    return (
      <Box
        data-testid="preview-empty"
        sx={{ p: 3, borderRadius: 3, border: '1px dashed', borderColor: 'divider', color: 'text.secondary', textAlign: 'center', fontSize: '0.875rem' }}
      >
        Select a result to see the certificate, with the row that answers your search marked.
      </Box>
    );
  }

  const lots: SearchDocLot[] = doc.doc_lots ?? [];
  const hits = answeringLotKeys(doc);
  const hitLots = lots.filter((l) => hits.has(`${l.lot_number}|${l.sub_lot_code ?? ''}`));
  const matched = doc.matched_lot;
  const status = doc.match_status ? STATUS[doc.match_status] : undefined;

  return (
    <Box data-testid="preview-pane" sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
      <Stack direction="row" alignItems="flex-start" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3 }} noWrap title={doc.title ?? ''}>
            {doc.title ?? 'Document'}
          </Typography>
          <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>
            {[doc.supplier_name, doc.document_type_name].filter(Boolean).join(' · ')}
          </Typography>
        </Box>
        <Button
          size="small"
          variant="outlined"
          component={RouterLink}
          to={`/documents/${doc.id}`}
          endIcon={<OpenInNewRoundedIcon sx={{ fontSize: 16 }} />}
          sx={{ textTransform: 'none', borderRadius: 2, flexShrink: 0 }}
          data-testid="preview-open"
        >
          Open
        </Button>
        {onClose && (
          <Tooltip title="Close preview (Esc)">
            <IconButton size="small" onClick={onClose} aria-label="Close preview">
              <CloseRoundedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      {status && (
        <Box
          data-testid="preview-answer-note"
          sx={(t) => {
            const ink = status.color === 'success' ? t.palette.success.main : status.color === 'warning' ? t.palette.warning.main : t.palette.text.secondary;
            return {
              display: 'flex',
              gap: 1.25,
              p: 1.5,
              borderRadius: 2,
              bgcolor: alpha(ink, 0.06),
              border: '1px solid',
              borderColor: alpha(ink, 0.25),
              fontSize: '0.84rem',
              lineHeight: 1.5,
            };
          }}
        >
          <Box sx={{ width: 10, height: 10, mt: 0.6, flexShrink: 0, borderRadius: 0.5, bgcolor: '#fff0b0', boxShadow: 'inset 0 0 0 1px #e3bd3c' }} />
          <Box>
            <Typography component="div" sx={{ fontWeight: 700, fontSize: 'inherit' }}>{status.label}</Typography>
            {matched && doc.match_status !== 'candidate_not_matching' ? (
              <>
                {lots.length > 1 && hitLots.length > 0
                  ? `${hitLots.length === 1 ? `Row ${lots.indexOf(hitLots[0]) + 1} of ${lots.length} answers` : `${hitLots.length} of ${lots.length} rows answer`} your search. `
                  : ''}
                Lot <b>{lotLabel(matched)}</b>
                {matched.production_date ? `, produced ${formatIsoHuman(matched.production_date)}` : ''}
                {matched.production_date_source ? ` (${SOURCE_WORDS[matched.production_date_source] ?? matched.production_date_source})` : ''}.
                {lots.length > 1 && ' The other rows are other lots on the same certificate and are not part of the answer.'}
              </>
            ) : doc.match_status === 'candidate_not_matching' ? (
              doc.match_reason ?? 'It fails at least one part of your search.'
            ) : null}
          </Box>
        </Box>
      )}

      {lots.length > 1 && (
        <Box sx={{ borderRadius: 2, border: '1px solid', borderColor: 'divider', overflow: 'hidden' }} data-testid="preview-lot-table">
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', '& td, & th': { px: 1.25, py: 0.6, textAlign: 'left', borderBottom: '1px solid', borderColor: 'divider' } }}>
            <thead>
              <Box component="tr" sx={{ bgcolor: 'action.hover', '& th': { fontWeight: 600, color: 'text.secondary', fontSize: '0.72rem' } }}>
                <th>Lot</th>
                <th>Sublot</th>
                <th>Produced</th>
              </Box>
            </thead>
            <tbody>
              {lots.map((l) => {
                const on = hits.has(`${l.lot_number}|${l.sub_lot_code ?? ''}`);
                return (
                  <Box
                    component="tr"
                    key={`${l.lot_number}|${l.sub_lot_code}`}
                    data-answering={on ? '1' : undefined}
                    sx={on ? { bgcolor: '#fff0b0', fontWeight: 600 } : { opacity: 0.55 }}
                  >
                    <Box component="td" sx={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}>{l.lot_number}</Box>
                    <Box component="td" sx={{ fontFamily: '"JetBrains Mono", ui-monospace, monospace' }}>{l.sub_lot_code || '—'}</Box>
                    <td>{l.production_date ? formatIsoHuman(l.production_date) : '—'}</td>
                  </Box>
                );
              })}
            </tbody>
          </Box>
        </Box>
      )}

      {error && <Alert severity="warning">{error}</Alert>}
      {version === undefined && !error && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
          <CircularProgress size={22} />
        </Box>
      )}
      {version === null && <Alert severity="info">This document has no file to preview.</Alert>}
      {version && (
        <Box sx={{ '& > .MuiPaper-root': { mb: 0, borderRadius: 2 } }}>
          <DocumentPreview documentId={doc.id} versionNumber={version.version_number} fileName={version.file_name} mimeType={version.mime_type} />
        </Box>
      )}
    </Box>
  );
}
