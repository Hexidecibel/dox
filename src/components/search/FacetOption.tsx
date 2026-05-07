import { Box, Checkbox, Typography } from '@mui/material';

/**
 * One row inside a {@link FacetGroup}. Checkbox + label + count, all
 * clickable. The count is greyed out and right-aligned.
 *
 * Stays presentational — no facet logic; the group owns selection state
 * and toggling.
 */
export interface FacetOptionProps {
  value: string;
  label: string;
  count: number;
  selected: boolean;
  onToggle: (value: string) => void;
}

export function FacetOption({
  value,
  label,
  count,
  selected,
  onToggle,
}: FacetOptionProps) {
  return (
    <Box
      role="button"
      tabIndex={0}
      onClick={() => onToggle(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle(value);
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 0.5,
        py: 0.25,
        px: 0.5,
        borderRadius: 0.5,
        cursor: 'pointer',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      <Checkbox
        size="small"
        checked={selected}
        // The whole row toggles; we just stop the change from firing twice.
        onChange={() => {}}
        sx={{ p: 0.25, mr: 0.5 }}
        inputProps={{ 'aria-label': `${label} (${count})` }}
      />
      <Typography
        variant="body2"
        sx={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {count.toLocaleString()}
      </Typography>
    </Box>
  );
}
