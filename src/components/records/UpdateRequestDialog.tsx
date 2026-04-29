/**
 * UpdateRequestDialog — modal for "Send update request" on a row.
 *
 * Renders inside RowEditPanel. The user picks a recipient (email or
 * tenant-user autocomplete), the fields to fill, an optional message,
 * and an optional due date. On send we POST to the create endpoint and
 * call back with the response so the parent can refresh its list of
 * pending requests.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
  alpha,
  useTheme,
} from '@mui/material';
import {
  ContentCopyOutlined as CopyIcon,
  CheckOutlined as CheckIcon,
  CloseOutlined as CloseIcon,
} from '@mui/icons-material';
import { recordsApi } from '../../lib/recordsApi';
import { api } from '../../lib/api';
import type {
  ApiRecordColumn,
  RecordUpdateRequest,
  RecordUpdateRequestCreateResponse,
} from '../../../shared/types';
import type { User } from '../../lib/types';

/** Column types that can't be filled by an external recipient. */
const NON_FILLABLE_TYPES = new Set<ApiRecordColumn['type']>([
  'formula',
  'rollup',
  'attachment',
]);

interface Props {
  open: boolean;
  onClose: () => void;
  sheetId: string;
  rowId: string;
  rowTitle: string | null;
  columns: ApiRecordColumn[];
  /**
   * Called after a successful send. Parent uses this to refresh its
   * pending-requests list and add the activity entry to the local feed.
   */
  onSent: (request: RecordUpdateRequest, publicUrl: string, emailSent: boolean) => void;
}

interface RecipientOption {
  id: string | null;
  email: string;
  name: string | null;
}

/** Pre-select all editable columns so the common case is one click. */
function defaultSelectedKeys(columns: ApiRecordColumn[]): string[] {
  return columns
    .filter((c) => c.archived === 0 && !NON_FILLABLE_TYPES.has(c.type))
    .map((c) => c.key);
}

