/**
 * OwnerRoutingPanel — "who gets told what", as sentences.
 *
 * Written for the QA lead, on the model of `src/pages/admin/ClaimRules.tsx`:
 * the configuration reads as a list of statements ("Insurance → alerts go to
 * broker@agency.example"), and the UNCONFIGURED rows sort to the top and are
 * flagged rather than left to blend in.
 *
 * THE LABELS ARE NOT TYPED FROM MEMORY. `documents.owner` is free text holding
 * a role — QA, Accounting, Insurance, Purchasing — so the labels that exist are
 * only discoverable from the documents. The list endpoint returns them
 * (`labels_in_use`, see functions/api/owner-routes/index.ts) and this panel
 * leads with that list. A screen that opened on an empty text box would get the
 * labels somebody happened to remember, and every label they forgot would stay
 * silently unrouted — which is the exact failure the panel is here to expose.
 *
 * A LABEL WITH NO ROUTE IS THE IMPORTANT STATE. Renewal alerts pass
 * `adminFallback: false` (see functions/lib/alert-routing.ts), so an unrouted
 * label does not quietly reach the admin pool: every renewal record carrying it
 * is reported as a routing gap and nobody is told. That row is rendered in
 * warning colours with its document and renewal counts attached, because "3
 * documents, none due" and "40 documents, 12 due" are different sizes of the
 * same problem.
 *
 * A RECIPIENT DOES NOT NEED AN ACCOUNT. Both choices — a portal user and a bare
 * address — are visible side by side in the add dialog, not one hidden behind
 * the other. The broker and the site manager are the common case and will never
 * have logins; making that discoverable is cheaper than answering the question.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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
  DialogTitle,
  FormControl,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Radio,
  RadioGroup,
  Select,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  Add as AddIcon,
  ArrowForward as ArrowIcon,
  Delete as DeleteIcon,
  MailOutline as MailIcon,
  PersonOutline as PersonIcon,
} from '@mui/icons-material';
import { api } from '../lib/api';
import type { OwnerLabelInUse, OwnerRoute, User } from '../lib/types';

/**
 * The same fold the server matches on — `normalizeOwnerKey` in
 * functions/lib/alert-routing.ts. Restated rather than imported because that
 * module is a Pages Function and pulling it into the bundle would drag D1 types
 * in with it. The rule is two lines and pinned by the panel's own test; the
 * server remains authoritative, since it re-normalizes every label it stores.
 */
function normalizeOwnerKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** One owner label as the panel renders it: the label, who it reaches, and why it matters. */
export interface OwnerLabelRow {
  owner_key: string;
  owner_label: string;
  /** Distinct spellings on documents that fold onto this key. */
  spellings: string[];
  document_count: number;
  renewal_count: number;
  routes: OwnerRoute[];
  /** On documents, but nobody is reachable. The state that matters. */
  unrouted: boolean;
  /** Routed, but no document carries the label. Configured and idle — not a fault. */
  unused: boolean;
  /**
   * Proposed by a starter pack rather than discovered on a document. A fresh
   * tenant has no documents at all, so without this the setup wizard's routing
   * screen would open on "no owner labels yet" and route nothing — the pack
   * already knows which departments own which certificates.
   */
  proposed: boolean;
  /** One sentence saying what routing this label actually buys. */
  note?: string;
}

/** A department a starter pack proposes, with the sentence to show beside it. */
export interface ProposedOwnerLabel {
  owner_label: string;
  note?: string;
}

/**
 * Fold the in-use labels and the configured routes into one list.
 *
 * Both directions matter and neither list alone is the answer:
 *   - a label on documents with no route  -> nobody is alerted (a gap)
 *   - a route for a label no document uses -> harmless, but worth showing so a
 *     typo'd label ('Purchsing') is visible next to the real one
 *
 * Sorting puts the gaps first, biggest first, because that is the work queue.
 */
