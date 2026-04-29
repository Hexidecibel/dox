/**
 * RowEditPanel — the body shared by the desktop drawer and the mobile
 * full-screen modal. Renders every (non-archived) column as a stacked
 * field, plus Activity / Comments / Attachments sub-sections. The
 * panel commits changes per-cell via the parent's onPatchCell, so
 * dismissing the panel without an explicit save is intentional and
 * safe — every blur has already committed.
 */

import { useEffect, useState } from 'react';
import {
  Box,
  Button,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  OpenInNewOutlined as OpenIcon,
  HistoryOutlined as HistoryIcon,
  ChatBubbleOutline as CommentIcon,
  AttachFileOutlined as AttachIcon,
  DeleteOutline as DeleteIcon,
  SendOutlined as SendIcon,
} from '@mui/icons-material';
import { CellEditor } from './CellEditor';
import { dropdownOptions, formatCellValue, refLabel } from './cellHelpers';
import { UpdateRequestDialog } from './UpdateRequestDialog';
import { recordsApi } from '../../lib/recordsApi';
import type {
  ApiRecordActivity,
  ApiRecordColumn,
  ApiRecordRow,
  ApiRecordRowAttachment,
  RecordColumnType,
  RecordRowData,
  RecordUpdateRequest,
} from '../../../shared/types';

const ENTITY_REF_TYPES: RecordColumnType[] = [
  'supplier_ref',
  'product_ref',
  'customer_ref',
  'document_ref',
  'record_ref',
  'contact',
];

interface RowEditPanelProps {
  sheetId: string;
  row: ApiRecordRow;
  data: RecordRowData;
  columns: ApiRecordColumn[];
  tenantId: string | null;
  /** Mobile mode bumps min target sizes and switches picker to fullscreen. */
  mobile?: boolean;
  /**
   * Optional id→name lookup harvested from current row data, used by the
   * activity feed to resolve entity-ref values that come back as bare IDs
   * (e.g. supplier_id strings) instead of `{id, name}` objects.
   */
  refs?: Record<string, string>;
  onPatchCell: (columnKey: string, value: unknown) => Promise<void>;
  onArchive: () => void;
}

function formatActivityTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(/[Zz]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
  if (isNaN(ts)) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function activityKindLabel(kind: string): string {
  switch (kind) {
    case 'created': return 'created this row';
    case 'updated': return 'updated this row';
    case 'cell_updated': return 'updated a cell';
    case 'archived': return 'archived this row';
    case 'created_via_form': return 'submitted via form';
    case 'update_request_sent': return 'sent an update request';
    case 'update_request_responded': return 'filled an update request';
    case 'update_request_cancelled': return 'cancelled an update request';
    default: return kind.replace(/_/g, ' ');
  }
}

/**
 * Resolve the display name for an activity actor. Activity rows include
 * `actor_name` from a LEFT JOIN on users — when the actor still exists
 * we use that. NULL actor_id covers two cases:
 *   - public form submission (kind='created_via_form') — credit the form
 *   - seeded / system rows — fall back to "Someone" so the feed line
 *     still scans naturally without dangling subject.
 */
function actorDisplay(activity: ApiRecordActivity): string {
  if (activity.actor_name && activity.actor_name.trim()) {
    return activity.actor_name;
  }
  // Update-request submissions: actor_id is NULL because recipients
  // aren't authed users. Surface the recipient_email from details so
  // the feed reads "bob@example.com" instead of a generic "Someone".
  if (activity.kind === 'cell_updated' || activity.kind === 'update_request_responded') {
    const details = parseActivityDetails(activity.details);
    const email = details && typeof details.recipient_email === 'string' ? details.recipient_email : null;
    if (email) return email;
  }
  if (activity.kind === 'created_via_form') {
    return 'Form submission';
  }
  return 'Someone';
}

const EM_DASH = '—';

/** Parse the activity details JSON, tolerant of nulls and bad shapes. */
function parseActivityDetails(details: string | null | undefined): Record<string, unknown> | null {
  if (!details) return null;
  try {
    const v = JSON.parse(details);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Format a from/to value for the activity feed. Reuses the grid's
 * formatters so dropdown values render as their option label, dates
 * format the same way, etc.
 */
function formatActivityValue(
  column: ApiRecordColumn,
  value: unknown,
  refs?: Record<string, string>,
): { text: string; truncated?: boolean; full?: string; faint?: boolean } {
  if (value == null || value === '') return { text: EM_DASH };

  // Dropdowns: resolve to option label.
  if (column.type === 'dropdown_single') {
    const opts = dropdownOptions(column);
    const opt = opts.find((o) => o.value === value);
    return { text: opt?.label ?? opt?.value ?? String(value) };
  }
  if (column.type === 'dropdown_multi') {
    const arr = Array.isArray(value) ? value : [value];
    const opts = dropdownOptions(column);
    const labels = arr.map((v) => {
      const opt = opts.find((o) => o.value === v);
      return opt?.label ?? opt?.value ?? String(v);
    });
    return { text: labels.join(', ') || EM_DASH };
  }

  // Entity refs: prefer a label from the payload; fall back to refs map; finally bare ID with faint style.
  if (ENTITY_REF_TYPES.includes(column.type)) {
    const label = refLabel(value);
    if (label && !(typeof value === 'string')) return { text: label };
    // String value — refLabel returned the string itself; try refs map first.
    if (typeof value === 'string') {
      const resolved = refs?.[value];
      if (resolved) return { text: resolved };
      return { text: value, faint: true };
    }
    if (label) return { text: label };
    return { text: EM_DASH };
  }

  // Long text: truncate at ~40 chars with tooltip on the full value.
  if (column.type === 'long_text') {
    const full = typeof value === 'string' ? value : String(value);
    if (full.length > 40) return { text: `${full.slice(0, 40)}…`, truncated: true, full };
    return { text: full };
  }

  // Everything else: shared cell formatter.
  const text = formatCellValue(column, value);
  return { text: text || EM_DASH };
}

export function RowEditPanel({
  sheetId,
  row,
  data,
  columns,
  tenantId,
  mobile = false,
  refs,
  onPatchCell,
  onArchive,
}: RowEditPanelProps) {
  const [activity, setActivity] = useState<ApiRecordActivity[] | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState('');
  const [attachments, setAttachments] = useState<ApiRecordRowAttachment[] | null>(null);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentsError, setAttachmentsError] = useState('');
  const [updateRequests, setUpdateRequests] = useState<RecordUpdateRequest[]>([]);
  const [updateRequestsLoading, setUpdateRequestsLoading] = useState(false);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [activityRefreshTick, setActivityRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setActivityLoading(true);
    setActivityError('');
    recordsApi.rows
      .activity(sheetId, row.id, { limit: 30 })
      .then((res) => {
        if (!cancelled) setActivity(res.activity);
      })
      .catch((err) => {
        if (!cancelled) setActivityError(err instanceof Error ? err.message : 'Failed to load activity');
      })
      .finally(() => {
        if (!cancelled) setActivityLoading(false);
      });
    return () => { cancelled = true; };
  }, [sheetId, row.id, activityRefreshTick]);

  // Pending update requests for this row. Failure is silent — the
  // section just doesn't render — same posture as Comments/Attachments.
  useEffect(() => {
    let cancelled = false;
    setUpdateRequestsLoading(true);
    recordsApi.updateRequests
      .list(sheetId, row.id)
      .then((res) => {
        if (!cancelled) setUpdateRequests(res.requests);
      })
      .catch(() => {
        if (!cancelled) setUpdateRequests([]);
      })
      .finally(() => {
        if (!cancelled) setUpdateRequestsLoading(false);
      });
    return () => { cancelled = true; };
  }, [sheetId, row.id]);

  useEffect(() => {
    let cancelled = false;
    setAttachmentsLoading(true);
    setAttachmentsError('');
    recordsApi.rows
      .attachments(sheetId, row.id)
      .then((res) => {
        if (!cancelled) setAttachments(res.attachments);
      })
      .catch((err) => {
        if (!cancelled) setAttachmentsError(err instanceof Error ? err.message : 'Failed to load attachments');
      })
      .finally(() => {
        if (!cancelled) setAttachmentsLoading(false);
      });
    return () => { cancelled = true; };
  }, [sheetId, row.id]);

  const orderedColumns = [...columns].sort((a, b) => {
    if (a.is_title === 1 && b.is_title !== 1) return -1;
    if (b.is_title === 1 && a.is_title !== 1) return 1;
    return a.display_order - b.display_order;
  });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Form section */}
      <Stack spacing={mobile ? 2.5 : 2} sx={{ p: mobile ? 2 : 3, pb: 1 }}>
        {orderedColumns.map((col) => (
          <Box key={col.id}>
            <Typography
              variant="caption"
              sx={{
                display: 'block',
                fontWeight: 600,
                color: 'text.secondary',
                textTransform: 'uppercase',
                letterSpacing: 0.4,
                fontSize: '0.6875rem',
                mb: 0.5,
              }}
            >
              {col.label}
            </Typography>
            <CellEditor
              column={col}
              value={data[col.key]}
              tenantId={tenantId}
              spacious
              autoFocus={false}
              fullScreenPicker={mobile}
              onCommit={(value) => {
                void onPatchCell(col.key, value);
              }}
            />
          </Box>
        ))}
      </Stack>

      <Divider />

      {/* Activity */}
      <Box sx={{ p: mobile ? 2 : 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <HistoryIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Activity</Typography>
        </Stack>
        {activityLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 3 }}>
            <CircularProgress size={20} />
          </Box>
        ) : activityError ? (
          <Typography variant="body2" color="error">{activityError}</Typography>
        ) : activity && activity.length > 0 ? (
          <Stack spacing={1.5}>
            {activity.map((a) => {
              const details = parseActivityDetails(a.details);
              const time = formatActivityTime(a.created_at);

              // Cell-level update: render "**{column}**: {from} → {to} · {time}".
              // The backend writes this as kind='cell_updated' with
              // {column_key, from, to}; tolerate kind='updated' too in case
              // older rows or future variants land in the feed.
              const columnKey =
                details && typeof details.column_key === 'string'
                  ? (details.column_key as string)
                  : details && typeof (details as { column?: unknown }).column === 'string'
                  ? ((details as { column: string }).column)
                  : null;
              const hasFromTo = details != null && ('from' in details || 'to' in details);
              const col = columnKey ? columns.find((c) => c.key === columnKey) : null;

              if ((a.kind === 'cell_updated' || a.kind === 'updated') && col && hasFromTo) {
                const from = formatActivityValue(col, details!.from, refs);
                const to = formatActivityValue(col, details!.to, refs);
                const actor = actorDisplay(a);
                return (
                  <Box
                    key={a.id}
                    sx={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 1.5,
                      pb: 1,
                      borderBottom: '1px solid',
                      borderColor: 'divider',
                      '&:last-child': { borderBottom: 'none', pb: 0 },
                    }}
                  >
                    <Typography
                      variant="body2"
                      color="text.secondary"
                      sx={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}
                    >
                      <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
                        {actor}
                      </Box>
                      {' changed '}
                      <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
                        {col.label}
                      </Box>
                      {': '}
                      <Tooltip title={from.full ?? ''} disableHoverListener={!from.truncated}>
                        <Box
                          component="span"
                          sx={from.faint ? { color: 'text.disabled', fontStyle: 'italic' } : undefined}
                        >
                          {from.text}
                        </Box>
                      </Tooltip>
                      {' → '}
                      <Tooltip title={to.full ?? ''} disableHoverListener={!to.truncated}>
                        <Box
                          component="span"
                          sx={{
                            fontWeight: 500,
                            color: 'text.primary',
                            ...(to.faint ? { color: 'text.disabled', fontStyle: 'italic' } : {}),
                          }}
                        >
                          {to.text}
                        </Box>
                      </Tooltip>
                      <Box component="span" sx={{ mx: 0.75 }}>·</Box>
                      <Box component="span">{time}</Box>
                    </Typography>
                  </Box>
                );
              }

              // Fallback for created / archived / created_via_form / unknown kinds.
              const actor = actorDisplay(a);
              const verb = activityKindLabel(a.kind);
              return (
                <Box
                  key={a.id}
                  sx={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 1.5,
                    pb: 1,
                    borderBottom: '1px solid',
                    borderColor: 'divider',
                    '&:last-child': { borderBottom: 'none', pb: 0 },
                  }}
                >
                  <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ flex: 1, minWidth: 0, lineHeight: 1.5 }}
                  >
                    <Box component="span" sx={{ fontWeight: 600, color: 'text.primary' }}>
                      {actor}
                    </Box>
                    {' '}
                    {verb}
                    <Box component="span" sx={{ mx: 0.75 }}>·</Box>
                    <Box component="span">{time}</Box>
                  </Typography>
                </Box>
              );
            })}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">No activity yet.</Typography>
        )}
      </Box>

      <Divider />

      {/* Comments — placeholder */}
      <Box sx={{ p: mobile ? 2 : 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <CommentIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>Comments</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">Comments coming soon.</Typography>
      </Box>

      <Divider />

      {/* Attachments */}
      <Box sx={{ p: mobile ? 2 : 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <AttachIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Attachments
            {attachments && attachments.length > 0 && (
              <Box component="span" sx={{ ml: 0.75, color: 'text.secondary', fontWeight: 400 }}>
                ({attachments.length})
              </Box>
            )}
          </Typography>
        </Stack>
        {attachmentsLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : attachmentsError ? (
          <Typography variant="body2" color="error">{attachmentsError}</Typography>
        ) : attachments && attachments.length > 0 ? (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.25 }}>
            {attachments.map((a) => (
              <AttachmentTile key={a.id} attachment={a} />
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">No attachments yet.</Typography>
        )}
      </Box>

      <Divider />

      {/* Pending update requests */}
      <Box sx={{ p: mobile ? 2 : 3 }}>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
          <SendIcon fontSize="small" sx={{ color: 'text.secondary' }} />
          <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
            Update requests
            {updateRequests.filter((r) => r.status === 'pending').length > 0 && (
              <Box component="span" sx={{ ml: 0.75, color: 'text.secondary', fontWeight: 400 }}>
                ({updateRequests.filter((r) => r.status === 'pending').length} pending)
              </Box>
            )}
          </Typography>
        </Stack>
        {updateRequestsLoading && updateRequests.length === 0 ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
            <CircularProgress size={20} />
          </Box>
        ) : updateRequests.length > 0 ? (
          <Stack spacing={1}>
            {updateRequests.map((req) => (
              <UpdateRequestRow
                key={req.id}
                req={req}
                sheetId={sheetId}
                rowId={row.id}
                onCancelled={() => {
                  setUpdateRequests((prev) =>
                    prev.map((r) =>
                      r.id === req.id ? { ...r, status: 'cancelled' } : r,
                    ),
                  );
                  setActivityRefreshTick((t) => t + 1);
                }}
              />
            ))}
          </Stack>
        ) : (
          <Typography variant="body2" color="text.secondary">
            No requests yet. Use "Send update request" to ask someone to fill specific fields.
          </Typography>
        )}
      </Box>

      <Divider />

      {/* Footer actions */}
      <Box
        sx={{
          p: mobile ? 2 : 3,
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          flexWrap: 'wrap',
        }}
      >
        <Button startIcon={<OpenIcon />} disabled>
          Open full page
        </Button>
        <Button
          variant="outlined"
          startIcon={<SendIcon />}
          onClick={() => setRequestDialogOpen(true)}
        >
          Send update request
        </Button>
        <Box sx={{ flex: 1 }} />
        <IconButton
          aria-label="Archive row"
          color="error"
          onClick={onArchive}
          sx={{ minWidth: 44, minHeight: 44 }}
        >
          <DeleteIcon />
        </IconButton>
      </Box>

      <UpdateRequestDialog
        open={requestDialogOpen}
        onClose={() => setRequestDialogOpen(false)}
        sheetId={sheetId}
        rowId={row.id}
        rowTitle={row.display_title}
        columns={columns}
        onSent={(req) => {
          setUpdateRequests((prev) => [req, ...prev]);
          setActivityRefreshTick((t) => t + 1);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------
// UpdateRequestRow — one entry in the "Update requests" mini-section.
// Shows recipient + status + cancel/copy actions.
// ---------------------------------------------------------------------

function formatRequestRecipient(req: RecordUpdateRequest): string {
  return req.recipient_email;
}

function formatRequestStatus(req: RecordUpdateRequest): { label: string; color: 'default' | 'success' | 'warning' | 'error' } {
  switch (req.status) {
    case 'pending':
      return { label: 'Pending', color: 'warning' };
    case 'responded':
      return { label: 'Responded', color: 'success' };
    case 'expired':
      return { label: 'Expired', color: 'default' };
    case 'cancelled':
      return { label: 'Cancelled', color: 'default' };
    default:
      return { label: req.status, color: 'default' };
  }
}

function UpdateRequestRow({
  req,
  sheetId,
  rowId,
  onCancelled,
}: {
  req: RecordUpdateRequest;
  sheetId: string;
  rowId: string;
  onCancelled: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCancel = async () => {
    setError(null);
    setCancelling(true);
    try {
      await recordsApi.updateRequests.cancel(sheetId, rowId, req.id);
      onCancelled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel.');
    } finally {
      setCancelling(false);
    }
  };

  const status = formatRequestStatus(req);
  const fieldCount = req.fields_requested_keys?.length ?? 0;
  const created = formatActivityTime(req.created_at);

  return (
    <Box
      sx={{
        p: 1.25,
        borderRadius: 1,
        border: 1,
        borderColor: 'divider',
        bgcolor: 'background.default',
      }}
    >
      <Stack direction="row" alignItems="center" spacing={1}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography
            variant="body2"
            sx={{
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {formatRequestRecipient(req)}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {fieldCount} {fieldCount === 1 ? 'field' : 'fields'} · {created}
            {req.due_date && ` · due ${req.due_date}`}
          </Typography>
        </Box>
        <Box
          sx={{
            px: 1,
            py: 0.25,
            borderRadius: 0.75,
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color:
              status.color === 'warning'
                ? '#9A6B00'
                : status.color === 'success'
                ? '#1B5E20'
                : status.color === 'error'
                ? '#9A1F1F'
                : 'text.secondary',
            bgcolor:
              status.color === 'warning'
                ? 'rgba(255,193,7,0.12)'
                : status.color === 'success'
                ? 'rgba(76,175,80,0.12)'
                : status.color === 'error'
                ? 'rgba(244,67,54,0.12)'
                : 'rgba(0,0,0,0.06)',
          }}
        >
          {status.label}
        </Box>
        {req.status === 'pending' && (
          <Button
            size="small"
            variant="text"
            color="inherit"
            disabled={cancelling}
            onClick={handleCancel}
            sx={{ minWidth: 0, color: 'text.secondary' }}
          >
            Cancel
          </Button>
        )}
      </Stack>
      {error && (
        <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.5 }}>
          {error}
        </Typography>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------
// Attachment tile — image thumbnail or file card. Click opens the
// authenticated download URL in a new tab. The download endpoint
// supports `?preview=true` for inline disposition; we use that for
// images so they render directly in the new tab rather than triggering
// a save dialog.
// ---------------------------------------------------------------------

function AttachmentTile({ attachment }: { attachment: ApiRecordRowAttachment }) {
  const isImage = (attachment.mime_type || '').toLowerCase().startsWith('image/');
  const url = recordsApi.attachments.downloadUrl(attachment.id, { preview: isImage });
  return (
    <Box
      component="a"
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      sx={{
        textDecoration: 'none',
        display: 'flex',
        flexDirection: 'column',
        gap: 0.5,
        width: 96,
      }}
      title={attachment.file_name}
    >
      {isImage ? (
        <Box
          component="img"
          src={url}
          alt={attachment.file_name}
          sx={{
            width: 96,
            height: 96,
            objectFit: 'cover',
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
          }}
        />
      ) : (
        <Box
          sx={{
            width: 96,
            height: 96,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 1,
            border: 1,
            borderColor: 'divider',
            bgcolor: 'background.default',
            color: 'text.secondary',
          }}
        >
          <AttachIcon sx={{ fontSize: 36 }} />
        </Box>
      )}
      <Typography
        sx={{
          fontSize: 11,
          color: 'text.secondary',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          textAlign: 'center',
        }}
      >
        {attachment.file_name}
      </Typography>
    </Box>
  );
}
