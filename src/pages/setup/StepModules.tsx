/**
 * Screen 2 — "Which parts of the portal do you use?"
 *
 * THE MODULES ARE DESCRIBED BY WHO USES THEM, NOT BY WHAT THEY DO. "For the
 * person who answers to the auditor — what expires soon, what came back out of
 * spec" is a sentence an admin can match against their own org chart.
 * "Expiration management" is a sentence they can only match against a feature
 * list they have not read yet. The blurbs come from `shared/modules.ts` through
 * `GET /api/modules`, so this screen and Settings ▸ Modules say the same thing
 * and neither of them is a second copy of the wording.
 *
 * THE SIDEBAR IS SHOWN, NOT DESCRIBED. Every toggle redraws a live preview of
 * the rail built by `navGroupsForRole` — the SAME function `Layout.tsx` calls,
 * with the same surface table behind it. A hand-written list of "what you will
 * lose" would be a third opinion about the nav, and the codebase has already
 * paid for having two (see the drift table in `src/lib/surfaces.tsx`).
 *
 * NO CONFIRMATION DIALOG HERE, UNLIKE SETTINGS. Settings ▸ Modules confirms a
 * switch-off with the names of the items that disappear, because it is taking
 * something away from people who are not in the room. On this screen there is
 * nobody else yet: the tenant is being set up, the person toggling is the only
 * one who has ever seen it, and the preview beside the switch is already
 * showing them exactly what the sidebar becomes. A modal would be ceremony over
 * a decision with no victim.
 *
 * IT WRITES THROUGH, LIKE EVERY OTHER SCREEN. `PUT /api/modules/:key` is the
 * real endpoint, audited as `module.enabled` / `module.disabled` the same as
 * from Settings. The mirror into `tenant_setup_runs.state.modules` is
 * BOOKKEEPING ONLY — it records what this run chose so the receipt can say so,
 * and nothing reads it to decide anything. If the two ever disagree, the table
 * wins, because the table is what the portal renders from.
 *
 * NO MODULE KEY IS WRITTEN AS A LITERAL. `MODULE_KEYS` / `isModuleKey` come
 * from `shared/modules.ts` via `src/lib/types.ts`, so a renamed module fails to
 * compile here rather than silently addressing a module that no longer exists.
 * The pack's keys are plain strings on purpose (a JSON file may name a module
 * this build does not have) and are filtered through `isModuleKey` on arrival.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  LinearProgress,
  List,
  ListItem,
  ListItemText,
  ListSubheader,
  Paper,
  Stack,
  Switch,
  Tooltip,
  Typography,
} from '@mui/material';
import { AutoFixHigh as MatchPackIcon } from '@mui/icons-material';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useModuleAccess } from '../../contexts/ModuleAccessContext';
// The preview is built by the SAME function `Layout.tsx` calls, over the same
// surface table. This closes an import cycle — `surfaces.tsx` names
// `<SetupWizard />`, which mounts this screen — and it is safe for the same
// reason `admin/Modules.tsx` records: `navGroupsForRole` is a hoisted function
// declaration and `SURFACES` is only read during render, never at
// module-evaluation time.
import { navGroupsForRole } from '../../lib/surfaces';
import { MODULE_KEYS, isModuleKey } from '../../lib/types';
import type { ModuleKey, ModuleSummary, Role } from '../../lib/types';
import type { SetupStepProps } from './stepProps';

/** The run-state key this screen mirrors its answer into. */
const MODULES_KEY = 'modules';

/**
 * What the pack recommends, as a decided map.
 *
 * A module the pack mentions in NEITHER list is absent from the result rather
 * than defaulted to true: "the pack has no opinion" and "the pack wants it on"
 * are different, and only the first should leave the tenant's own default
 * alone. Unknown keys are dropped — a pack naming a module this build does not
 * ship can hide nothing, because surfaces come from code.
 */
export function packModulePreference(
  modules: { default_on: string[]; default_off: string[] } | undefined,
): Partial<Record<ModuleKey, boolean>> {
  const out: Partial<Record<ModuleKey, boolean>> = {};
  if (!modules) return out;
  for (const key of modules.default_on) if (isModuleKey(key)) out[key] = true;
  // OFF wins a contradiction. The pack compiler already rejects a key in both
  // lists, but this function is handed data from a network response and a
  // recommendation that reads "on" when the pack meant "off" is the more
  // expensive of the two mistakes — it puts four empty surfaces in front of a
  // customer on day one, which is the thing the module gate exists to prevent.
  for (const key of modules.default_off) if (isModuleKey(key)) out[key] = false;
  return out;
}

