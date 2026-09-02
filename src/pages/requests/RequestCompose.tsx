/**
 * Compose a request — the screen a QA manager uses to ask a supplier for
 * documents.
 *
 * SEEDED, NOT BLANK. Picking a supplier immediately asks the gap report
 * (`/api/supplier-gaps?supplier_id=`, shared/requirementGap.ts) what that
 * supplier already owes and has not sent, and ticks exactly those. Composing an
 * ask for a supplier with six open items should not begin by making somebody
 * find those six items again in a checklist they configured months ago. It is
 * one server-computed call, not a client-side join over applicability and
 * documents — that join is the gap engine's job and it already exists.
 *
 * The seed is a STARTING SET, never a decision: every line can be unticked, the
 * whole set cleared, and anything else in the checklist added.
 *
 * THREE DIFFERENT EMPTY ANSWERS, kept apart on purpose — they mean opposite
 * things and collapsing them is the false-clean failure the gap engine exists
 * to prevent:
 *
 *   no checklist configured for this supplier  nothing is KNOWN to be owed.
 *                                              Not the same as owing nothing;
 *                                              rendered as a warning.
 *   nothing outstanding                        they are up to date. Anything
 *                                              composed here is a new ask.
 *   tenant has no requirements at all          there is no vocabulary to ask
 *                                              from yet; the fix is Settings,
 *                                              and the composer says so.
 *
 * It always produces a DRAFT. "Save and issue" composes, then opens the issue
 * dialog — the same single issue path everything else goes through, not a
 * shortcut that writes issued_at from the compose form.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import { ArrowBack as BackIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import type {
  ApiRequirement,
  ApiSupplier,
  DocumentRequestDetail,
  SupplierGap,
  User,
} from '../../lib/types';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import {
  RequestLineComposer,
  draftFromRequirement,
  draftsToLineInputs,
  type RequestLineDraft,
  type RequirementOption,
} from '../../components/RequestLineComposer';
import { IssueRequestDialog } from '../../components/IssueRequestDialog';

export function RequestCompose() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  const [suppliers, setSuppliers] = useState<ApiSupplier[]>([]);
  const [requirements, setRequirements] = useState<ApiRequirement[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [supplierId, setSupplierId] = useState(searchParams.get('supplier_id') ?? '');
  const [gap, setGap] = useState<SupplierGap | null>(null);
  const [gapLoading, setGapLoading] = useState(false);

  const [title, setTitle] = useState('');
  const [intro, setIntro] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [drafts, setDrafts] = useState<RequestLineDraft[]>([]);

  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<DocumentRequestDetail | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [supplierList, reqList, userList] = await Promise.all([
          api.suppliers.list({ tenant_id: tenantId, active: 1, limit: 500 }),
          api.requirements.list({ tenant_id: tenantId, active: 1, limit: 500 }),
          api.users.list().catch(() => [] as User[]),
        ]);
        if (cancelled) return;
        setSuppliers(supplierList.suppliers);
        setRequirements(reqList.requirements);
        setUsers(userList);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

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

  const supplier = suppliers.find((s) => s.id === supplierId) ?? null;

  /**
   * Load the gap and seed from it.
   *
   * `include_recommended` is ON here, unlike the gap dashboard's default: a
   * dashboard counting recommended items would inflate what is "open", but a
   * composer that silently withheld them would make a QA manager re-pick the
   * advisory half of their own checklist by hand.
   */
  const loadGap = useCallback(
    async (id: string) => {
      setGapLoading(true);
      try {
        const res = await api.supplierGaps.list({
          supplier_id: id,
          tenant_id: tenantId,
          include_recommended: true,
        });
        const found = res.gaps[0] ?? null;
        setGap(found);
        if (found && found.open.length > 0) {
          const byId = new Map(vocab.map((v) => [v.id, v]));
          setDrafts(
            found.open
              .filter((o) => byId.has(o.requirement_id))
              .map((o) =>
                draftFromRequirement(byId.get(o.requirement_id)!, {
                  tier: o.tier,
                  seeded: true,
                }),
              ),
          );
        } else {
          setDrafts([]);
        }
      } catch (err) {
        // A gap the server could not compute must not block composing by hand.
        setGap(null);
        setError(err instanceof Error ? err.message : 'Could not load what this supplier owes');
      } finally {
        setGapLoading(false);
      }
    },
    [tenantId, vocab],
  );

  useEffect(() => {
    if (!supplierId || vocab.length === 0) return;
    loadGap(supplierId);
  }, [supplierId, vocab.length, loadGap]);

  useEffect(() => {
    if (supplier && !title) setTitle(`Document request — ${supplier.name}`);
    // Only ever fills a blank title; it never overwrites what somebody typed.
  }, [supplier, title]);

  const outstanding = useMemo(
    () => new Set((gap?.open ?? []).map((o) => o.requirement_id)),
    [gap],
  );

  const compose = async (): Promise<DocumentRequestDetail | null> => {
    if (!supplierId) {
      setError('Pick a supplier first — a request is always addressed to one.');
      return null;
    }
    if (!title.trim()) {
      setError('Give the request a title.');
      return null;
    }
    if (drafts.length === 0) {
      setError('A request has to ask for at least one thing.');
      return null;
    }
    setSaving(true);
    setError('');
    try {
      const res = await api.documentRequests.compose({
        supplier_id: supplierId,
        title: title.trim(),
        intro: intro.trim() || null,
        due_date: dueDate || null,
        assigned_to: assignedTo || null,
        // Provenance only — it selects no code path server-side. 'gap' is
        // honest only while at least one line the gap report put here has
        // survived; clear them all and this is somebody's own composition.
        origin: drafts.some((d) => d.seeded) ? 'gap' : 'manual',
        lines: draftsToLineInputs(drafts),
        tenant_id: isSuperAdmin ? tenantId : undefined,
      });
      return res.request;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save this request');
      return null;
    } finally {
      setSaving(false);
    }
  };

  const saveDraft = async () => {
    const request = await compose();
    if (request) navigate(`/requests/${request.id}`);
  };

  const saveAndIssue = async () => {
    const request = await compose();
    if (request) setCreated(request);
  };

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Button
        startIcon={<BackIcon />}
        onClick={() => navigate('/requests')}
        sx={{ mb: 1 }}
        color="inherit"
      >
        All requests
      </Button>
      <Typography variant="h4" fontWeight={700} sx={{ mb: 2 }}>
        Compose a request
      </Typography>

      <HelpWell id="requests.compose" title="What you are writing">
        Pick the supplier first and the portal fills in what they already owe. Everything you
        tick is an item from your own checklist, so when the document lands it can be matched
        to the ask. Saving gives you a draft; issuing is a separate, deliberate click, and
        after it the request can only be amended.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {requirements.length === 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          <AlertTitle>Your checklist is empty</AlertTitle>
          There are no requirements configured for this tenant, so there is nothing to ask for
          that the portal can track. Add them under <strong>Settings → Requirements</strong>{' '}
          first — a request made entirely of free text cannot be satisfied, chased or counted.
        </Alert>
      )}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Stack spacing={2}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField
              select
              required
              label="Supplier"
              fullWidth
              value={supplierId}
              onChange={(e) => setSupplierId(e.target.value)}
            >
              <MenuItem value="">Pick a supplier…</MenuItem>
              {suppliers.map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.name}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Deadline"
              type="date"
              fullWidth
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
            <TextField
              select
              label="Buyer chasing this"
              fullWidth
              value={assignedTo}
              onChange={(e) => setAssignedTo(e.target.value)}
              helperText="Internal — the supplier never sees who is chasing them."
            >
              <MenuItem value="">Nobody yet</MenuItem>
              {users.map((u) => (
                <MenuItem key={u.id} value={u.id}>
                  {u.name}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
          <TextField
            label="Title"
            required
            fullWidth
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            helperText="The supplier sees this."
          />
          <TextField
            label="Introduction"
            fullWidth
            multiline
            minRows={2}
            value={intro}
            onChange={(e) => setIntro(e.target.value)}
            placeholder="e.g. Ahead of your annual approval review, we need the following on file."
            helperText="Optional. The supplier sees this too."
          />
        </Stack>
      </Paper>

      {/* --------------------------------------------------------------- */}
      {/* What the gap report already knows. Three answers, never merged.  */}
      {/* --------------------------------------------------------------- */}
      {supplierId && gapLoading && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Checking what {supplier?.name ?? 'this supplier'} already owes…
        </Alert>
      )}
      {supplierId && !gapLoading && gap && (
        <>
          {!gap.configured && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <AlertTitle>No checklist is set up for this supplier</AlertTitle>
              Nothing is <em>known</em> to be outstanding for {gap.supplier_name} — which is
              not the same as them owing nothing. Pick what you need below, and set up what
              they owe on the supplier record so it is reported from then on.
            </Alert>
          )}
          {gap.configured && gap.open.length === 0 && (
            <Alert severity="success" sx={{ mb: 2 }}>
              <AlertTitle>Nothing is outstanding for {gap.supplier_name}</AlertTitle>
              Every item on their checklist is closed by a confirmed document. Anything you
              add here is a new ask.
            </Alert>
          )}
          {gap.open.length > 0 && (
            <Alert
              severity="info"
              sx={{ mb: 2 }}
              action={
                <Button color="inherit" size="small" onClick={() => setDrafts([])}>
                  Clear and start empty
                </Button>
              }
            >
              <AlertTitle>
                {gap.open.length} item{gap.open.length === 1 ? '' : 's'} already outstanding —
                added for you
              </AlertTitle>
              These are the checklist items {gap.supplier_name} owes and has not sent. Untick
              anything you are not asking for this time.
            </Alert>
          )}
          {gap.caveats.length > 0 && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              <AlertTitle>Worth knowing before you send this</AlertTitle>
              {gap.caveats.map((c) => (
                <Typography key={c.code} variant="body2">
                  {c.message}
                </Typography>
              ))}
            </Alert>
          )}
        </>
      )}

      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <RequestLineComposer
          vocab={vocab}
          value={drafts}
          onChange={setDrafts}
          outstanding={outstanding}
          disabled={!supplierId}
          emptyMessage={
            <>
              No requirements are configured for this tenant yet. Add them under{' '}
              <strong>Settings → Requirements</strong> — the checklist is what makes an
              arriving document able to close an ask.
            </>
          }
        />
      </Paper>

      <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mb: 4 }}>
        <Button color="inherit" onClick={() => navigate('/requests')} disabled={saving}>
          Cancel
        </Button>
        <Button variant="outlined" onClick={saveDraft} disabled={saving}>
          Save as draft
        </Button>
        <Button variant="contained" onClick={saveAndIssue} disabled={saving}>
          Save and issue…
        </Button>
      </Stack>

      {created && (
        <IssueRequestDialog
          open
          request={created}
          onClose={() => navigate(`/requests/${created.id}`)}
          onSubmit={async (body) => {
            await api.documentRequests.issue(created.id, body);
            navigate(`/requests/${created.id}`);
          }}
        />
      )}
    </Box>
  );
}
