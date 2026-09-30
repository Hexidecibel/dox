/**
 * Rules table F6: "The review step has to catch a sales sheet submitted as a
 * spec sheet." Shown on a queue card the server flagged (`sales_sheet_warning`,
 * shared/salesSheetCheck.ts). Advisory: it names the preset reject reason and
 * offers it in one click, and approving stays open -- the reviewer decides.
 */
import { Alert, Button, Typography } from '@mui/material';
import type { SalesSheetWarning } from '../../shared/salesSheetCheck';

export function SalesSheetWarningBanner({
  warning,
  onRejectAsSalesSheet,
  disabled,
}: {
  warning: SalesSheetWarning | null | undefined;
  onRejectAsSalesSheet?: () => void;
  disabled?: boolean;
}) {
  if (!warning) return null;
  return (
    <Alert
      severity="warning"
      sx={{ mb: 2 }}
      data-testid="sales-sheet-warning"
      action={
        onRejectAsSalesSheet ? (
          <Button color="inherit" size="small" onClick={onRejectAsSalesSheet} disabled={disabled} sx={{ textTransform: 'none' }}>
            Reject as sales sheet
          </Button>
        ) : undefined
      }
    >
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        Possibly a sales sheet, not a specification
      </Typography>
      <Typography variant="caption" sx={{ display: 'block' }}>
        {warning.message}
      </Typography>
    </Alert>
  );
}