export function mergeOwnerLabels(
  routes: OwnerRoute[],
  labelsInUse: OwnerLabelInUse[],
  proposed: ProposedOwnerLabel[] = [],
): OwnerLabelRow[] {
  const byKey = new Map<string, OwnerLabelRow>();

  // Proposals go in FIRST so a label that is also on documents overwrites the
  // placeholder counts with the real ones and keeps its sentence.
  for (const p of proposed) {
    const key = normalizeOwnerKey(p.owner_label);
    if (!key) continue;
    byKey.set(key, {
      owner_key: key,
      owner_label: p.owner_label,
      spellings: [],
      document_count: 0,
      renewal_count: 0,
      routes: [],
      unrouted: true,
      unused: false,
      proposed: true,
      note: p.note,
    });
  }

  for (const label of labelsInUse) {
    const existing = byKey.get(label.owner_key);
    byKey.set(label.owner_key, {
      owner_key: label.owner_key,
      owner_label: label.owner_label,
      spellings: label.spellings,
      document_count: label.document_count,
      renewal_count: label.renewal_count,
      routes: [],
      unrouted: true,
      unused: false,
      proposed: existing?.proposed ?? false,
      note: existing?.note,
    });
  }

  for (const route of routes) {
    const existing = byKey.get(route.owner_key);
    if (existing) {
      existing.routes.push(route);
      // An inactive route reaches nobody, so it does not clear the gap.
      if (route.active) existing.unrouted = false;
    } else {
      byKey.set(route.owner_key, {
        owner_key: route.owner_key,
        owner_label: route.owner_label,
        spellings: [],
        document_count: 0,
        renewal_count: 0,
        routes: [route],
        unrouted: false,
        unused: true,
        proposed: false,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.unrouted !== b.unrouted) return a.unrouted ? -1 : 1;
    if (a.unused !== b.unused) return a.unused ? 1 : -1;
    if (a.renewal_count !== b.renewal_count) return b.renewal_count - a.renewal_count;
    if (a.document_count !== b.document_count) return b.document_count - a.document_count;
    return a.owner_label.localeCompare(b.owner_label);
  });
}

/** The address a route actually resolves to, for display. */
export function routeRecipient(route: OwnerRoute): { name: string; email: string; isUser: boolean } {
  if (route.user_id) {
    return {
      name: route.user_name || route.user_email || 'portal user',
      email: route.user_email || '',
      isUser: true,
    };
  }
  return { name: route.email || '', email: route.email || '', isUser: false };
}

interface AddDialogState {
  open: boolean;
  /** Pre-filled when adding to an existing label; blank when adding a new one. */
  ownerLabel: string;
  lockLabel: boolean;
}

export interface OwnerRoutingPanelProps {
  /** super_admin acting inside a chosen tenant. */
  tenantId?: string;
  /**
   * Drop the "X of Y labels have somebody behind them" header. The setup
   * wizard embeds this panel under its own heading and progress, and two
   * progress bars stacked on one screen read as two different measurements.
   */
  hideSummary?: boolean;
  /**
   * Departments a starter pack proposes. Shown as rows even when no document
   * carries the label yet, each with its own sentence.
   */
  proposedLabels?: ProposedOwnerLabel[];
}

export default function OwnerRoutingPanel({
  tenantId,
  hideSummary = false,
  proposedLabels,
}: OwnerRoutingPanelProps) {
  const [routes, setRoutes] = useState<OwnerRoute[]>([]);
  const [labelsInUse, setLabelsInUse] = useState<OwnerLabelInUse[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [dialog, setDialog] = useState<AddDialogState>({
    open: false,
    ownerLabel: '',
    lockLabel: false,
  });
  const [kind, setKind] = useState<'user' | 'email'>('user');
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.ownerRoutes.list({ tenantId });
      setRoutes(res.routes);
      setLabelsInUse(res.labels_in_use ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load owner routes');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    load();
    // The user list is a separate, non-fatal concern: a bare email works
    // without it, so a failure here must not block the panel.
    api.users
      .list()
      .then((list) => setUsers(list.filter((u) => u.active !== 0 && !!u.email)))
      .catch(() => setUsers([]));
  }, [load]);

  const rows = useMemo(
    () => mergeOwnerLabels(routes, labelsInUse, proposedLabels ?? []),
    [routes, labelsInUse, proposedLabels],
  );

  const inUse = rows.filter((r) => !r.unused);
  const gaps = inUse.filter((r) => r.unrouted);
  const routed = inUse.length - gaps.length;
  const pct = inUse.length ? Math.round((routed / inUse.length) * 100) : 0;
  const unroutedRenewals = gaps.reduce((n, r) => n + r.renewal_count, 0);

  const openAdd = (ownerLabel: string, lockLabel: boolean) => {
    setDialog({ open: true, ownerLabel, lockLabel });
    setKind('user');
    setUserId('');
    setEmail('');
    setError('');
  };

  const submit = async () => {
    const label = dialog.ownerLabel.trim();
    if (!label) return;
    if (kind === 'user' && !userId) return;
    if (kind === 'email' && !email.trim()) return;
    setSaving(true);
    setError('');
    try {
      await api.ownerRoutes.create({
        ownerLabel: label,
        userId: kind === 'user' ? userId : undefined,
        email: kind === 'email' ? email.trim() : undefined,
        tenantId,
      });
      setDialog({ open: false, ownerLabel: '', lockLabel: false });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add recipient');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (route: OwnerRoute) => {
    setBusyId(route.id);
    setError('');
    try {
      await api.ownerRoutes.remove(route.id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove recipient');
    } finally {
      setBusyId(null);
    }
  };

  if (loading && rows.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {!hideSummary && (
      <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="body2" fontWeight={600}>
            {routed} of {inUse.length} owner labels on your documents have somebody behind them
          </Typography>
          <Button size="small" startIcon={<AddIcon />} onClick={() => openAdd('', false)}>
            Add a label
          </Button>
        </Box>
        <LinearProgress variant="determinate" value={pct} />
        {gaps.length > 0 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Labels with nobody behind them are listed first. Renewal alerts do{' '}
            <strong>not</strong> fall back to the admin pool, so until a label has a recipient
            every record carrying it is reported as unowned and nobody is emailed
            {unroutedRenewals > 0
              ? ` — that is ${unroutedRenewals} record${unroutedRenewals === 1 ? '' : 's'} with renewal terms right now.`
              : '.'}
          </Typography>
        )}
      </Paper>
      )}

      {rows.length === 0 ? (
        <Alert severity="info">
          <AlertTitle>No owner labels yet</AlertTitle>
          No document in this tenant names an owner, and no routes are configured. Set{' '}
          <strong>Owner</strong> on a document (QA, Accounting, Insurance, Purchasing…) and the
          label will appear here to be routed — or add one ahead of time.
        </Alert>
      ) : (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {rows.map((row) => (
            <Paper
              key={row.owner_key}
              variant="outlined"
              sx={{
                p: 2,
                display: 'flex',
                alignItems: 'center',
                gap: 1.5,
                flexWrap: 'wrap',
                borderColor: row.unrouted ? 'warning.main' : undefined,
              }}
            >
              <Box sx={{ minWidth: 180 }}>
                <Typography variant="body1" fontWeight={700}>
                  {row.owner_label}
                </Typography>
                {row.proposed && row.document_count === 0 ? (
                  <Typography variant="caption" color="text.secondary">
                    proposed by the starter pack
                  </Typography>
                ) : row.unused ? (
                  <Typography variant="caption" color="text.secondary">
                    no documents use this label
                  </Typography>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    {row.document_count} document{row.document_count === 1 ? '' : 's'}
                    {row.renewal_count > 0 ? `, ${row.renewal_count} with renewal terms` : ''}
                  </Typography>
                )}
                {row.spellings.length > 1 && (
                  <Tooltip
                    title={`Spelled ${row.spellings.join(', ')} on documents. They route together.`}
                  >
                    <Chip
                      size="small"
                      variant="outlined"
                      label={`${row.spellings.length} spellings`}
                      sx={{ mt: 0.5 }}
                    />
                  </Tooltip>
                )}
              </Box>

              <ArrowIcon fontSize="small" color="disabled" />

              <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                {row.note && (
                  <Typography variant="body2" color="text.secondary">
                    {row.note}
                  </Typography>
                )}
                {row.unrouted ? (
                  <Typography variant="body2" color="warning.main" fontWeight={600}>
                    Nobody is routed — records with this owner are reported as unowned and no
                    alert is sent
                  </Typography>
                ) : (
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'wrap' }}>
                    <Typography variant="body2" color="text.secondary">
                      alerts go to
                    </Typography>
                    {row.routes.map((route) => {
                      const who = routeRecipient(route);
                      return (
                        <Chip
                          key={route.id}
                          size="small"
                          color={route.active ? 'primary' : 'default'}
                          variant={route.active ? 'filled' : 'outlined'}
                          icon={who.isUser ? <PersonIcon /> : <MailIcon />}
                          label={
                            who.isUser
                              ? who.name
                              : `${who.email} (no portal account)`
                          }
                          onDelete={busyId === route.id ? undefined : () => remove(route)}
                          deleteIcon={<DeleteIcon />}
                        />
                      );
                    })}
                  </Box>
                )}
              </Box>

              <Button
                size="small"
                startIcon={<AddIcon />}
                variant={row.unrouted ? 'contained' : 'outlined'}
                onClick={() => openAdd(row.owner_label, true)}
              >
                {row.unrouted ? 'Set recipient' : 'Add recipient'}
              </Button>
            </Paper>
          ))}
        </Box>
      )}

      <Dialog
        open={dialog.open}
        onClose={() => setDialog({ open: false, ownerLabel: '', lockLabel: false })}
        fullWidth
        maxWidth="sm"
      >
        <DialogTitle>
          {dialog.lockLabel ? `Who receives ${dialog.ownerLabel} alerts?` : 'Add an owner label'}
        </DialogTitle>
        <DialogContent dividers>
          <TextField
            label="Owner label"
            fullWidth
            size="small"
            sx={{ mb: 2, mt: 1 }}
            value={dialog.ownerLabel}
            disabled={dialog.lockLabel}
            onChange={(e) => setDialog((d) => ({ ...d, ownerLabel: e.target.value }))}
            helperText={
              dialog.lockLabel
                ? 'Matches the label on the document, ignoring case and extra spaces.'
                : 'The role as it is written on documents — QA, Accounting, Insurance, Purchasing.'
            }
          />

          <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
            Recipient
          </Typography>
          <RadioGroup value={kind} onChange={(e) => setKind(e.target.value as 'user' | 'email')}>
            <FormControlLabel
              value="user"
              control={<Radio size="small" />}
              label={
                <Typography variant="body2">
                  Somebody with a portal account —{' '}
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    their address follows them if it changes
                  </Box>
                </Typography>
              }
            />
            {kind === 'user' && (
              <FormControl fullWidth size="small" sx={{ mb: 1, ml: 4, width: 'auto' }}>
                <Select
                  value={userId}
                  displayEmpty
                  onChange={(e) => setUserId(e.target.value as string)}
                  inputProps={{ 'aria-label': 'Portal user' }}
                >
                  <MenuItem value="" disabled>
                    Choose a user
                  </MenuItem>
                  {users.map((u) => (
                    <MenuItem key={u.id} value={u.id}>
                      {u.name} — {u.email}
                    </MenuItem>
                  ))}
                </Select>
              </FormControl>
            )}

            <FormControlLabel
              value="email"
              control={<Radio size="small" />}
              label={
                <Typography variant="body2">
                  An email address —{' '}
                  <Box component="span" sx={{ color: 'text.secondary' }}>
                    no account needed, the usual choice for a broker or a site manager
                  </Box>
                </Typography>
              }
            />
            {kind === 'email' && (
              <TextField
                size="small"
                sx={{ ml: 4, mb: 1 }}
                placeholder="broker@agency.example"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                inputProps={{ 'aria-label': 'Email address' }}
              />
            )}
          </RadioGroup>

          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
            A label can have several recipients — add them one at a time and they all receive the
            digest.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDialog({ open: false, ownerLabel: '', lockLabel: false })}>
            Cancel
          </Button>
          <Button
            variant="contained"
            disabled={
              saving ||
              !dialog.ownerLabel.trim() ||
              (kind === 'user' ? !userId : !email.trim())
            }
            onClick={submit}
          >
            {saving ? 'Saving…' : 'Add recipient'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
