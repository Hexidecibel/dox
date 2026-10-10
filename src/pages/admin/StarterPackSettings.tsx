/**
 * Settings > Starter pack — which pack and version this organisation is on,
 * and the one place a newer version is previewed and rolled forward.
 *
 * THE PREVIEW IS THE SCREEN. Nothing is written until Apply is pressed, and the
 * preview is the server's own dry run (POST /api/starter-packs/roll-forward,
 * `dry_run` default true), so what is on the page is what Apply will do --
 * recomputed at that moment, and guarded so an edit made in between wins.
 *
 * GROUPED BY WHAT HAPPENS, in the order a person needs to read it:
 *   what will change; what is kept because you changed it (both values side by
 *   side, with a tick box to take the pack's instead); what only a person may
 *   change; what is new; what you already had; what collides with something
 *   you have; what you switched off; what is not here at all (and is added
 *   only if you tick it); what the pack no longer has. Nothing is hidden: an item with nothing to say is the only
 *   thing left out, and the counts at the top include it.
 *
 * AN ORGANISATION WITH NO RECORD is told so, in words, rather than shown
 * "version 1": it was set up before pack versions existed, and until it is
 * baselined no update can tell a new item from one it removed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  FormControlLabel,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { HelpWell } from '../../components/HelpWell';
import { api } from '../../lib/api';
import { helpContent } from '../../lib/helpContent';
import type {
  PackAccept,
  PackPlanField,
  PackRollForwardItem,
  PackRollForwardResponse,
  TenantPackStatus,
  TenantPackStatusResponse,
} from '../../lib/types';

/** What a person calls each column a pack writes. */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  default_owner: 'Default owner',
  renewal_policy: 'Renewal',
  renewal_interval_months: 'Renewal period (months)',
  renewal_window: 'Renewal window',
  sharing_rule: 'Sharing rule',
  checklist: 'Group',
  sort_order: 'Order',
  scope: 'Owed per',
  subject_grain: 'Applies to',
  is_required: 'Required',
  notes: 'Notes',
  instructions: 'Reading instructions',
  aliases: 'Printed names',
  default_unit: 'Unit',
  operator: 'Comparison',
  value_min: 'Minimum',
  value_max: 'Maximum',
  unit: 'Unit',
  severity: 'Severity',
  criticality: 'Criticality',
  enabled: 'Switched on',
  owner_label: 'Label',
};

export function fieldLabel(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

/** A stored value as a person reads it. Empty is said, never shown as a blank cell. */
export function showValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '(empty)';
  return String(value);
}

const acceptKey = (a: { kind: string; key: string; field?: string | null }) =>
  `${a.kind}\u0000${a.key}\u0000${a.field ?? ''}`;

function Value({ value }: { value: unknown }) {
  const text = showValue(value);
  return (
    <Typography
      variant="body2"
      title={text}
      sx={{
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 96,
        overflow: 'auto',
        color: text === '(empty)' ? 'text.disabled' : 'text.primary',
      }}
    >
      {text}
    </Typography>
  );
}

interface FieldRow {
  item: PackRollForwardItem;
  field: PackPlanField;
}

function rowsWhere(items: PackRollForwardItem[], action: PackPlanField['action']): FieldRow[] {
  return items.flatMap((item) => item.fields.filter((f) => f.action === action).map((field) => ({ item, field })));
}

function ItemName({ item }: { item: PackRollForwardItem }) {
  return (
    <Box>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {item.label}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {item.noun}
      </Typography>
    </Box>
  );
}

function Group({
  title,
  count,
  blurb,
  children,
  testId,
}: {
  title: string;
  count: number;
  blurb: string;
  children: React.ReactNode;
  testId: string;
}) {
  if (count === 0) return null;
  return (
    <Paper variant="outlined" sx={{ p: 2 }} data-testid={testId}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Chip size="small" label={count} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        {blurb}
      </Typography>
      <Box sx={{ overflowX: 'auto' }}>{children}</Box>
    </Paper>
  );
}