export function UpdateRequestDialog({
  open,
  onClose,
  sheetId,
  rowId,
  rowTitle,
  columns,
  onSent,
}: Props) {
  const theme = useTheme();
  const fillableColumns = useMemo(
    () => columns.filter((c) => c.archived === 0 && !NON_FILLABLE_TYPES.has(c.type)),
    [columns],
  );

  const [recipientInput, setRecipientInput] = useState('');
  const [recipient, setRecipient] = useState<RecipientOption | null>(null);
  const [selectedKeys, setSelectedKeys] = useState<string[]>(() => defaultSelectedKeys(columns));
  const [message, setMessage] = useState('');
  const [dueDate, setDueDate] = useState('');

  const [users, setUsers] = useState<RecipientOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RecordUpdateRequestCreateResponse | null>(null);
  const [copied, setCopied] = useState(false);

  // Reset state when the dialog closes/reopens. Recompute defaults when
  // columns change (rare, but cheap).
  useEffect(() => {
    if (!open) return;
    setRecipientInput('');
    setRecipient(null);
    setSelectedKeys(defaultSelectedKeys(columns));
    setMessage('');
    setDueDate('');
    setError(null);
    setResult(null);
    setCopied(false);
  }, [open, columns]);

  // Lazy-load tenant users for the autocomplete on open. Failure is
  // silent — the user can still type a free email.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setUsersLoading(true);
    void (async () => {
      try {
        const list = (await api.users.list()) as User[];
        if (cancelled) return;
        setUsers(
          list
            .filter((u) => u.active)
            .map((u) => ({ id: u.id, email: u.email, name: u.name })),
        );
      } catch {
        // Silent — autocomplete just won't have suggestions.
      } finally {
        if (!cancelled) setUsersLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleToggleField = (key: string) => {
    setSelectedKeys((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  const handleSelectAll = () => {
    setSelectedKeys(defaultSelectedKeys(columns));
  };

  const handleClearAll = () => {
    setSelectedKeys([]);
  };

  const handleSend = async () => {
    setError(null);
    const email = (recipient?.email ?? recipientInput).trim().toLowerCase();
    if (!email || !email.includes('@')) {
      setError('Enter a valid recipient email.');
      return;
    }
    if (selectedKeys.length === 0) {
      setError('Pick at least one field for the recipient to fill.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await recordsApi.updateRequests.create(sheetId, rowId, {
        recipient_email: email,
        recipient_user_id: recipient?.id ?? null,
        fields_requested: selectedKeys,
        message: message.trim() || null,
        due_date: dueDate || null,
      });
      setResult(res);
      onSent(res.request, res.public_url, res.email_sent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send update request.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyLink = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.public_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API blocked — surface the URL inline so user can copy manually.
    }
  };

  // ---- Success view (after send) ----
  if (result) {
    return (
      <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
        <DialogTitle sx={{ pr: 6 }}>
          Update request sent
          <IconButton
            aria-label="Close"
            onClick={onClose}
            sx={{ position: 'absolute', right: 8, top: 8 }}
          >
            <CloseIcon />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {result.email_sent ? (
            <Alert severity="success" sx={{ mb: 2 }}>
              Email sent to {result.request.recipient_email}.
            </Alert>
          ) : (
            <Alert severity="info" sx={{ mb: 2 }}>
              Email delivery isn't configured here yet, so we didn't send a
              notification. Copy the link below and share it with{' '}
              <strong>{result.request.recipient_email}</strong> manually.
            </Alert>
          )}
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.5 }}>
            Magic link
          </Typography>
          <Box
            sx={{
              mt: 0.5,
              display: 'flex',
              alignItems: 'center',
              gap: 1,
              p: 1.5,
              borderRadius: 1,
              bgcolor: alpha(theme.palette.primary.main, 0.06),
              border: 1,
              borderColor: 'divider',
            }}
          >
            <Typography
              sx={{
                flex: 1,
                fontFamily: 'monospace',
                fontSize: 13,
                wordBreak: 'break-all',
                color: 'text.primary',
              }}
            >
              {result.public_url}
            </Typography>
            <Tooltip title={copied ? 'Copied!' : 'Copy link'}>
              <IconButton onClick={handleCopyLink} size="small">
                {copied ? <CheckIcon fontSize="small" /> : <CopyIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Box>
          <Typography variant="caption" sx={{ display: 'block', mt: 1, color: 'text.secondary' }}>
            The recipient can fill it in without an account. The link expires in 30 days.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Done</Button>
        </DialogActions>
      </Dialog>
    );
  }

  // ---- Edit/compose view ----
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ pr: 6 }}>
        Send update request
        {rowTitle && (
          <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary', fontWeight: 400 }}>
            on {rowTitle}
          </Typography>
        )}
        <IconButton
          aria-label="Close"
          onClick={onClose}
          sx={{ position: 'absolute', right: 8, top: 8 }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2.5} sx={{ pt: 1 }}>
          {/* Recipient */}
          <Autocomplete<RecipientOption, false, false, true>
            freeSolo
            options={users}
            loading={usersLoading}
            value={recipient}
            inputValue={recipientInput}
            onInputChange={(_, v) => setRecipientInput(v)}
            onChange={(_, v) => {
              if (typeof v === 'string') {
                setRecipient(null);
                setRecipientInput(v);
              } else {
                setRecipient(v);
                setRecipientInput(v?.email ?? '');
              }
            }}
            getOptionLabel={(o) => (typeof o === 'string' ? o : o.email)}
            isOptionEqualToValue={(a, b) => a.email === b.email}
            renderOption={(props, opt) => (
              <Box component="li" {...props} key={opt.id ?? opt.email} sx={{ display: 'block !important', py: 1 }}>
                <Typography sx={{ fontSize: 14, fontWeight: 500 }}>
                  {opt.name || opt.email}
                </Typography>
                {opt.name && (
                  <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
                    {opt.email}
                  </Typography>
                )}
              </Box>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Recipient email"
                type="email"
                placeholder="bob@example.com"
                required
                autoFocus
                inputMode="email"
                helperText="Pick a teammate or type any email."
              />
            )}
          />

          {/* Fields to request */}
          <Box>
            <Stack direction="row" alignItems="baseline" spacing={1} sx={{ mb: 1 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                Fields to fill
              </Typography>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                ({selectedKeys.length} selected)
              </Typography>
              <Box sx={{ flex: 1 }} />
              <Button size="small" onClick={handleSelectAll}>All</Button>
              <Button size="small" onClick={handleClearAll}>Clear</Button>
            </Stack>
            {fillableColumns.length === 0 ? (
              <Typography variant="body2" color="text.secondary">
                No fillable columns on this sheet.
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
                {fillableColumns.map((col) => {
                  const checked = selectedKeys.includes(col.key);
                  return (
                    <Chip
                      key={col.id}
                      label={col.label}
                      onClick={() => handleToggleField(col.key)}
                      icon={
                        <Checkbox
                          checked={checked}
                          tabIndex={-1}
                          size="small"
                          sx={{
                            p: 0,
                            ml: 0.5,
                            '& .MuiSvgIcon-root': { fontSize: 16 },
                          }}
                        />
                      }
                      variant={checked ? 'filled' : 'outlined'}
                      color={checked ? 'primary' : 'default'}
                      sx={{ pl: 0.25 }}
                    />
                  );
                })}
              </Box>
            )}
          </Box>

          {/* Message */}
          <TextField
            label="Message (optional)"
            placeholder="Quick context for the recipient — e.g. 'Need this before Friday's audit.'"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            multiline
            minRows={2}
            maxRows={5}
            inputProps={{ maxLength: 2000 }}
          />

          {/* Due date */}
          <TextField
            label="Due date (optional)"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            InputLabelProps={{ shrink: true }}
            sx={{ maxWidth: 240 }}
          />

          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={submitting}>Cancel</Button>
        <Button
          onClick={handleSend}
          variant="contained"
          disableElevation
          disabled={submitting || selectedKeys.length === 0}
          startIcon={submitting ? <CircularProgress size={16} sx={{ color: 'inherit' }} /> : undefined}
        >
          {submitting ? 'Sending…' : 'Send request'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
