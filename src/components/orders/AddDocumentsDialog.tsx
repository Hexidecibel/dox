import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { SearchWorkspace } from '../search/SearchWorkspace';
import { api } from '../../lib/api';
import { describePickResult } from './AddToOrderDialog';

/**
 * "Add COAs" on an order: the search workspace, in a dialog, with one job.
 *
 * It is the SAME workspace as /documents, not a second picker -- the same
 * coverage answer, the same lot rows, and the same gate: a covering result has
 * a checkbox, a likely or nearby one has to be included on purpose. What is
 * different is only what happens to the selection: it goes onto this order.
 *
 * The workspace's page-wide shortcuts are off here (a document-level key
 * handler would act on the order page behind the dialog) and its state stays
 * out of the URL, so closing the dialog leaves the order page as it was.
 */
export interface AddDocumentsDialogProps {
  open: boolean;
  orderId: string;
  orderNumber: string;
  tenantId?: string;
  onClose: () => void;
  /** Called after documents landed on the order, so the page can reload its lines. */
  onAdded: () => void;
}

export function AddDocumentsDialog({ open, orderId, orderNumber, tenantId, onClose, onAdded }: AddDocumentsDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xl" fullWidth data-testid="add-documents-dialog">
      <DialogTitle>
        Add certificates to order {orderNumber}
        <Typography variant="body2" color="text.secondary">
          Search by lot, product, production date or PO. Only approved documents are on file here. Each one you add becomes a line per lot it certifies.
        </Typography>
      </DialogTitle>
      <DialogContent dividers sx={{ minHeight: '60vh' }}>
        {open && (
          <SearchWorkspace
            surface="documents"
            syncToUrl={false}
            tenantId={tenantId}
            globalShortcuts={false}
            selectionAction={{
              label: 'Add to this order',
              only: true,
              testId: 'add-to-this-order',
              onRun: async (docs) => {
                const res = await api.orders.addItems(orderId, { document_ids: docs.map((d) => d.id) });
                onAdded();
                return describePickResult(orderNumber, res);
              },
            }}
          />
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} sx={{ textTransform: 'none' }} data-testid="add-documents-done">
          Done
        </Button>
      </DialogActions>
    </Dialog>
  );
}
