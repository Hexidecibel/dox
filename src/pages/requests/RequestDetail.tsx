/**
 * One request — what was asked, who it went to, and where each line stands.
 *
 * THE TWO OPERATIONS THIS SCREEN MUST NOT BLUR
 * --------------------------------------------
 * Amend and re-issue are different things and they get different buttons,
 * different dialogs and different words, never one control with a mode:
 *
 *   Amend      the SAME ask, next version. The version the supplier holds is
 *              preserved and stamped superseded; the new one goes out
 *              immediately, and per-line progress carries across so a document
 *              already under review is not re-chased.
 *   Re-issue   a NEW ask on its own root at version 1, landing as a DRAFT with
 *              progress reset. Last year's certificate is not this year's.
 *
 * A DRAFT IS EDITED IN PLACE; AN ISSUED REQUEST IS NOT. That is not a UI
 * preference — the API returns 409 for a PUT, a line add or a line removal
 * after issue — so the edit affordances simply are not rendered once a request
 * is issued, rather than being rendered and then failing.
 *
 * WHAT `closure` IS, AND WHAT IT IS NOT
 * ------------------------------------
 * Each typed line carries the CONFIRMED `document_requirements` rows from this
 * supplier's active documents for that requirement. It is the registry showing
 * its work — the same join gap detection uses — and it is read-only. It does
 * NOT move the line's status, and this page says so out loud, because a
 * document that satisfies a requirement is not the same statement as a person
 * accepting it against THIS ask.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  Send as SendIcon,
  EditNote as AmendIcon,
  Replay as ReissueIcon,
  BookmarkAdd as TemplateIcon,
  Visibility as PreviewIcon,
  Delete as DeleteIcon,
  Save as SaveIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import type {
  ApiRequirement,
  ApiSupplier,
  DocumentRequestDetail,
  RequestLineStatus,
  RequestLineWithClosure,
  SupplierRequestView,
  User,
} from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import {
  RequestLineComposer,
  diffLineDrafts,
  draftsFromLines,
  type RequestLineDraft,
  type RequirementOption,
} from '../../components/RequestLineComposer';
import { AmendRequestDialog } from '../../components/AmendRequestDialog';
import { ReissueRequestDialog } from '../../components/ReissueRequestDialog';
import { IssueRequestDialog } from '../../components/IssueRequestDialog';
import { SaveAsTemplateDialog } from '../../components/SaveAsTemplateDialog';

const STATUS_LABEL: Record<RequestLineStatus, string> = {
  not_started: 'Not started',
  received: 'Received',
  under_review: 'Under review',
  accepted: 'Accepted',
  needs_attention: 'Needs attention',
};

const STATUS_COLOR: Record<
  RequestLineStatus,
  'default' | 'primary' | 'info' | 'success' | 'error'
> = {
  not_started: 'default',
  received: 'primary',
  under_review: 'info',
  accepted: 'success',
  needs_attention: 'error',
};

/** One fact, label above value. Used for the header panel. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ minWidth: 150, pr: 3, mb: 1 }}>
      <Typography variant="caption" color="text.secondary" display="block">
        {label}
      </Typography>
      <Typography variant="body2" component="div">
        {children}
      </Typography>
    </Box>
  );
}

export function RequestDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  const canCompose = user?.role === 'super_admin' || user?.role === 'org_admin';
  const canWorkLines = canCompose || user?.role === 'user';

  const [request, setRequest] = useState<DocumentRequestDetail | null>(null);
  const [requirements, setRequirements] = useState<ApiRequirement[]>([]);
  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [editingLines, setEditingLines] = useState(false);
  const [drafts, setDrafts] = useState<RequestLineDraft[]>([]);

  const [issueOpen, setIssueOpen] = useState(false);
  const [amendOpen, setAmendOpen] = useState(false);
  const [reissueOpen, setReissueOpen] = useState(false);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [preview, setPreview] = useState<SupplierRequestView | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.documentRequests.get(id);
      setRequest(res.request);
      setDrafts(draftsFromLines(res.request.lines));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load this request');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!canCompose) return;
    Promise.all([
      api.requirements.list({ tenant_id: tenantId, active: 1, limit: 500 }),
      api.suppliers.list({ tenant_id: tenantId, active: 1, limit: 500 }),
      api.users.list().catch(() => [] as User[]),
    ])
      .then(([reqs, sups, us]) => {
        setRequirements(reqs.requirements);
        setSuppliers(sups.suppliers);
        setUsers(us);
      })
      .catch(() => {
        // The detail view still reads fine without the compose vocabularies;
        // the dialogs that need them are admin-only anyway.
      });
  }, [canCompose, tenantId]);

  const vocab: RequirementOption[] = useMemo(
    () =>
      requirements.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        checklist: r.checklist,
        sort_order: r.sort_order,
      })),
    [requirements],
  );

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!request) {
    return (
      <Box>
        <Button startIcon={<BackIcon />} onClick={() => navigate('/requests')} color="inherit">
          All requests
        </Button>
        <Alert severity="error" sx={{ mt: 2 }}>
          {error || 'Request not found'}
        </Alert>
      </Box>
    );
  }

  const isDraft = request.status === 'draft';
  const isIssued = request.status === 'issued';
  const superseded = Boolean(request.superseded_at);
  const current = request.history.find((h) => h.is_current);

  const saveLines = async () => {
    setBusy(true);
    setError('');
    try {
      const diff = diffLineDrafts(request.lines, drafts);
      for (const lineId of diff.remove) await api.requestLines.remove(lineId);
      for (const u of diff.update) await api.requestLines.update(u.id, u.patch);
      if (diff.add.length > 0) await api.documentRequests.addLines(request.id, diff.add);
      setEditingLines(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the lines');
    } finally {
      setBusy(false);
    }
  };

  const setLineStatus = async (line: RequestLineWithClosure, status: RequestLineStatus) => {
    setBusy(true);
    try {
      await api.requestLines.update(line.id, { status });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update the line');
    } finally {
      setBusy(false);
    }
  };

  const setLineNote = async (line: RequestLineWithClosure, note: string) => {
    if ((line.status_note ?? '') === note) return;
    setBusy(true);
    try {
      await api.requestLines.update(line.id, { status_note: note || null });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the note');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box>
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/requests')}
        color="inherit"
        sx={{ mb: 1 }}
      >
        All requests
      </Button>

      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 2 }}>
        <Box sx={{ flexGrow: 1 }}>
          <Typography variant="h4" fontWeight={700}>
            {request.title}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
            <Chip size="small" label={request.status} />
            <Chip size="small" variant="outlined" label={`Version ${request.version}`} />
            {superseded && <Chip size="small" color="warning" label="Superseded" />}
            <Typography variant="body2" color="text.secondary">
              {request.supplier_name ?? 'Unknown supplier'}
            </Typography>
          </Stack>
        </Box>

        <Stack direction="row" spacing={1} flexWrap="wrap">
          {canCompose && isDraft && (
            <Button
              variant="contained"
              startIcon={<SendIcon />}
              onClick={() => setIssueOpen(true)}
              disabled={request.counts.total === 0}
            >
              Issue
            </Button>
          )}
          {canCompose && isIssued && !superseded && (
            <Button variant="contained" startIcon={<AmendIcon />} onClick={() => setAmendOpen(true)}>
              Amend
            </Button>
          )}
          {canCompose && !isDraft && (
            <Button variant="outlined" startIcon={<ReissueIcon />} onClick={() => setReissueOpen(true)}>
              Re-issue
            </Button>
          )}
          {canCompose && request.counts.total > 0 && (
            <Button variant="outlined" startIcon={<TemplateIcon />} onClick={() => setTemplateOpen(true)}>
              Save as template
            </Button>
          )}
          {isIssued && !superseded && (
            <Tooltip title="The server's own projection — exactly the fields a supplier may see, and nothing else.">
              <Button
                variant="outlined"
                startIcon={<PreviewIcon />}
                onClick={async () => {
                  try {
                    const res = await api.documentRequests.external(request.id);
                    setPreview(res.view);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Could not build the preview');
                  }
                }}
              >
                What they see
              </Button>
            </Tooltip>
          )}
          {canCompose && (isDraft || isIssued) && (
            <Button color="error" startIcon={<DeleteIcon />} onClick={() => setCancelOpen(true)}>
              {isDraft ? 'Delete draft' : 'Cancel request'}
            </Button>
          )}
        </Stack>
      </Box>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {superseded && current && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>This version was amended</AlertTitle>
          It was superseded on {request.superseded_at} and is kept as the record of what the
          supplier was holding at the time. The version they hold now is{' '}
          <Link component="button" onClick={() => navigate(`/requests/${current.id}`)}>
            version {current.version}
          </Link>
          .
        </Alert>
      )}

      {isDraft && (
        <Alert severity="info" sx={{ mb: 2 }}>
          <AlertTitle>Nobody has this yet</AlertTitle>
          A draft is editable in place and has been committed to no one. Once you issue it,
          changing what it asks for means amending — which sends a new version and keeps this
          one on the record.
        </Alert>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Who, when, how.                                                     */}
      {/* ------------------------------------------------------------------ */}
      <Paper variant="outlined" sx={{ p: 2, mb: 2, display: 'flex', flexWrap: 'wrap' }}>
        <Fact label="Supplier">{request.supplier_name ?? '—'}</Fact>
        <Fact label="Deadline">{request.due_date ?? 'None set'}</Fact>
        <Fact label="Chased by">{request.assigned_to_name ?? 'Nobody'}</Fact>
        <Fact label="Issued">{request.issued_at ?? 'Not yet'}</Fact>
        <Fact label="Sent via">{request.routing?.channel ?? '—'}</Fact>
        <Fact label="Recipient">{request.routing?.recipient ?? '—'}</Fact>
        <Fact label="Composed from">{request.origin}</Fact>
        <Fact label="Lines">
          {request.counts.total} ({request.counts.required} required,{' '}
          {request.counts.recommended} recommended)
          {request.counts.free_text > 0 && (
            <Box component="span" sx={{ color: 'warning.main', fontWeight: 700 }}>
              {' '}
              · {request.counts.free_text} free text
            </Box>
          )}
        </Fact>
        {request.routing?.internal_notes && (
          <Box sx={{ width: '100%', mt: 1 }}>
            <Typography variant="caption" color="text.secondary" display="block">
              Internal note (never sent)
            </Typography>
            <Typography variant="body2">{request.routing.internal_notes}</Typography>
          </Box>
        )}
        {request.amendment_reason && (
          <Box sx={{ width: '100%', mt: 1 }}>
            <Typography variant="caption" color="text.secondary" display="block">
              Why this version exists
            </Typography>
            <Typography variant="body2">{request.amendment_reason}</Typography>
          </Box>
        )}
      </Paper>

      {request.intro && (
        <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
          <Typography variant="caption" color="text.secondary" display="block">
            Introduction (the supplier reads this)
          </Typography>
          <Typography variant="body2">{request.intro}</Typography>
        </Paper>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* The lines.                                                          */}
      {/* ------------------------------------------------------------------ */}
      <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
        <Typography variant="h6" fontWeight={700} sx={{ flexGrow: 1 }}>
          What it asks for
        </Typography>
        {canCompose && isDraft && !editingLines && (
          <Button size="small" onClick={() => setEditingLines(true)}>
            Edit lines
          </Button>
        )}
        {editingLines && (
          <Stack direction="row" spacing={1}>
            <Button
              size="small"
              color="inherit"
              onClick={() => {
                setDrafts(draftsFromLines(request.lines));
                setEditingLines(false);
              }}
            >
              Discard changes
            </Button>
            <Button size="small" variant="contained" startIcon={<SaveIcon />} onClick={saveLines} disabled={busy}>
              Save lines
            </Button>
          </Stack>
        )}
      </Box>

      {editingLines ? (
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <RequestLineComposer
            vocab={vocab}
            value={drafts}
            onChange={setDrafts}
            disabled={busy}
            emptyMessage={
              <>
                No requirements are configured for this tenant. Add them under{' '}
                <strong>Settings → Requirements</strong>.
              </>
            }
          />
        </Paper>
      ) : request.lines.length === 0 ? (
        <Alert severity="warning" sx={{ mb: 3 }}>
          This request asks for nothing yet. It cannot be issued until it does.
        </Alert>
      ) : (
        <Stack spacing={1} sx={{ mb: 3 }}>
          {request.lines.map((line) => {
            const free = line.line_kind === 'free_text';
            return (
              <Paper
                key={line.id}
                variant="outlined"
                sx={{ p: 2, borderColor: free ? 'warning.main' : undefined }}
              >
                <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                  <Box sx={{ flexGrow: 1, minWidth: 260 }}>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                      <Typography variant="body1" fontWeight={700}>
                        {line.name}
                      </Typography>
                      <Chip
                        size="small"
                        variant="outlined"
                        label={line.tier}
                        color={line.tier === 'required' ? 'primary' : 'default'}
                      />
                      {free && <Chip size="small" color="warning" label="Free text" />}
                    </Stack>

                    {line.requirement_name && line.requirement_name !== line.name && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        Your checklist calls this “{line.requirement_name}”
                        {line.requirement_checklist ? ` (${line.requirement_checklist})` : ''}
                      </Typography>
                    )}
                    {line.explanation && (
                      <Typography variant="body2" sx={{ mt: 0.5 }}>
                        {line.explanation}
                      </Typography>
                    )}
                    {line.acceptable_formats && (
                      <Typography variant="body2" color="text.secondary">
                        <strong>Accepted:</strong> {line.acceptable_formats}
                      </Typography>
                    )}
                    {line.criteria && (
                      <Typography variant="body2" color="text.secondary">
                        <strong>We check:</strong> {line.criteria}
                      </Typography>
                    )}
                    {line.owner && (
                      <Typography variant="caption" color="text.secondary" display="block">
                        Owner: {line.owner}
                      </Typography>
                    )}

                    {free ? (
                      <Typography variant="caption" color="warning.main" display="block" sx={{ mt: 1 }}>
                        Free text — no arriving document can close this line, and it is never
                        counted as missing.
                      </Typography>
                    ) : line.closure.length > 0 ? (
                      <Box sx={{ mt: 1 }}>
                        <Typography variant="caption" color="success.main" display="block">
                          {line.closure.length} confirmed document
                          {line.closure.length === 1 ? '' : 's'} from this supplier already
                          satisfy this requirement — your call whether {line.closure.length === 1 ? 'it closes' : 'they close'} this ask.
                        </Typography>
                        <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 0.5 }}>
                          {line.closure.map((c) => (
                            <Chip
                              key={c.document_id}
                              size="small"
                              variant="outlined"
                              label={c.document_title}
                              onClick={() => navigate(`/documents/${c.document_id}`)}
                            />
                          ))}
                        </Stack>
                      </Box>
                    ) : (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
                        Nothing confirmed from this supplier satisfies this yet.
                      </Typography>
                    )}
                  </Box>

                  <Box sx={{ minWidth: 240 }}>
                    {canWorkLines && !isDraft ? (
                      <>
                        <TextField
                          select
                          size="small"
                          fullWidth
                          label="Status"
                          value={line.status}
                          disabled={busy}
                          onChange={(e) =>
                            setLineStatus(line, e.target.value as RequestLineStatus)
                          }
                        >
                          {(Object.keys(STATUS_LABEL) as RequestLineStatus[]).map((s) => (
                            <MenuItem key={s} value={s}>
                              {STATUS_LABEL[s]}
                            </MenuItem>
                          ))}
                        </TextField>
                        <TextField
                          size="small"
                          fullWidth
                          label="Note"
                          defaultValue={line.status_note ?? ''}
                          disabled={busy}
                          sx={{ mt: 1 }}
                          onBlur={(e) => setLineNote(line, e.target.value.trim())}
                          helperText="Internal. Why it is where it is."
                        />
                      </>
                    ) : (
                      <Chip
                        size="small"
                        color={STATUS_COLOR[line.status]}
                        label={STATUS_LABEL[line.status]}
                      />
                    )}
                    {line.status_changed_at && (
                      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                        Last moved {line.status_changed_at}
                      </Typography>
                    )}
                  </Box>
                </Box>
              </Paper>
            );
          })}
        </Stack>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* The amendment trail.                                                */}
      {/* ------------------------------------------------------------------ */}
      {request.history.length > 1 && (
        <>
          <Typography variant="h6" fontWeight={700} sx={{ mb: 1 }}>
            Versions
          </Typography>
          <Paper variant="outlined" sx={{ p: 2, mb: 4 }}>
            {request.history.map((h, i) => (
              <Box key={h.id}>
                {i > 0 && <Divider sx={{ my: 1 }} />}
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <Typography variant="body2" fontWeight={700} sx={{ minWidth: 90 }}>
                    Version {h.version}
                  </Typography>
                  {h.is_current && <Chip size="small" color="primary" label="Current" />}
                  <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
                    {h.line_count} line{h.line_count === 1 ? '' : 's'}
                    {h.issued_at ? ` · issued ${h.issued_at}` : ' · not issued'}
                    {h.due_date ? ` · due ${h.due_date}` : ''}
                  </Typography>
                  {h.id !== request.id && (
                    <Button size="small" onClick={() => navigate(`/requests/${h.id}`)}>
                      View
                    </Button>
                  )}
                </Box>
                {h.amendment_reason && (
                  <Typography variant="caption" color="text.secondary" display="block">
                    {h.amendment_reason}
                  </Typography>
                )}
              </Box>
            ))}
          </Paper>
        </>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Dialogs.                                                            */}
      {/* ------------------------------------------------------------------ */}
      <IssueRequestDialog
        open={issueOpen}
        request={request}
        onClose={() => setIssueOpen(false)}
        onSubmit={async (body) => {
          await api.documentRequests.issue(request.id, body);
          setIssueOpen(false);
          await load();
        }}
      />

      {amendOpen && (
        <AmendRequestDialog
          open
          request={request}
          vocab={vocab}
          assignees={users.map((u) => ({ id: u.id, name: u.name }))}
          onClose={() => setAmendOpen(false)}
          onSubmit={async (body) => {
            const res = await api.documentRequests.amend(request.id, body);
            setAmendOpen(false);
            navigate(`/requests/${res.request.id}`);
          }}
        />
      )}

      {reissueOpen && (
        <ReissueRequestDialog
          open
          request={request}
          suppliers={suppliers.map((s) => ({ id: s.id, name: s.name }))}
          assignees={users.map((u) => ({ id: u.id, name: u.name }))}
          onClose={() => setReissueOpen(false)}
          onSubmit={async (body) => {
            const res = await api.documentRequests.reissue(request.id, body);
            setReissueOpen(false);
            navigate(`/requests/${res.request.id}`);
          }}
        />
      )}

      <SaveAsTemplateDialog
        open={templateOpen}
        defaultName={request.title}
        lineCount={request.counts.total}
        onClose={() => setTemplateOpen(false)}
        onSubmit={async (body) => {
          await api.requestTemplates.create({
            ...body,
            from_request_id: request.id,
            tenant_id: isSuperAdmin ? tenantId : undefined,
          });
          setTemplateOpen(false);
          navigate('/requests/templates');
        }}
      />

      {/* The supplier's own view, straight from the server's allow-list. */}
      <Dialog open={Boolean(preview)} onClose={() => setPreview(null)} maxWidth="sm" fullWidth>
        <DialogTitle>What the supplier sees</DialogTitle>
        <DialogContent dividers>
          <Alert severity="info" sx={{ mb: 2 }}>
            This is the server's own projection, field by field. Your buyer, your internal
            notes, our line statuses and every internal id are not in it.
          </Alert>
          {preview && (
            <>
              <Typography variant="h6">{preview.title}</Typography>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
                From {preview.tenant_name}
                {preview.due_date ? ` · due ${preview.due_date}` : ''}
                {preview.amended ? ' · replaces an earlier version' : ''}
              </Typography>
              {preview.intro && <Typography variant="body2" sx={{ mb: 2 }}>{preview.intro}</Typography>}
              {preview.items.map((item, i) => (
                <Box key={`${item.name}-${i}`} sx={{ mb: 1.5 }}>
                  <Typography variant="body2" fontWeight={700}>
                    {item.name} <Chip size="small" variant="outlined" label={item.tier} />
                  </Typography>
                  {item.explanation && <Typography variant="body2">{item.explanation}</Typography>}
                  {item.acceptable_formats && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      Accepted: {item.acceptable_formats}
                    </Typography>
                  )}
                  {item.criteria && (
                    <Typography variant="caption" color="text.secondary" display="block">
                      Checked against: {item.criteria}
                    </Typography>
                  )}
                </Box>
              ))}
            </>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPreview(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={cancelOpen} onClose={() => setCancelOpen(false)}>
        <DialogTitle>{isDraft ? 'Delete this draft?' : 'Cancel this request?'}</DialogTitle>
        <DialogContent>
          <DialogContentText>
            {isDraft
              ? 'It was committed to nobody, so it is deleted outright — there is no tombstone to explain later.'
              : 'It went out, so the record that it went out and that we withdrew it is kept. The supplier is not notified from here.'}
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelOpen(false)} color="inherit">
            Keep it
          </Button>
          <Button
            color="error"
            variant="contained"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await api.documentRequests.cancel(request.id);
                setCancelOpen(false);
                if (res.deleted) navigate('/requests');
                else await load();
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed');
              } finally {
                setBusy(false);
              }
            }}
          >
            {isDraft ? 'Delete' : 'Cancel request'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
