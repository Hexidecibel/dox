import { useState } from 'react';
import { Button, Menu, MenuItem } from '@mui/material';
import SortIcon from '@mui/icons-material/Sort';
import type { SearchSort } from '../../../shared/types';

const LABELS: Record<SearchSort, string> = {
  relevance: 'Relevance',
  newest: 'Newest first',
  oldest: 'Oldest first',
  name: 'Name (A→Z)',
};

const ORDER: SearchSort[] = ['relevance', 'newest', 'oldest', 'name'];

/**
 * Plain dropdown for the search sort axis. Lives inline with the
 * results header — `<ResultsList>` slot. Defaults to `relevance` (the
 * URL codec drops it on encode so the canonical URL stays clean).
 */
export interface SortMenuProps {
  value: SearchSort;
  onChange: (next: SearchSort) => void;
  /** Hide certain sort options if a context doesn't support them. */
  exclude?: SearchSort[];
}

export function SortMenu({ value, onChange, exclude = [] }: SortMenuProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const visible = ORDER.filter((s) => !exclude.includes(s));

  return (
    <>
      <Button
        size="small"
        variant="text"
        startIcon={<SortIcon fontSize="small" />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ textTransform: 'none' }}
        aria-haspopup="menu"
      >
        Sort: {LABELS[value]}
      </Button>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {visible.map((s) => (
          <MenuItem
            key={s}
            selected={s === value}
            onClick={() => {
              onChange(s);
              setAnchor(null);
            }}
          >
            {LABELS[s]}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
