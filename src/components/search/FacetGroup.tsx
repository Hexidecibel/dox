import { useState } from 'react';
import {
  Accordion,
  AccordionSummary,
  AccordionDetails,
  Box,
  Button,
  Typography,
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { FacetOption } from './FacetOption';
import type { FacetCount } from '../../../shared/types';

/**
 * Collapsible group of facet rows for the sidebar.
 *
 * Selection state is owned by the parent (the panel), so this component
 * stays presentational. The "Show more" affordance reveals the long
 * tail of options past the initial limit (default 8) without spawning a
 * separate dialog.
 *
 * Filtering inside a single facet is OR (a doc matches if its supplier
 * is A *or* B); filtering across facets is AND (must satisfy supplier
 * AND doc_type). The Phase 4 backend already returns sticky-filter
 * counts, so the displayed counts here are correct without further
 * client-side massaging.
 */
export interface FacetGroupProps {
  title: string;
  options: FacetCount[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Initial visible row count before "Show more". Default 8. */
  initialLimit?: number;
  /** Default-collapsed if false. Defaults to true (expanded). */
  defaultExpanded?: boolean;
}

export function FacetGroup({
  title,
  options,
  selected,
  onChange,
  initialLimit = 8,
  defaultExpanded = true,
}: FacetGroupProps) {
  const [showAll, setShowAll] = useState(false);

  const visible = showAll ? options : options.slice(0, initialLimit);
  const hidden = options.length - visible.length;
  const selectedCount = selected.length;

  const toggle = (value: string) => {
    onChange(
      selected.includes(value)
        ? selected.filter((v) => v !== value)
        : [...selected, value],
    );
  };

  return (
    <Accordion
      defaultExpanded={defaultExpanded}
      disableGutters
      elevation={0}
      sx={{
        '&:before': { display: 'none' },
        bgcolor: 'transparent',
        borderTop: '1px solid',
        borderColor: 'divider',
      }}
    >
      <AccordionSummary
        expandIcon={<ExpandMoreIcon fontSize="small" />}
        sx={{ minHeight: 36, '& .MuiAccordionSummary-content': { my: 0.75 } }}
      >
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          {title}
        </Typography>
        {selectedCount > 0 && (
          <Typography variant="caption" color="primary" sx={{ mr: 1 }}>
            {selectedCount} selected
          </Typography>
        )}
      </AccordionSummary>
      <AccordionDetails sx={{ pt: 0, pb: 1 }}>
        {options.length === 0 ? (
          <Typography variant="caption" color="text.secondary">
            No options.
          </Typography>
        ) : (
          <Box>
            {visible.map((opt) => (
              <FacetOption
                key={opt.value}
                value={opt.value}
                label={opt.label}
                count={opt.count}
                selected={selected.includes(opt.value)}
                onToggle={toggle}
              />
            ))}
            {hidden > 0 && (
              <Button
                size="small"
                variant="text"
                onClick={() => setShowAll(true)}
                sx={{ mt: 0.5, textTransform: 'none' }}
              >
                Show {hidden} more
              </Button>
            )}
            {showAll && options.length > initialLimit && (
              <Button
                size="small"
                variant="text"
                onClick={() => setShowAll(false)}
                sx={{ mt: 0.5, textTransform: 'none' }}
              >
                Show less
              </Button>
            )}
          </Box>
        )}
      </AccordionDetails>
    </Accordion>
  );
}
