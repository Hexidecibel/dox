import {
  Alert,
  Box,
  CircularProgress,
  Pagination,
  Typography,
} from '@mui/material';
import { EmptyState } from '../EmptyState';

/**
 * Generic loading / empty / error / pagination wrapper for any search
 * result list. The result rendering is delegated via a render-prop so
 * the same chrome serves DocumentSearchPanel and per-tab views inside
 * UniversalSearchPanel.
 *
 * Pagination is page-based (1-indexed) — matches the rest of the app.
 * Pass `pageSize` so the list can compute how many pages exist from
 * the `total`.
 */
export interface ResultsListProps<T> {
  results: T[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  error?: string | null;
  onPageChange: (page: number) => void;
  emptyTitle?: string;
  emptyDescription?: React.ReactNode;
  /** Optional header slot (e.g. SortMenu, result count). */
  header?: React.ReactNode;
  renderItem: (item: T) => React.ReactNode;
}

export function ResultsList<T>({
  results,
  total,
  page,
  pageSize,
  loading,
  error,
  onPageChange,
  emptyTitle = 'No results',
  emptyDescription = 'Try a broader query or remove some filters.',
  header,
  renderItem,
}: ResultsListProps<T>) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <Box>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          mb: 1,
        }}
      >
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1 }}>
          {loading
            ? 'Searching…'
            : `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'}`}
        </Typography>
        {header}
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {error}
        </Alert>
      )}

      {loading && results.length === 0 ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress size={28} />
        </Box>
      ) : !error && total === 0 ? (
        <EmptyState title={emptyTitle} description={emptyDescription} />
      ) : (
        <Box>{results.map((item) => renderItem(item))}</Box>
      )}

      {total > pageSize && (
        <Box sx={{ display: 'flex', justifyContent: 'center', mt: 2 }}>
          <Pagination
            count={pageCount}
            page={page}
            onChange={(_, p) => onPageChange(p)}
            color="primary"
            size="small"
          />
        </Box>
      )}
    </Box>
  );
}
