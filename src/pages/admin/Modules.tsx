/**
 * Modules — which parts of the portal this organization uses, and which of
 * those each department is expected to work in.
 *
 * THE READING ORDER IS THE RULE. Tenant switches on top, the function × module
 * grid below, because "the tenant gates, the role filters" is literally
 * top-to-bottom: the switches are a ceiling nobody in the organization can see
 * past, and the grid can only narrow within it. A grid above the switches would
 * invite the opposite reading — that ticking a box for QA grants QA something —
 * and that is the misconception this screen exists to prevent.
 *
 * A CHECKBOX UNDER A SWITCHED-OFF CEILING READS DIFFERENTLY FROM AN UNTICKED
 * ONE. Modules the tenant has switched off render greyed in the grid, with a
 * tooltip saying so, rather than silently unticked — otherwise "QA has Orders
 * ticked and still cannot see Orders" looks like a bug in the grid instead of
 * the ceiling doing exactly what it is for.
 *
 * "SEES NOTHING" IS NOT A ROLE CONFIGURATION. The server rejects
 * `{ constrained: true, modules: [] }` with a 400 and says why: absence of
 * rows already means UNCONSTRAINED, so storing an empty constrained set would
 * do the opposite of what the admin who unticked the last box intended. The way
 * to give somebody no portal is to deactivate their account. So this screen
 * makes that state hard to reach rather than merely surfacing the error: the
 * first untick on an unconstrained department starts a scope of
 * everything-EXCEPT-that (the admin removed one thing, they did not name one
 * thing), and unticking the last remaining box asks whether "everything" was
 * meant instead of storing a set that cannot be stored.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  Divider,
  LinearProgress,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Tooltip,
  Typography,
} from '@mui/material';
import { useAuth } from '../../contexts/AuthContext';
import { useTenant } from '../../contexts/TenantContext';
import { useModuleAccess } from '../../contexts/ModuleAccessContext';
import { HelpWell } from '../../components/HelpWell';
import { api } from '../../lib/api';
// The confirmation dialog counts real rail entries rather than a hand-kept
// list, so a surface added to a module tomorrow is counted with no second
// edit. This closes an import cycle — `surfaces.tsx` names `<Settings />`,
// which mounts this page — and it is safe because both bindings involved are
// hoisted function declarations and `SURFACES` is only read when the dialog
// opens, never at module-evaluation time.
import { navLabelsForModule } from '../../lib/surfaces';
import { MODULE_KEYS } from '../../lib/types';
import type { ModuleKey, ModuleSummary, ModuleVisibilityFunction } from '../../lib/types';

/**
 * What unticking a box should DO, computed away from the component so the one
 * rule worth pinning is testable without rendering a grid.
 *
 * Three outcomes, and the third is the whole point:
 *   - the first untick on an unconstrained function starts a scope of
 *     everything-except-that module;
 *   - a tick or untick inside an existing scope edits it;
 *   - an untick that would empty the scope does NOT produce an empty scope —
 *     it asks whether "everything" was meant. `{ constrained: true,
 *     modules: [] }` is a 400 server-side, and rightly so.
 */
export type VisibilityEdit =
  | { kind: 'scope'; modules: ModuleKey[] }
  | { kind: 'confirm_unconstrain' };

export function toggleFunctionModule(
  fn: ModuleVisibilityFunction,
  moduleKey: ModuleKey,
  checked: boolean,
): VisibilityEdit {
  if (!fn.constrained) {
    // An unconstrained function sees everything, so every box renders ticked.
    // Unticking one is the moment a scope begins, and it begins as "everything
    // except this" rather than "only this" — the admin removed one thing.
    if (checked) return { kind: 'scope', modules: [...MODULE_KEYS] };
    const rest = MODULE_KEYS.filter((k) => k !== moduleKey);
    return rest.length === 0 ? { kind: 'confirm_unconstrain' } : { kind: 'scope', modules: rest };
  }

  const next = checked
    ? MODULE_KEYS.filter((k) => fn.modules.includes(k) || k === moduleKey)
    : fn.modules.filter((k) => k !== moduleKey);

  return next.length === 0 ? { kind: 'confirm_unconstrain' } : { kind: 'scope', modules: next };
}

/** Is this box ticked? An unconstrained function has every box ticked. */
export function isFunctionModuleChecked(
  fn: ModuleVisibilityFunction,
  moduleKey: ModuleKey,
): boolean {
  return fn.constrained ? fn.modules.includes(moduleKey) : true;
}

interface PendingDisable {
  moduleKey: ModuleKey;
  label: string;
  navLabels: string[];
}