/** Which modules the tenant differs from the pack on, in `MODULE_KEYS` order. */
export function modulesDifferingFromPack(
  summaries: readonly ModuleSummary[],
  preference: Partial<Record<ModuleKey, boolean>>,
): ModuleKey[] {
  return MODULE_KEYS.filter((key) => {
    const wanted = preference[key];
    if (wanted === undefined) return false;
    const current = summaries.find((s) => s.key === key);
    return current !== undefined && current.enabled !== wanted;
  });
}

/**
 * The rail as somebody in this organization will see it.
 *
 * Rendered for a CONCRETE role rather than the viewer's own. A super_admin
 * bypasses the module filter entirely (`resolveVisibleModules` returns
 * everything for them), so previewing as themselves would show a sidebar no
 * customer ever sees — the toggles would appear to do nothing. `org_admin` is
 * the role the person setting this up will actually log in as afterwards.
 */
const PREVIEW_ROLE: Role = 'org_admin';

interface NavPreviewProps {
  enabled: readonly ModuleKey[];
}

function NavPreview({ enabled }: NavPreviewProps) {
  const groups = useMemo(() => navGroupsForRole(PREVIEW_ROLE, enabled), [enabled]);

  return (
    <Paper variant="outlined" sx={{ p: 0, overflow: 'hidden' }}>
      <Box sx={{ px: 2, py: 1.25, bgcolor: 'action.hover' }}>
        <Typography variant="subtitle2" fontWeight={700}>
          The sidebar, as an administrator here will see it
        </Typography>
        <Typography variant="caption" color="text.secondary">
          Drawn from the same list the real sidebar is drawn from. Settings, Dashboard, Search and
          Activity belong to no module and never disappear.
        </Typography>
      </Box>
      <Divider />
      <List dense disablePadding sx={{ py: 0.5 }}>
        {groups.map((group) => (
          <Box key={group.module ?? 'always-on'}>
            {group.heading && (
              <ListSubheader
                disableSticky
                sx={{ lineHeight: '2rem', fontSize: '0.7rem', letterSpacing: 0.6 }}
              >
                {group.heading.toUpperCase()}
              </ListSubheader>
            )}
            {group.items.map((surface) => (
              <ListItem key={surface.path} sx={{ py: 0.25, pl: 2.5 }}>
                <Box sx={{ display: 'flex', mr: 1.5, color: 'text.secondary' }}>
                  {surface.nav?.icon}
                </Box>
                <ListItemText
                  primaryTypographyProps={{ variant: 'body2' }}
                  primary={surface.nav?.label}
                />
              </ListItem>
            ))}
          </Box>
        ))}
        {/* Settings is pinned to the bottom of the real rail with a divider
            above it; the preview says so rather than quietly omitting it, since
            "where did Settings go" is the first thing a switched-off preview
            would otherwise prompt. */}
        <Divider sx={{ my: 0.5 }} />
        <ListItem sx={{ py: 0.25, pl: 2.5 }}>
          <ListItemText
            primaryTypographyProps={{ variant: 'body2', color: 'text.secondary' }}
            primary="Settings"
          />
        </ListItem>
      </List>
    </Paper>
  );
}

