/**
 * EntityChip — renders a supplier / product / document / record / contact
 * reference as a compact chip with a type-distinct icon. Hover reveals a
 * Popper preview with the entity's name (Phase 1 surface; richer
 * previews land with each entity type's lookup endpoint).
 *
 * Click does NOT navigate (cells are read in the grid). The drawer's
 * "Open full page" button handles navigation in a future iteration.
 */

import { useRef, useState } from 'react';
import { Box, Popper, Paper, Typography, Fade } from '@mui/material';
import {
  Inventory2Outlined as ProductIcon,
  StorefrontOutlined as SupplierIcon,
  DescriptionOutlined as DocumentIcon,
  TableRowsOutlined as RecordIcon,
  PersonOutline as ContactIcon,
  BusinessOutlined as CustomerIcon,
} from '@mui/icons-material';
import type { RecordColumnType } from '../../../shared/types';

interface EntityChipProps {
  type: RecordColumnType;
  label: string;
  /** Optional secondary line in the hover preview. */
  meta?: string;
}

function iconForRefType(type: RecordColumnType): typeof SupplierIcon {
  switch (type) {
    case 'product_ref':
      return ProductIcon;
    case 'document_ref':
      return DocumentIcon;
    case 'record_ref':
      return RecordIcon;
    case 'contact':
      return ContactIcon;
    case 'customer_ref':
      return CustomerIcon;
    case 'supplier_ref':
    default:
      return SupplierIcon;
  }
}

/** Stable accent colors per ref type — distinguishes shape at a glance. */
function accentForRefType(type: RecordColumnType): { fg: string; bg: string; border: string } {
  switch (type) {
    case 'product_ref':
      return { fg: '#874100', bg: 'rgba(237, 108, 2, 0.10)', border: 'rgba(237, 108, 2, 0.28)' };
    case 'document_ref':
      return { fg: '#1A365D', bg: 'rgba(26, 54, 93, 0.10)', border: 'rgba(26, 54, 93, 0.28)' };
    case 'record_ref':
      return { fg: '#4A148C', bg: 'rgba(123, 31, 162, 0.10)', border: 'rgba(123, 31, 162, 0.28)' };
    case 'contact':
      return { fg: '#01579B', bg: 'rgba(2, 136, 209, 0.10)', border: 'rgba(2, 136, 209, 0.28)' };
    case 'customer_ref':
      // Teal — distinct from supplier (green) and document (navy).
      return { fg: '#00695C', bg: 'rgba(0, 121, 107, 0.10)', border: 'rgba(0, 121, 107, 0.28)' };
    case 'supplier_ref':
    default:
      return { fg: '#1B5E20', bg: 'rgba(46, 125, 50, 0.10)', border: 'rgba(46, 125, 50, 0.28)' };
  }
}

export function EntityChip({ type, label, meta }: EntityChipProps) {
  const Icon = iconForRefType(type);
  const accent = accentForRefType(type);
  const [hover, setHover] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);

  return (
    <>
      <Box
        component="span"
        ref={anchorRef}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.5,
          maxWidth: '100%',
          px: 1,
          py: 0.25,
          borderRadius: 999,
          bgcolor: accent.bg,
          color: accent.fg,
          border: `1px solid ${accent.border}`,
          fontSize: '0.8125rem',
          lineHeight: 1.3,
          fontWeight: 500,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        <Icon sx={{ fontSize: 14, flexShrink: 0 }} />
        <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {label}
        </Box>
      </Box>
      <Popper
        open={hover && !!anchorRef.current}
        anchorEl={anchorRef.current}
        placement="bottom-start"
        transition
        sx={{ zIndex: 1500, pointerEvents: 'none' }}
      >
        {({ TransitionProps }) => (
          <Fade {...TransitionProps} timeout={150}>
            <Paper
              variant="outlined"
              sx={{ mt: 0.5, px: 1.25, py: 0.75, maxWidth: 280, boxShadow: '0 6px 24px rgba(0,0,0,0.08)' }}
            >
              <Typography variant="caption" sx={{ display: 'block', color: accent.fg, fontWeight: 600 }}>
                {refTypeLabel(type)}
              </Typography>
              <Typography variant="body2" sx={{ fontWeight: 600 }}>
                {label}
              </Typography>
              {meta && (
                <Typography variant="caption" color="text.secondary">
                  {meta}
                </Typography>
              )}
            </Paper>
          </Fade>
        )}
      </Popper>
    </>
  );
}

function refTypeLabel(type: RecordColumnType): string {
  switch (type) {
    case 'product_ref':
      return 'Product';
    case 'document_ref':
      return 'Document';
    case 'record_ref':
      return 'Record';
    case 'contact':
      return 'Contact';
    case 'customer_ref':
      return 'Customer';
    case 'supplier_ref':
    default:
      return 'Supplier';
  }
}