export function Modules() {
  const { user, isSuperAdmin } = useAuth();
  const { selectedTenantId } = useTenant();
  const { refresh: refreshModuleAccess } = useModuleAccess();

  const tenantId = isSuperAdmin ? selectedTenantId || undefined : user?.tenant_id || undefined;

  const [modules, setModules] = useState<ModuleSummary[]>([]);
  const [functions, setFunctions] = useState<ModuleVisibilityFunction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [pendingDisable, setPendingDisable] = useState<PendingDisable | null>(null);
  const [pendingUnconstrain, setPendingUnconstrain] = useState<ModuleVisibilityFunction | null>(
    null,
  );

  const load = useCallback(async () => {
    if (isSuperAdmin && !tenantId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      // One call answers both halves of the screen: `/api/module-visibility`
      // returns the grid AND the ceiling, precisely so a checkbox can be
      // rendered against the tenant state it sits under.
      const res = await api.modules.visibility({ tenantId });
      setModules(res.modules);
      setFunctions(res.functions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load modules');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, tenantId]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Persist a tenant switch. The admin doing this may be looking at their own
   * portal, so the nav is re-read afterwards — a module you just switched off
   * that is still in your own sidebar is not a convincing toggle.
   */
  const setModuleEnabled = async (moduleKey: ModuleKey, enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await api.modules.update(moduleKey, { enabled, tenant_id: tenantId });
      await load();
      refreshModuleAccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update the module');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleModule = (summary: ModuleSummary, enabled: boolean) => {
    if (enabled) {
      void setModuleEnabled(summary.key, true);
      return;
    }
    // Switching OFF is the one direction that takes things away from people
    // who are not in the room, so it is confirmed — with the count and the
    // names, not with "are you sure?".
    setPendingDisable({
      moduleKey: summary.key,
      label: summary.label,
      navLabels: navLabelsForModule(summary.key),
    });
  };

  const applyVisibility = async (
    fn: ModuleVisibilityFunction,
    edit: { constrained: boolean; modules?: ModuleKey[] },
  ) => {
    setSaving(true);
    setError(null);
    try {
      await api.modules.setVisibility(fn.owner_key, {
        constrained: edit.constrained,
        modules: edit.modules,
        tenant_id: tenantId,
      });
      await load();
      refreshModuleAccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update this function');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleCell = (fn: ModuleVisibilityFunction, moduleKey: ModuleKey, checked: boolean) => {
    const edit = toggleFunctionModule(fn, moduleKey, checked);
    if (edit.kind === 'confirm_unconstrain') {
      setPendingUnconstrain(fn);
      return;
    }
    void applyVisibility(fn, { constrained: true, modules: edit.modules });
  };

  if (isSuperAdmin && !tenantId) {
    return (
      <Box>
        <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
          Modules
        </Typography>
        <Alert severity="info">
          Modules are configured per organization. Pick a tenant in the sidebar filter first.
        </Alert>
      </Box>
    );
  }

  return (
    <Box>
      <Typography variant="h4" fontWeight={700} sx={{ mb: 3 }}>
        Modules
      </Typography>

      <HelpWell id="modules.overview" title="What does this company use the portal for?">
        Switching a module off hides its whole section of the sidebar for{' '}
        <strong>everyone here</strong>, and its pages stop opening — a link
        somebody saved explains itself rather than failing. Below that, each
        department can be narrowed further, but only within what is switched on
        above. A department nobody has narrowed{' '}
        <strong>sees everything the company has</strong> — that is the deliberate
        default, so a person seeing less always means somebody chose it.
      </HelpWell>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {(loading || saving) && <LinearProgress sx={{ mb: 2 }} />}

      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
          <CircularProgress />
        </Box>
      ) : (
        <>
          {/* ------------------------------------------- the tenant ceiling */}
          <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              What this organization uses
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              The ceiling. Nobody here can see a module that is switched off,
              whatever their department says below.
            </Typography>
            <Divider sx={{ mb: 1 }} />
            <Stack divider={<Divider flexItem />}>
              {modules.map((m) => (
                <Box
                  key={m.key}
                  sx={{ display: 'flex', alignItems: 'center', gap: 2, py: 1.25 }}
                >
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <Typography variant="body1" fontWeight={600}>
                        {m.label}
                      </Typography>
                      {!m.configured && (
                        <Tooltip title="Nobody has changed this — it is the default for every new organization.">
                          <Chip size="small" variant="outlined" label="default" />
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
                    onChange={(e) => handleToggleModule(m, e.target.checked)}
                    inputProps={{ 'aria-label': `${m.label} enabled` }}
                  />
                </Box>
              ))}
            </Stack>
          </Paper>

          {/* --------------------------------------- the per-function grid */}
          <Paper variant="outlined" sx={{ p: 2 }}>
            <Typography variant="subtitle1" fontWeight={700}>
              What each department works in
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
              These are the same departments that receive renewal and out-of-spec
              alerts — one concept, two effects. A department with every box
              ticked is unconstrained: it will pick up any module switched on in
              future without anybody revisiting this grid.
            </Typography>

            {functions.length === 0 ? (
              <Alert severity="info" variant="outlined">
                <AlertTitle>No departments yet</AlertTitle>
                Departments come from owner routing — QA, Insurance, Accounting,
                Purchasing. Add one under <strong>Settings ▸ Owner Routing</strong>{' '}
                and it will appear here. Until then everyone sees everything the
                organization has switched on, which is the correct default.
              </Alert>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Department</TableCell>
                      <TableCell align="center">People</TableCell>
                      {MODULE_KEYS.map((key) => {
                        const summary = modules.find((m) => m.key === key);
                        const off = summary ? !summary.enabled : false;
                        return (
                          <TableCell key={key} align="center">
                            <Typography
                              variant="caption"
                              sx={{ fontWeight: 700, color: off ? 'text.disabled' : 'text.primary' }}
                            >
                              {summary?.label ?? key}
                            </Typography>
                          </TableCell>
                        );
                      })}
                      <TableCell align="center">Scope</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {functions.map((fn) => (
                      <TableRow key={fn.owner_key} hover>
                        <TableCell>
                          <Typography variant="body2" fontWeight={600}>
                            {fn.owner_label}
                          </Typography>
                        </TableCell>
                        <TableCell align="center">
                          <Typography variant="body2" color="text.secondary">
                            {fn.route_count}
                          </Typography>
                        </TableCell>
                        {MODULE_KEYS.map((key) => {
                          const summary = modules.find((m) => m.key === key);
                          const tenantOff = summary ? !summary.enabled : false;
                          const checked = isFunctionModuleChecked(fn, key);
                          const box = (
                            <Checkbox
                              size="small"
                              checked={checked}
                              disabled={saving || tenantOff}
                              onChange={(e) => handleToggleCell(fn, key, e.target.checked)}
                              inputProps={{
                                'aria-label': `${fn.owner_label} can see ${summary?.label ?? key}`,
                              }}
                            />
                          );
                          return (
                            <TableCell key={key} align="center">
                              {tenantOff ? (
                                // Greyed, with the reason attached: the box is
                                // not unticked, it is unreachable, and those
                                // are different states an admin has to be able
                                // to tell apart.
                                <Tooltip
                                  title={`${summary?.label ?? key} is switched off for the whole organization — switch it on above before scoping departments to it.`}
                                >
                                  <span>{box}</span>
                                </Tooltip>
                              ) : (
                                box
                              )}
                            </TableCell>
                          );
                        })}
                        <TableCell align="center">
                          {fn.constrained ? (
                            <Tooltip title="Give this department access to everything the organization has, now and in future.">
                              <Button
                                size="small"
                                disabled={saving}
                                onClick={() => void applyVisibility(fn, { constrained: false })}
                              >
                                Unrestrict
                              </Button>
                            </Tooltip>
                          ) : (
                            <Chip size="small" variant="outlined" label="everything" />
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </Paper>
        </>
      )}

      {/* Turning a module off: say what disappears, and for whom. */}
      <Dialog open={pendingDisable !== null} onClose={() => setPendingDisable(null)}>
        <DialogTitle>Switch off {pendingDisable?.label}?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            {pendingDisable && pendingDisable.navLabels.length > 0 ? (
              <>
                <strong>
                  {pendingDisable.navLabels.length} sidebar item
                  {pendingDisable.navLabels.length === 1 ? '' : 's'}
                </strong>{' '}
                will disappear for everyone in this organization:{' '}
                {pendingDisable.navLabels.join(', ')}. Their pages stop opening
                too — anyone who follows a saved link gets a short explanation
                rather than an error.
              </>
            ) : (
              <>
                This module has no sidebar items, but its pages stop opening for
                everyone in this organization.
              </>
            )}
            <Box component="p" sx={{ mb: 0 }}>
              Nothing is deleted. Switching it back on restores every screen
              exactly as it was.
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingDisable(null)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            onClick={() => {
              if (pendingDisable) void setModuleEnabled(pendingDisable.moduleKey, false);
              setPendingDisable(null);
            }}
          >
            Switch off
          </Button>
        </DialogActions>
      </Dialog>

      {/* The last-box case. Never sends the empty set the server refuses. */}
      <Dialog open={pendingUnconstrain !== null} onClose={() => setPendingUnconstrain(null)}>
        <DialogTitle>Give {pendingUnconstrain?.owner_label} access to everything?</DialogTitle>
        <DialogContent>
          <DialogContentText component="div">
            That was the last module ticked for {pendingUnconstrain?.owner_label}.
            A department that sees <em>nothing</em> is not a scope we can store —
            an account with no portal is one that has been deactivated, which is
            done on the Users screen.
            <Box component="p" sx={{ mb: 0 }}>
              Leaving the scope removes the restriction entirely:{' '}
              {pendingUnconstrain?.owner_label} will see every module this
              organization has switched on, including ones added later.
            </Box>
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPendingUnconstrain(null)}>Keep the current scope</Button>
          <Button
            variant="contained"
            onClick={() => {
              if (pendingUnconstrain) {
                void applyVisibility(pendingUnconstrain, { constrained: false });
              }
              setPendingUnconstrain(null);
            }}
          >
            Give access to everything
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

export default Modules;
