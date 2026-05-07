import { useEffect, useRef, useState } from 'react';
import {
  Box,
  ClickAwayListener,
  IconButton,
  InputAdornment,
  Paper,
  Popper,
  Stack,
  TextField,
  ToggleButton,
  Tooltip,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import HistoryIcon from '@mui/icons-material/History';
import StarIcon from '@mui/icons-material/Star';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import { RecentSearchesList } from './RecentSearchesList';

/**
 * Search input surface for the document/universal search panels.
 *
 * Shape:
 *   [ search-icon ][         text input          ][ ⭐ saved ][ 🕐 recent ][ AI ]
 *
 * Click on the recent or saved icon opens a popover anchored to the
 * input. The AI toggle is a passive switch — the parent decides what
 * to do with it (route to the natural endpoint, etc.). The TextField
 * is uncontrolled-by-debounce: we hand the parent every keystroke as
 * `value` and let it debounce upstream. Pressing Enter forces an
 * immediate `onSubmit` so users who want to pause the live filter can
 * still mash return.
 */
export interface SearchBarProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  recent?: string[];
  onRecentPick?: (q: string) => void;
  onRecentRemove?: (q: string) => void;
  onRecentClear?: () => void;
  onSavedClick?: () => void;
  aiMode?: boolean;
  onAiToggle?: (next: boolean) => void;
  placeholder?: string;
}

export function SearchBar({
  value,
  onChange,
  onSubmit,
  recent = [],
  onRecentPick,
  onRecentRemove,
  onRecentClear,
  onSavedClick,
  aiMode,
  onAiToggle,
  placeholder = 'Search documents, suppliers, products…',
}: SearchBarProps) {
  const [recentOpen, setRecentOpen] = useState(false);
  const inputWrapperRef = useRef<HTMLDivElement>(null);

  // Auto-close recent popover when value changes (user started typing).
  useEffect(() => {
    if (recentOpen && value.length > 0) setRecentOpen(false);
  }, [value, recentOpen]);

  return (
    <Box ref={inputWrapperRef} sx={{ position: 'relative', mb: 1.5 }}>
      <TextField
        fullWidth
        size="small"
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onSubmit?.(value);
            setRecentOpen(false);
          }
        }}
        onFocus={() => {
          if (recent.length > 0 && value.length === 0) setRecentOpen(true);
        }}
        InputProps={{
          startAdornment: (
            <InputAdornment position="start">
              <SearchIcon fontSize="small" color="action" />
            </InputAdornment>
          ),
          endAdornment: (
            <InputAdornment position="end">
              <Stack direction="row" spacing={0.25}>
                {onSavedClick && (
                  <Tooltip title="Saved searches">
                    <IconButton size="small" onClick={onSavedClick} aria-label="saved searches">
                      <StarIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                {recent.length > 0 && (
                  <Tooltip title="Recent searches">
                    <IconButton
                      size="small"
                      onClick={() => setRecentOpen((v) => !v)}
                      aria-label="recent searches"
                    >
                      <HistoryIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                )}
                {onAiToggle && (
                  <Tooltip title={aiMode ? 'AI mode on' : 'AI mode off'}>
                    <ToggleButton
                      value="ai"
                      selected={!!aiMode}
                      size="small"
                      onChange={() => onAiToggle(!aiMode)}
                      aria-label="ai mode"
                      sx={{ border: 0, p: 0.5 }}
                    >
                      <AutoAwesomeIcon fontSize="small" />
                    </ToggleButton>
                  </Tooltip>
                )}
              </Stack>
            </InputAdornment>
          ),
        }}
      />
      {recentOpen && (
        <ClickAwayListener onClickAway={() => setRecentOpen(false)}>
          <Popper
            open={recentOpen}
            anchorEl={inputWrapperRef.current}
            placement="bottom-start"
            sx={{ zIndex: 1300, width: inputWrapperRef.current?.clientWidth }}
          >
            <Paper sx={{ mt: 0.5, py: 0.5, maxHeight: 320, overflow: 'auto' }}>
              <RecentSearchesList
                recent={recent}
                onPick={(q) => {
                  setRecentOpen(false);
                  onRecentPick?.(q);
                }}
                onRemove={onRecentRemove}
                onClear={onRecentClear}
              />
            </Paper>
          </Popper>
        </ClickAwayListener>
      )}
    </Box>
  );
}