function ItemList({ items, detail }: { items: PackRollForwardItem[]; detail?: (i: PackRollForwardItem) => string | null }) {
  return (
    <Table size="small">
      <TableBody>
        {items.map((item) => (
          <TableRow key={`${item.kind}:${item.key}`}>
            <TableCell sx={{ width: '45%' }}>
              <ItemName item={item} />
            </TableCell>
            <TableCell>
              <Typography variant="body2" color="text.secondary">
                {detail?.(item) ?? ''}
              </Typography>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const GONE_WORDS: Record<string, string> = {
  deleted: 'It was here and was removed. It stays removed.',
  absent: 'It was not here when this organisation was recorded. It is not added.',
};

export function StarterPackSettings() {
  const { user } = useAuth();
  const { selectedTenantId } = useTenant();
  const tenantId = selectedTenantId ?? user?.tenant_id ?? null;

  const [status, setStatus] = useState<TenantPackStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PackRollForwardResponse | null>(null);
  const [applied, setApplied] = useState<PackRollForwardResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [accept, setAccept] = useState<Map<string, PackAccept>>(new Map());

  const load = useCallback(async () => {
    if (!tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    try {
      setStatus(await api.starterPacks.status({ tenantId }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the starter pack');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    setPreview(null);
    setApplied(null);
    setAccept(new Map());
    load();
  }, [load]);

  const runPreview = async (pack: TenantPackStatus) => {
    if (!tenantId) return;
    setBusy(true);
    setError('');
    setApplied(null);
    setAccept(new Map());
    try {
      setPreview(await api.starterPacks.rollForward({ tenantId, pack: pack.pack, dryRun: true }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not preview the update');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!tenantId || !preview) return;
    setBusy(true);
    setError('');
    try {
      const result = await api.starterPacks.rollForward({
        tenantId,
        pack: preview.pack,
        dryRun: false,
        accept: [...accept.values()],
        // The plan that is on the screen. If it has moved since (the pack, or
        // a row somebody edited), the server refuses and says to look again.
        fingerprint: preview.plan_fingerprint,
      });
      setApplied(result);
      setPreview(null);
      setAccept(new Map());
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the update');
    } finally {
      setBusy(false);
    }
  };

  const toggle = (a: PackAccept) => {
    setAccept((prev) => {
      const next = new Map(prev);
      const key = acceptKey(a);
      if (next.has(key)) next.delete(key);
      else next.set(key, a);
      return next;
    });
  };

  const groups = useMemo(() => {
    const items = preview?.items ?? [];
    return {
      updates: rowsWhere(items, 'update'),
      kept: rowsWhere(items, 'keep').filter((r) => r.item.outcome !== 'adopt'),
      needsPerson: rowsWhere(items, 'needs_person'),
      customised: rowsWhere(items, 'customised'),
      inserted: items.filter((i) => i.outcome === 'insert'),
      adopted: items.filter((i) => i.outcome === 'adopt'),
      conflicts: items.filter((i) => i.outcome === 'conflict'),
      waiting: items.filter((i) => i.outcome === 'parent_missing'),
      // Switched off: on its own screen is where it is switched back on.
      inactive: items.filter((i) => i.outcome === 'inactive'),
      // Not there at all: the one group a person may ask to have added.
      gone: items.filter((i) => i.outcome === 'deleted' || i.outcome === 'absent'),
      removed: items.filter((i) => i.outcome === 'removed_from_pack'),
    };
  }, [preview]);

  if (!tenantId) {
    return <Alert severity="info">Choose an organisation to see its starter pack.</Alert>;
  }
  if (loading && !status) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  // "Nothing to write" disables Apply; it does not mean finished (see needs_attention).
  const nothingToApply = preview !== null && preview.up_to_date && accept.size === 0;

  return (
    <Stack spacing={2}>
      <HelpWell id="settings.starter_pack" title={helpContent.starter_pack.headline}>
        {helpContent.starter_pack.well}
      </HelpWell>

      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {status?.not_ledgered && (
        <Alert severity="info" data-testid="pack-not-ledgered">
          <AlertTitle>This organisation has no starter-pack record</AlertTitle>
          It was set up before pack versions existed
          {status.not_ledgered.pack ? ` (its setup chose the "${status.not_ledgered.pack}" pack)` : ''}. Its document
          types, requirements and limits are all in place and nothing is wrong with them. But without a record of what
          the pack wrote, an update cannot tell a new item from one you removed on purpose, so no update is offered
          until the record has been established. That is a one-time step your administrator runs for you
          (<code>bin/baseline-pack-ledger</code>); it compares what you have with the pack and changes none of it.
        </Alert>
      )}

      {status && status.packs.length === 0 && !status.not_ledgered && (
        <Alert severity="info">
          This organisation has not taken a starter pack. The setup wizard is where one is chosen.
        </Alert>
      )}

      {status?.packs.map((pack) => (
        <Paper key={pack.pack} variant="outlined" sx={{ p: 2 }} data-testid={`pack-${pack.pack}`}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} justifyContent="space-between">
            <Box>
              <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                This organisation is on {pack.label} version {pack.version}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {pack.available_version === null
                  ? 'This pack is no longer shipped, so there is nothing to update to.'
                  : pack.update_available
                    ? `Version ${pack.available_version} is available.`
                    : 'It is on the latest version.'}
                {' '}Recorded {pack.applied_at}
                {pack.applied_by_name ? ` by ${pack.applied_by_name}` : ''}.
              </Typography>
            </Box>
            {pack.available_version !== null && (
              <Button
                variant={pack.update_available ? 'contained' : 'outlined'}
                disabled={busy}
                onClick={() => runPreview(pack)}
              >
                {pack.update_available ? `Preview version ${pack.available_version}` : 'Compare with the pack'}
              </Button>
            )}
          </Stack>
        </Paper>
      ))}

      {applied && (
        <Alert severity={applied.not_applied.length > 0 ? 'warning' : 'success'} data-testid="pack-applied">
          <AlertTitle>
            {applied.from_version === applied.to_version
              ? `${applied.label} version ${applied.to_version}: your choices were applied`
              : `Now on ${applied.label} version ${applied.to_version}`}
          </AlertTitle>
          {applied.summary.fields_updated} value{applied.summary.fields_updated === 1 ? '' : 's'} updated,{' '}
          {applied.summary.inserted} added, {applied.summary.kept} kept as you had them.
          {applied.not_applied.length > 0 && (
            <Box component="ul" sx={{ mt: 1, mb: 0, pl: 2 }}>
              {applied.not_applied.map((n) => (
                <li key={`${n.kind}:${n.key}`}>
                  <strong>{n.label}</strong>:{' '}
                  {n.reason === 'changed_since_preview'
                    ? 'somebody changed it after the preview, so it was left as they set it. Preview again to see it.'
                    : n.reason === 'not_inserted'
                      ? 'it could not be added (what it belongs to is not there).'
                      : (n.detail ?? n.reason)}
                </li>
              ))}
            </Box>
          )}
        </Alert>
      )}

      {preview && (
        <Stack spacing={2} data-testid="pack-preview">
          <Divider />
          <Box>
            <Typography variant="h6">
              {preview.from_version === preview.to_version
                ? `${preview.label} version ${preview.to_version}, compared with what you have`
                : `${preview.label}: version ${preview.from_version} to version ${preview.to_version}`}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              This is a preview. Nothing has been changed.
            </Typography>
          </Box>

          {preview.up_to_date && !preview.needs_attention && (
            <Alert severity="success">
              Nothing to do: everything the pack wrote is either as the pack has it or as you changed it.
            </Alert>
          )}
          {preview.needs_attention && (
            <Alert severity="warning" data-testid="pack-needs-attention">
              <AlertTitle>Something here needs a person</AlertTitle>
              {preview.up_to_date ? 'Nothing will be changed by applying, but this update is not finished: ' : ''}
              an item below collides with something you already have, or would loosen a sharing rule. An update never
              settles those for you. They are listed under "Kept as you have them", "Needs a person" and "You may
              already have these under another name".
            </Alert>
          )}
          {preview.not_applied.length > 0 && (
            <Alert severity="warning">
              <AlertTitle>Asked for, and will not be done</AlertTitle>
              <Box component="ul" sx={{ my: 0, pl: 2 }}>
                {preview.not_applied.map((n) => (
                  <li key={`${n.kind}:${n.key}:${n.reason}`}>
                    <strong>{n.label}</strong>: {n.detail ?? n.reason}
                  </li>
                ))}
              </Box>
            </Alert>
          )}

          <Group
            testId="group-update"
            title="Will be updated"
            count={groups.updates.length}
            blurb="The pack wrote these and nobody has changed them since, so they move to the new version's value."
          >
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Item</TableCell>
                  <TableCell>What</TableCell>
                  <TableCell>Now</TableCell>
                  <TableCell>Will become</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.updates.map(({ item, field }) => (
                  <TableRow key={`${item.kind}:${item.key}:${field.field}`}>
                    <TableCell><ItemName item={item} /></TableCell>
                    <TableCell>{fieldLabel(field.field)}</TableCell>
                    <TableCell><Value value={field.current} /></TableCell>
                    <TableCell><Value value={field.target} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Group>

          <Group
            testId="group-keep"
            title="Kept as you have them"
            count={groups.kept.length}
            blurb="The new version changes these, but your organisation's value is not the one the pack wrote, so yours is kept. Tick one to take the pack's value instead."
          >
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Item</TableCell>
                  <TableCell>What</TableCell>
                  <TableCell>Yours (kept)</TableCell>
                  <TableCell>The pack now says</TableCell>
                  <TableCell>Use the pack's</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.kept.map(({ item, field }) => {
                  const a: PackAccept = { kind: item.kind, key: item.key, field: field.field };
                  return (
                    <TableRow key={`${item.kind}:${item.key}:${field.field}`}>
                      <TableCell><ItemName item={item} /></TableCell>
                      <TableCell>
                        {fieldLabel(field.field)}
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {field.reason === 'edited'
                            ? `You changed it. The pack had written: ${showValue(field.base)}`
                            : field.reason === 'setting'
                              ? 'Part of a setting you changed; it moves whole or not at all.'
                              : field.reason === 'duplicate_name'
                                ? `You already have "${item.conflict?.name}" (${item.conflict?.slug}) under that name, so this one is not renamed. Rename one of them on its own screen if you want both.`
                                : 'It already differed when this organisation was recorded.'}
                          {field.field === 'name' && field.reason !== 'duplicate_name' && item.conflict && (
                            <>
                              {' '}The pack's name is already used by "{item.conflict.name}" ({item.conflict.slug}), so it cannot be
                              taken here.
                            </>
                          )}
                        </Typography>
                      </TableCell>
                      <TableCell><Value value={field.current} /></TableCell>
                      <TableCell><Value value={field.target} /></TableCell>
                      <TableCell>
                        {/* A name another row already holds is never taken by a tick. */}
                        {!(field.field === 'name' && item.conflict) && (
                          <Checkbox
                            checked={accept.has(acceptKey(a))}
                            onChange={() => toggle(a)}
                            disabled={busy}
                            inputProps={{ 'aria-label': `Use the pack's ${fieldLabel(field.field)} for ${item.label}` }}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Group>

          <Group
            testId="group-needs-person"
            title="Needs a person"
            count={groups.needsPerson.length}
            blurb="The new version would make these documents easier to send outside the organisation. An update never does that by itself: change the rule on Settings > Document Types if you agree."
          >
            <Table size="small">
              <TableBody>
                {groups.needsPerson.map(({ item, field }) => (
                  <TableRow key={`${item.kind}:${item.key}:${field.field}`}>
                    <TableCell><ItemName item={item} /></TableCell>
                    <TableCell>{fieldLabel(field.field)}</TableCell>
                    <TableCell><Value value={field.current} /></TableCell>
                    <TableCell><Value value={field.target} /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Group>

          <Group
            testId="group-insert"
            title="New in this version"
            count={groups.inserted.length}
            blurb="These will be added."
          >
            <ItemList items={groups.inserted} />
          </Group>

          <Group
            testId="group-adopt"
            title="Already yours"
            count={groups.adopted.length}
            blurb="The pack has an item for something you already made. Yours becomes that item; nothing is added and nothing of yours is changed."
          >
            <ItemList
              items={groups.adopted}
              detail={(i) =>
                i.fields.length === 0
                  ? 'Identical to the pack.'
                  : `Differs from the pack in: ${i.fields.map((f) => fieldLabel(f.field)).join(', ')}. Kept as yours.`
              }
            />
          </Group>

          <Group
            testId="group-conflict"
            title="You may already have these under another name"
            count={groups.conflicts.length}
            blurb="The pack adds each of these, and you have something that looks like the same thing. Nothing is added unless you tick it; two rows for one thing means later updates reach only one of them."
          >
            <Table size="small">
              <TableBody>
                {groups.conflicts.map((item) => {
                  const a: PackAccept = { kind: item.kind, key: item.key };
                  const scoped = item.conflict?.supplier_scoped === true;
                  return (
                    <TableRow key={`${item.kind}:${item.key}`}>
                      <TableCell><ItemName item={item} /></TableCell>
                      <TableCell>
                        <Typography variant="body2">
                          {scoped
                            ? `"${item.conflict?.name}" (${item.conflict?.slug}) belongs to one supplier and holds this slug. ` +
                              "It is not the pack's type, so an update never writes to it and cannot add the pack's beside it."
                            : `You have "${item.conflict?.name}" (${item.conflict?.slug})${item.conflict && !item.conflict.active ? ', switched off' : ''}.`}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        {!scoped && (
                          <FormControlLabel
                            control={<Checkbox checked={accept.has(acceptKey(a))} onChange={() => toggle(a)} disabled={busy} />}
                            label="Add the pack's as well"
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Group>

          <Group
            testId="group-waiting"
            title="Waiting"
            count={groups.waiting.length}
            blurb="These are new, and what they belong to is not in place yet. They are offered again next time."
          >
            <ItemList items={groups.waiting} detail={(i) => (i.missing ? `Needs ${i.missing}.` : null)} />
          </Group>

          <Group
            testId="group-inactive"
            title="Switched off"
            count={groups.inactive.length}
            blurb="The pack has these and you switched them off. They stay off and are not updated while they are off."
          >
            <ItemList items={groups.inactive} detail={(i) => (i.news ? 'Noted in this update.' : null)} />
          </Group>

          <Group
            testId="group-gone"
            title="Not in this organisation"
            count={groups.gone.length}
            blurb="The pack has these and this organisation does not: you removed them, or they joined the pack after you were set up. An update never adds them by itself. Tick one to add it."
          >
            <Table size="small">
              <TableBody>
                {groups.gone.map((item) => {
                  const a: PackAccept = { kind: item.kind, key: item.key };
                  return (
                    <TableRow key={`${item.kind}:${item.key}`}>
                      <TableCell sx={{ width: '45%' }}><ItemName item={item} /></TableCell>
                      <TableCell>
                        <Typography variant="body2" color="text.secondary">
                          {item.missing ? `Belongs to ${item.missing}, which is not here either.` : GONE_WORDS[item.outcome]}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <FormControlLabel
                          control={
                            <Checkbox
                              checked={accept.has(acceptKey(a))}
                              onChange={() => toggle(a)}
                              disabled={busy}
                              inputProps={{ 'aria-label': `Add ${item.label}` }}
                            />
                          }
                          label="Add it"
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Group>

          <Group
            testId="group-removed"
            title="No longer in the pack"
            count={groups.removed.length}
            blurb="The pack used to have these and no longer does. Yours are left exactly as they are; nothing is deleted or switched off. Decide for yourself whether you still want them."
          >
            <ItemList items={groups.removed} detail={(i) => (i.news ? 'Newly dropped in this version.' : 'Dropped in an earlier version.')} />
          </Group>

          <Group
            testId="group-customised"
            title="Your own values"
            count={groups.customised.length}
            blurb="You changed these and the pack has nothing new to say about them. Listed so you can see where you differ; tick one to go back to the pack's value."
          >
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Item</TableCell>
                  <TableCell>What</TableCell>
                  <TableCell>Yours</TableCell>
                  <TableCell>The pack's</TableCell>
                  <TableCell>Use the pack's</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.customised.map(({ item, field }) => {
                  const a: PackAccept = { kind: item.kind, key: item.key, field: field.field };
                  return (
                    <TableRow key={`${item.kind}:${item.key}:${field.field}`}>
                      <TableCell><ItemName item={item} /></TableCell>
                      <TableCell>{fieldLabel(field.field)}</TableCell>
                      <TableCell><Value value={field.current} /></TableCell>
                      <TableCell><Value value={field.target} /></TableCell>
                      <TableCell>
                        <Checkbox
                          checked={accept.has(acceptKey(a))}
                          onChange={() => toggle(a)}
                          disabled={busy}
                          inputProps={{ 'aria-label': `Use the pack's ${fieldLabel(field.field)} for ${item.label}` }}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Group>

          <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center">
            {accept.size > 0 && (
              <Typography variant="body2" color="text.secondary">
                {accept.size} of your own value{accept.size === 1 ? '' : 's'} will be replaced by the pack's.
              </Typography>
            )}
            <Button onClick={() => setPreview(null)} disabled={busy}>
              Close
            </Button>
            <Button variant="contained" onClick={apply} disabled={busy || nothingToApply}>
              {preview.from_version === preview.to_version ? 'Apply' : `Apply version ${preview.to_version}`}
            </Button>
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}