export function StepModules({ tenantId, pack, patchState }: SetupStepProps) {
  const { user } = useAuth();
  const { refresh: refreshModuleAccess } = useModuleAccess();

  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.modules.list({ tenantId });
      setModules(res.modules);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read this tenant’s modules');
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const preference = useMemo(() => packModulePreference(pack?.modules), [pack]);
  const differing = useMemo(
    () => modulesDifferingFromPack(modules, preference),
    [modules, preference],
  );

  /** The set the preview draws from — local, so it redraws before the round trip. */
  const enabledKeys = useMemo(
    () => MODULE_KEYS.filter((key) => modules.find((m) => m.key === key)?.enabled ?? true),
    [modules],
  );

  /**
   * Mirror the answer into the run's scratch.
   *
   * Written from the module list we just received rather than from the toggle
   * that moved, so the blob always describes the whole answer. A per-key patch
   * would leave the mirror half-populated whenever somebody changed one switch
   * and left.
   */
  const mirror = useCallback(
    (next: readonly ModuleSummary[]) => {
      const map: Record<string, boolean> = {};
      for (const m of next) map[m.key] = m.enabled;
      patchState({ [MODULES_KEY]: map });
    },
    [patchState],
  );

  const setEnabled = useCallback(
    async (key: ModuleKey, enabled: boolean) => {
      setSaving(true);
      setError('');
      try {
        const res = await api.modules.update(key, { enabled, tenant_id: tenantId });
        const next = modules.map((m) => (m.key === key ? res.module : m));
        setModules(next);
        mirror(next);
        // The person doing this is looking at their own portal. A module they
        // just switched off that is still in their own sidebar is not a
        // convincing toggle — same reason Settings ▸ Modules refreshes here.
        refreshModuleAccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update the module');
      } finally {
        setSaving(false);
      }
    },
    [modules, tenantId, mirror, refreshModuleAccess],
  );

  const matchPack = useCallback(async () => {
    setSaving(true);
    setError('');
    try {
      let next = modules;
      // Sequential rather than Promise.all: each PUT writes one row and one
      // audit line, and a failure halfway must leave the earlier ones applied
      // and the screen showing what actually landed.
      for (const key of differing) {
        const res = await api.modules.update(key, {
          enabled: preference[key] === true,
          tenant_id: tenantId,
        });
        next = next.map((m) => (m.key === key ? res.module : m));
        setModules(next);
      }
      mirror(next);
      refreshModuleAccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply the pack’s modules');
    } finally {
      setSaving(false);
    }
  }, [differing, preference, modules, tenantId, mirror, refreshModuleAccess]);

  if (loading && modules.length === 0) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="body1" sx={{ mb: 2 }}>
        Switching a module off hides its whole section of the sidebar for everyone here, and its
        pages stop opening. Nothing is deleted, and switching one back on restores every screen
        exactly as it was — so this is a question about what your people work in, not a commitment.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {pack && differing.length > 0 && (
        <Alert
          severity="info"
          sx={{ mb: 2 }}
          action={
            <Button size="small" startIcon={<MatchPackIcon />} disabled={saving} onClick={() => void matchPack()}>
              Use the pack’s setting
            </Button>
          }
        >
          <AlertTitle>
            The {pack.label} pack starts{' '}
            {differing
              .map((key) => `${modules.find((m) => m.key === key)?.label ?? key} ${preference[key] ? 'on' : 'off'}`)
              .join(', ')}
          </AlertTitle>
          {/* The pack's own reason, not ours: `starter-packs/fsqa.json` explains
              that COA-convergence scope is the last phase and a tenant carrying
              four empty surfaces from day one is what the gate exists to
              prevent. Restating it here would fork the explanation. */}
          A tenant seeded from this pack gets that on its first application. You are free to
          disagree — this is the screen for it.
        </Alert>
      )}

      {!pack && (
        <Alert severity="info" sx={{ mb: 2 }}>
          No starter pack has been applied to this tenant, so these are the defaults every new
          organization gets. Everything below still applies.
        </Alert>
      )}

      {saving && <LinearProgress sx={{ mb: 2 }} />}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 3fr) minmax(280px, 2fr)' },
          alignItems: 'start',
        }}
      >
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Stack divider={<Divider flexItem />}>
            {modules.map((m) => {
              const wanted = preference[m.key];
              return (
                <Box key={m.key} sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.25 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                      <Typography variant="body1" fontWeight={600}>
                        {m.label}
                      </Typography>
                      {wanted !== undefined && wanted !== m.enabled && (
                        <Tooltip
                          title={`The ${pack?.label ?? 'starter'} pack starts this ${wanted ? 'on' : 'off'}.`}
                        >
                          <Chip
                            size="small"
                            variant="outlined"
                            color="info"
                            label={`pack says ${wanted ? 'on' : 'off'}`}
                          />
                        </Tooltip>
                      )}
                    </Box>
                    <Typography variant="body2" color="text.secondary">
                      {m.blurb}
                    </Typography>
                  </Box>
                  <Switch
                    checked={m.enabled}
                    disabled={saving}
                    onChange={(e) => void setEnabled(m.key, e.target.checked)}
                    inputProps={{ 'aria-label': `${m.label} enabled` }}
                  />
                </Box>
              );
            })}
          </Stack>
        </Paper>

        <NavPreview enabled={enabledKeys} />
      </Box>

      {user?.role === 'super_admin' && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>
          Your own sidebar will not change: a super_admin crosses tenants and is never filtered by a
          module switch. The preview above is what an administrator in this organization sees.
        </Typography>
      )}

      <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
        Departments can be narrowed further — QA seeing only Compliance, say — under{' '}
        <strong>Settings ▸ Modules</strong>, using the same departments that receive alerts. That
        only ever narrows within what is switched on here.
      </Typography>
    </Box>
  );
}

export default StepModules;
