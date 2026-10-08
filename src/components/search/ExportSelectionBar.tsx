import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import MailOutlineIcon from '@mui/icons-material/MailOutline';
import PlaylistAddIcon from '@mui/icons-material/PlaylistAdd';

/**
 * The bar that appears once something is selected — "N selected", download,
 * send, clear.
 *
 * It is sticky at the bottom rather than at the top of the list because the
 * selection is built by scrolling DOWN through results; a bar that scrolls
 * away is a bar you have to hunt for after you finish choosing.
 *
 * It renders nothing at all when nothing is selected, so the search page a
 * person is only reading is unchanged.
 *
 * `extraAction` is one more thing to do with the selection ("Add to order");
 * `hideExport` drops ZIP / Send for a surface whose only job is to pick.
 */
export interface ExportSelectionBarProps {
  count: number;
  busy?: boolean;
  error?: string | null;
  notice?: string | null;
  /**
   * Something went, and something did not: the documents the sharing rule
   * kept back, by name and reason. Shown beside `notice`, never instead of it.
   */
  warning?: string | null;
  onDownload: () => void;
  onSend: () => void;
  onClear: () => void;
  onDismissMessage?: () => void;
  extraAction?: { label: string; onClick: () => void; testId?: string; primary?: boolean };
  hideExport?: boolean;
}

export function ExportSelectionBar({
  count,
  busy = false,
  error,
  notice,
  warning,
  onDownload,
  onSend,
  onClear,
  onDismissMessage,
  extraAction,
  hideExport = false,
}: ExportSelectionBarProps) {
  if (count === 0 && !error && !notice && !warning) return null;

  return (
    <Box
      sx={{
        position: 'sticky',
        bottom: 0,
        zIndex: 5,
        pt: 2,
        // Clears the fixed version chip in the bottom-right corner, which
        // otherwise sits on top of the last button in this row.
        pb: 5,
        // The page scrolls under it; without a ground the cards show through.
        background: (t) =>
          `linear-gradient(to top, ${t.palette.background.default} 70%, transparent)`,
      }}
      data-testid="export-selection-bar"
    >
      {error && (
        <Alert severity="error" sx={{ mb: 1 }} onClose={onDismissMessage}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" sx={{ mb: 1 }} onClose={onDismissMessage}>
          {notice}
        </Alert>
      )}
      {warning && (
        <Alert severity="warning" sx={{ mb: 1 }} onClose={onDismissMessage} data-testid="export-refused">
          {warning}
        </Alert>
      )}
      {count > 0 && (
        <Paper variant="outlined" sx={{ p: 1.25 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }} useFlexGap>
            <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: '1 1 auto' }}>
              {count} selected
            </Typography>
            {busy && <CircularProgress size={18} />}
            {extraAction && (
              <Button
                size="small"
                variant={extraAction.primary ? 'contained' : 'outlined'}
                startIcon={<PlaylistAddIcon />}
                onClick={extraAction.onClick}
                disabled={busy}
                sx={{ textTransform: 'none' }}
                data-testid={extraAction.testId ?? 'selection-extra-action'}
              >
                {extraAction.label}
              </Button>
            )}
            {!hideExport && <Button
              size="small"
              variant="contained"
              startIcon={<DownloadIcon />}
              onClick={onDownload}
              disabled={busy}
              sx={{ textTransform: 'none' }}
              data-testid="export-download"
            >
              Download ZIP
            </Button>}
            {!hideExport && <Button
              size="small"
              variant="outlined"
              startIcon={<MailOutlineIcon />}
              onClick={onSend}
              disabled={busy}
              sx={{ textTransform: 'none' }}
              data-testid="export-send"
            >
              Send by email
            </Button>}
            <Button
              size="small"
              onClick={onClear}
              disabled={busy}
              sx={{ textTransform: 'none' }}
              data-testid="export-clear"
            >
              Clear
            </Button>
          </Stack>
        </Paper>
      )}
    </Box>
  );
}
