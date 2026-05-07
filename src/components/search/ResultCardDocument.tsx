import {
  Box,
  Card,
  CardContent,
  Chip,
  Stack,
  Typography,
} from '@mui/material';
import DocIcon from '@mui/icons-material/Description';
import { useNavigate } from 'react-router-dom';
import { Snippet } from './Snippet';
import { formatDate } from '../../utils/format';
import type { UniversalSearchDocument } from '../../../shared/types';

/**
 * Compact document row for the Documents-tab result list.
 *
 * Visually denser than the legacy `<DocumentCard>` because the search
 * page renders *many* of these. Pulls supplier/doc-type chips off the
 * projected fields the universal endpoint hands back; falls back to
 * `(doc as any).supplier_name` style props from the LIKE-era list
 * endpoint so the panel can also drive the legacy `?search=` route
 * without a translation layer.
 */
export interface ResultCardDocumentProps {
  doc: UniversalSearchDocument;
  /** Optional click handler — defaults to navigating to /documents/:id. */
  onOpen?: (doc: UniversalSearchDocument) => void;
}

export function ResultCardDocument({ doc, onOpen }: ResultCardDocumentProps) {
  const navigate = useNavigate();
  const open = () =>
    onOpen ? onOpen(doc) : navigate(`/documents/${doc.id}`);

  const supplier = doc.supplier_name ?? null;
  const docType = doc.document_type_name ?? null;
  const created = typeof doc.created_at === 'string' ? doc.created_at : null;

  return (
    <Card
      variant="outlined"
      sx={{
        mb: 1,
        cursor: 'pointer',
        transition: 'border-color 0.15s, box-shadow 0.15s',
        '&:hover': { borderColor: 'primary.light' },
      }}
      onClick={open}
    >
      <CardContent sx={{ py: 1.5, '&:last-child': { pb: 1.5 } }}>
        <Stack direction="row" spacing={1} alignItems="flex-start">
          <DocIcon sx={{ color: 'primary.main', mt: 0.25, fontSize: '1.1rem' }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography
              variant="subtitle2"
              sx={{ fontWeight: 600, lineHeight: 1.3 }}
              noWrap
            >
              <Snippet text={doc.title ?? doc.snippet ?? '(untitled)'} />
            </Typography>
            {(doc.snippet_extracted || doc.description) && (
              <Typography
                variant="body2"
                color="text.secondary"
                sx={{
                  mt: 0.25,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {doc.snippet_extracted ? (
                  <Snippet text={doc.snippet_extracted} />
                ) : (
                  doc.description
                )}
              </Typography>
            )}
            <Stack direction="row" spacing={0.5} sx={{ mt: 0.75, flexWrap: 'wrap' }} useFlexGap>
              {supplier && (
                <Chip
                  size="small"
                  label={
                    doc.snippet_supplier ? (
                      <Snippet text={doc.snippet_supplier} />
                    ) : (
                      supplier
                    )
                  }
                  variant="outlined"
                  color="secondary"
                />
              )}
              {docType && (
                <Chip size="small" label={docType} variant="outlined" color="info" />
              )}
              {created && (
                <Typography variant="caption" color="text.secondary" sx={{ alignSelf: 'center' }}>
                  {formatDate(created)}
                </Typography>
              )}
            </Stack>
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}
