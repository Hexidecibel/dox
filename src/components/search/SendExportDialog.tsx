import { useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import type { UniversalSearchDocument } from '../../../shared/types';

/**
 * "Send these to someone" — the on-behalf-of dialog.
 *
 * THE PERSON SEARCHING IS USUALLY NOT THE PERSON WHO NEEDS THE DOCUMENTS
 * (AJ Conner, 2026-09-14: it is normally being forwarded to a salesperson).
 * So "on behalf of" is a first-class field rather than something typed into
 * the message, and the dialog says out loud what the recipient will see: the
 * mail comes from the portal, replies come back to the sender, and nobody's
 * domain is impersonated.
 *
 * WHAT IS SENT IS A LINK, NOT ATTACHMENTS, and the dialog says that too — a
 * recipient expecting a PDF and receiving a link should have been told by the
 * person who pressed send.
 */
export interface SendExportDialogProps {
  open: boolean;
  documents: UniversalSearchDocument[];
  senderName: string;
  senderEmail: string;
  busy?: boolean;
  error?: string | null;
  onClose: () => void;
  onSend: (input: { recipients: string; onBehalfOf: string; message: string }) => void;
}

export function SendExportDialog({
  open,
  documents,
  senderName,
  senderEmail,
  busy = false,
  error,
  onClose,
  onSend,
}: SendExportDialogProps) {
  const [recipients, setRecipients] = useState('');
  const [onBehalfOf, setOnBehalfOf] = useState('');
  const [message, setMessage] = useState('');

  const count = documents.length;

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Send {count} document{count === 1 ? '' : 's'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 0.5 }}>
          {error && <Alert severity="error">{error}</Alert>}

          <TextField
            label="To"
            placeholder="buyer@customer.com, qa@customer.com"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            fullWidth
            size="small"
            helperText="Separate addresses with commas."
            inputProps={{ 'data-testid': 'export-recipients' }}
          />

          <TextField
            label="On behalf of (optional)"
            placeholder="Marco Silva, Sales"
            value={onBehalfOf}
            onChange={(e) => setOnBehalfOf(e.target.value)}
            fullWidth
            size="small"
            helperText={`The email will say "${senderName} sent these on behalf of …".`}
            inputProps={{ 'data-testid': 'export-on-behalf-of' }}
          />

          <TextField
            label="Message (optional)"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            fullWidth
            size="small"
            multiline
            minRows={3}
            inputProps={{ 'data-testid': 'export-message' }}
          />

          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              They get a list of the documents and one link that expires in 30 days — not
              attachments. The email is sent by the portal with replies going to {senderEmail}.
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Sending {count === 1 ? 'this document' : `these ${count} documents`}:{' '}
              {documents.slice(0, 5).map((d) => d.title ?? '(untitled)').join(', ')}
              {count > 5 ? `, and ${count - 5} more` : ''}.
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={() => onSend({ recipients, onBehalfOf, message })}
          disabled={busy || recipients.trim() === ''}
          sx={{ textTransform: 'none' }}
          data-testid="export-send-confirm"
        >
          Send
        </Button>
      </DialogActions>
    </Dialog>
  );
}
