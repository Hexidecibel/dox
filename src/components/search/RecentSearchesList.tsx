import {
  Box,
  Button,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
import HistoryIcon from '@mui/icons-material/History';
import CloseIcon from '@mui/icons-material/Close';

/**
 * Popover content for the recent-searches surface. Shows a list of
 * past free-text queries with one-click recall, per-row remove, and a
 * "Clear all" footer.
 */
export interface RecentSearchesListProps {
  recent: string[];
  onPick: (query: string) => void;
  onRemove?: (query: string) => void;
  onClear?: () => void;
}

export function RecentSearchesList({
  recent,
  onPick,
  onRemove,
  onClear,
}: RecentSearchesListProps) {
  if (recent.length === 0) {
    return (
      <Box sx={{ px: 2, py: 1.5 }}>
        <Typography variant="caption" color="text.secondary">
          No recent searches yet.
        </Typography>
      </Box>
    );
  }
  return (
    <Box>
      <List dense disablePadding>
        {recent.map((q) => (
          <ListItem
            key={q}
            disablePadding
            secondaryAction={
              onRemove && (
                <IconButton
                  edge="end"
                  size="small"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(q);
                  }}
                  aria-label={`remove ${q}`}
                >
                  <CloseIcon fontSize="small" />
                </IconButton>
              )
            }
          >
            <ListItemButton onClick={() => onPick(q)}>
              <HistoryIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
              <ListItemText
                primary={q}
                primaryTypographyProps={{
                  variant: 'body2',
                  noWrap: true,
                }}
              />
            </ListItemButton>
          </ListItem>
        ))}
      </List>
      {onClear && (
        <Box sx={{ px: 1.5, py: 0.5, borderTop: '1px solid', borderColor: 'divider' }}>
          <Button size="small" variant="text" onClick={onClear} sx={{ textTransform: 'none' }}>
            Clear all
          </Button>
        </Box>
      )}
    </Box>
  );
}
