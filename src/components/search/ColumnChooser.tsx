import { useState } from 'react';
import { Button, Checkbox, FormControlLabel, Menu, Stack, Typography } from '@mui/material';
import ViewColumnRoundedIcon from '@mui/icons-material/ViewColumnRounded';
import { SEARCH_COLUMNS } from '../../../shared/searchFields';

/**
 * Which columns the Advanced documents table shows (search Phase 3). The
 * document title is always shown. The choice travels in the query's view
 * (`?cols=`), so it is part of a saved view and of a shared link.
 */
export interface ColumnChooserProps {
  columns: string[];
  onChange: (next: string[]) => void;
}

export function ColumnChooser({ columns, onChange }: ColumnChooserProps) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const on = new Set(columns);
  return (
    <>
      <Button
        size="small"
        startIcon={<ViewColumnRoundedIcon />}
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ textTransform: 'none' }}
        data-testid="column-chooser"
        aria-haspopup="menu"
      >
        Columns
      </Button>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)} slotProps={{ paper: { sx: { px: 1.5, py: 1, maxHeight: 420 } } }}>
        <Typography variant="subtitle2" sx={{ mb: 0.5 }}>Columns</Typography>
        <Stack>
          {SEARCH_COLUMNS.map((c) => (
            <FormControlLabel
              key={c.key}
              control={
                <Checkbox
                  size="small"
                  checked={c.key === 'title' || on.has(c.key)}
                  disabled={c.key === 'title'}
                  onChange={(e) => {
                    const next = SEARCH_COLUMNS.map((x) => x.key).filter((k) => k === 'title' || (k === c.key ? e.target.checked : on.has(k)));
                    onChange(next);
                  }}
                  inputProps={{ 'aria-label': c.label, 'data-testid': `column-${c.key}` } as React.InputHTMLAttributes<HTMLInputElement>}
                />
              }
              label={<Typography variant="body2">{c.label}</Typography>}
            />
          ))}
        </Stack>
        <Typography variant="caption" color="text.secondary">Stored with the saved view.</Typography>
      </Menu>
    </>
  );
}
