/**
 * The first-run setup wizard — the shell, its persistence and its stepper.
 *
 * WHY IT DOES NOT LOOK LIKE `SourceWizard.tsx`. That file is the only other MUI
 * `<Stepper>` in the codebase and it holds every answer in local `useState`: a
 * reload loses the lot. That is survivable for a five-minute connector form and
 * not survivable here — somebody who gets to screen 4, is interrupted, and comes
 * back the next morning must not start over.
 *
 * So this follows the codebase's DOMINANT pattern instead
 * (`records/FormBuilder.tsx`, `records/WorkflowBuilder.tsx`,
 * `requests/RequestCompose.tsx`): a server row created in `draft` up front, and
 * a 600ms debounced autosave into it with a save indicator.
 *
 * WHAT IS SAVED IS A POSITION, NOT A CONFIGURATION. Every screen writes its real
 * rows to their real tables through the endpoints that already own them, the
 * moment somebody acts. `tenant_setup_runs` records which screen they were on
 * and a scratch blob nothing else reads. A failed autosave therefore costs a
 * re-click and never a setting — and, more importantly, screens 2-6 render from
 * the tenant rather than from a staged blob, which is what stops the wizard
 * working over a tenant that does not. See migration 0101's header.
 *
 * NAVIGATION IS FREE. The stepper is clickable, Back and Next are never
 * disabled, and no screen gates the one after it. Every screen here is optional
 * by construction — the tenant works with none of it — so a gate would be a
 * fiction, and a wizard that refuses to advance is a form.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Paper,
  Step,
  StepButton,
  Stepper,
  Typography,
} from '@mui/material';
import {
  ArrowBack as BackIcon,
  ArrowForward as NextIcon,
  Check as CheckIcon,
  RestartAlt as RestartIcon,
} from '@mui/icons-material';
import { api } from '../../lib/api';
import { useTenant } from '../../contexts/TenantContext';
import { TENANT_SETUP_STEPS } from '../../lib/types';
import type { StarterPackCatalogResponse, TenantSetupRun } from '../../lib/types';
import type { SetupStepDefinition, SetupStepProps } from './stepProps';
import StepPack from './StepPack';
import StepModules from './StepModules';
import StepOwners from './StepOwners';
import StepReceipt from './StepReceipt';
import StepDemo from './StepDemo';
import StepPlaceholder from './StepPlaceholder';

/** Same debounce as `records/FormBuilder.tsx`. One number, one meaning. */
const AUTOSAVE_DEBOUNCE_MS = 600;

/**
 * The six screens.
 *
 * 4 is owned by other work and renders `StepPlaceholder`. It is in the list
 * rather than absent from it because the stepper has to show the real shape of
 * the flow — a five-step wizard telling somebody it is step "3 of 6" is worse
 * than a step that admits it is unfinished.
 */
const STEPS: SetupStepDefinition[] = [
  { step: 1, label: 'Your industry', title: 'What do you make or handle?', Component: StepPack },
  { step: 2, label: 'Modules', title: 'Which parts of the portal do you use?', Component: StepModules },
  { step: 3, label: 'Renewals', title: 'Who owns renewals?', Component: StepOwners },
  { step: 4, label: 'The idea', title: 'One document, several boxes', Component: StepPlaceholder },
  { step: 5, label: 'Receipt', title: 'Here is what exists now.', Component: StepReceipt },
  { step: 6, label: 'Try it', title: 'Drop a document through it', Component: StepDemo },
];

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

/** Same indicator vocabulary as FormBuilder's, so the two read identically. */
function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'saving') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <CircularProgress size={12} />
        <Typography variant="caption" color="text.secondary">
          Saving…
        </Typography>
      </Box>
    );
  }
  if (state === 'saved') {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
        <CheckIcon sx={{ fontSize: 14, color: 'success.main' }} />
        <Typography variant="caption" color="text.secondary">
          Saved
        </Typography>
      </Box>
    );
  }
  if (state === 'error') {
    return (
      <Typography variant="caption" color="error.main">
        Couldn&apos;t save your place — the configuration itself is already stored
      </Typography>
    );
  }
  return null;
}

export function SetupWizard() {
  const { step: stepParam } = useParams<{ step?: string }>();
  const navigate = useNavigate();
  const { selectedTenantId } = useTenant();

  const [run, setRun] = useState<TenantSetupRun | null>(null);
  const [catalog, setCatalog] = useState<StarterPackCatalogResponse | null>(null);
  const [preSeeded, setPreSeeded] = useState<{ types: number; requirements: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [restarting, setRestarting] = useState(false);

  // super_admin scopes into a tenant with the rail selector; everyone else is
  // pinned to their own by the API whatever we send.
  const tenantId = selectedTenantId ?? undefined;

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The step and scratch the debounce will write. Held in a ref so a rapid
  // sequence of navigations coalesces into one PATCH carrying the LAST
  // position, not the first.
  const pendingRef = useRef<{ current_step?: number; state?: Record<string, unknown> }>({});
  // Set once, so the "open on screen 2 because the tenant is already seeded"
  // jump happens on arrival and never again — otherwise clicking back to
  // screen 1 would bounce straight forward.
  const autoAdvancedRef = useRef(false);
  // The latest run, readable without putting a side effect inside a state
  // updater — React may invoke an updater twice in development, and scheduling
  // a save from inside one would fire the debounce twice for one edit.
  const runRef = useRef<TenantSetupRun | null>(null);

  const currentStep = useMemo(() => {
    const parsed = Number(stepParam);
    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= TENANT_SETUP_STEPS) {
      return Math.trunc(parsed);
    }
    return null;
  }, [stepParam]);

  // ---- load ----

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      setError('');
      try {
        // The run first: POST returns the EXISTING draft when there is one, so
        // this both resumes and creates without the caller having to know
        // which it is doing.
        const created = await api.tenantSetup.start({ tenantId });
        if (cancelled) return;
        setRun(created.run);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not start setup');
      } finally {
        if (!cancelled) setLoading(false);
      }

      // The catalog and the pre-seed probe are non-fatal: screen 1 shows a
      // spinner without the first, and the second only decides which screen to
      // open on.
      api.starterPacks
        .list()
        .then((res) => !cancelled && setCatalog(res))
        .catch(() => !cancelled && setCatalog(null));

      Promise.all([
        api.documentTypes.list({ tenant_id: tenantId, active: 1 }),
        api.requirements.list({ tenant_id: tenantId, active: 1, limit: 1 }),
      ])
        .then(([types, reqs]) => {
          if (cancelled) return;
          setPreSeeded({ types: types.documentTypes.length, requirements: reqs.total });
        })
        .catch(() => !cancelled && setPreSeeded(null));
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  useEffect(() => {
    runRef.current = run;
  }, [run]);

  const refreshRun = useCallback(async () => {
    try {
      const res = await api.tenantSetup.get({ tenantId });
      if (res.run) setRun(res.run);
    } catch {
      // A failed refresh leaves the in-memory run in place, which is correct:
      // it is a position, and the position has not changed.
    }
  }, [tenantId]);

  // ---- save ----

  const flushSave = useCallback(
    async (runId: string) => {
      const payload = pendingRef.current;
      pendingRef.current = {};
      if (payload.current_step === undefined && payload.state === undefined) return;
      setSaveState('saving');
      try {
        const res = await api.tenantSetup.update(runId, payload);
        setRun(res.run);
        setSaveState('saved');
        setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1500);
      } catch (err) {
        console.error('Setup autosave error:', err);
        setSaveState('error');
      }
    },
    [],
  );

  const scheduleSave = useCallback(
    (runId: string, patch: { current_step?: number; state?: Record<string, unknown> }) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void flushSave(runId);
      }, AUTOSAVE_DEBOUNCE_MS);
    },
    [flushSave],
  );

  useEffect(() => {
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, []);

  /** Merge into the scratch blob. Optimistic locally, debounced to the server. */
  const patchState = useCallback(
    (patch: Record<string, unknown>) => {
      const current = runRef.current;
      if (!current) return;
      const nextState = { ...current.state, ...patch };
      setRun((prev) => (prev ? { ...prev, state: nextState } : prev));
      scheduleSave(current.id, { state: nextState });
    },
    [scheduleSave],
  );

  // ---- navigation ----

  const goToStep = useCallback(
    (step: number) => {
      const clamped = Math.min(Math.max(step, 1), TENANT_SETUP_STEPS);
      navigate(`/setup/${clamped}`);
    },
    [navigate],
  );

  // No :step in the URL — land on wherever the run says it was. This IS the
  // resume: a person who left at screen 4 opens /setup and gets screen 4.
  useEffect(() => {
    if (currentStep !== null || !run) return;
    navigate(`/setup/${run.current_step}`, { replace: true });
  }, [currentStep, run, navigate]);

  // A tenant created by `bin/create-tenant --pack fsqa` is already seeded, so
  // screen 1 has nothing to ask. Open on screen 2 and leave screen 1 reachable
  // as the read-only summary it renders in that state.
  useEffect(() => {
    if (autoAdvancedRef.current) return;
    if (!run || currentStep !== 1 || !preSeeded) return;
    if (run.applied.pack) return;
    if (run.current_step !== 1) return;
    if (preSeeded.types === 0 || preSeeded.requirements === 0) return;
    autoAdvancedRef.current = true;
    navigate('/setup/2', { replace: true });
  }, [run, currentStep, preSeeded, navigate]);

  // Record the position whenever it actually moves.
  useEffect(() => {
    if (!run || currentStep === null || currentStep === run.current_step) return;
    setRun((prev) => (prev ? { ...prev, current_step: currentStep } : prev));
    scheduleSave(run.id, { current_step: currentStep });
  }, [currentStep, run, scheduleSave]);

  /**
   * Finish the run.
   *
   * `patch` rides along in the SAME PATCH as the status change, rather than
   * being written by a separate `patchState` call first. Two reasons, and both
   * have teeth: the scratch write is DEBOUNCED, so a screen that called
   * `patchState({ demo_skipped: true })` and then `finish()` would very often
   * navigate away before the 600ms timer fired and lose it; and even if it did
   * fire, two requests can land in either order against one row. One write,
   * one order.
   *
   * A pending debounce is cancelled for the same reason — it holds an older
   * copy of the same blob and would overwrite this one on the way out.
   */
  const finish = useCallback(
    async (patch?: Record<string, unknown>) => {
      const current = runRef.current;
      if (!current) return;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = {};
      setSaveState('saving');
      try {
        const state =
          patch === undefined && pending.state === undefined
            ? undefined
            : { ...current.state, ...pending.state, ...patch };
        const res = await api.tenantSetup.update(current.id, {
          status: 'completed',
          ...(state === undefined ? {} : { state }),
        });
        setRun(res.run);
        setSaveState('saved');
        navigate('/dashboard');
      } catch (err) {
        setSaveState('error');
        setError(err instanceof Error ? err.message : 'Could not finish setup');
      }
    },
    [navigate],
  );

  const restart = useCallback(async () => {
    setRestarting(true);
    setError('');
    try {
      const res = await api.tenantSetup.start({ tenantId, restart: true });
      setRun(res.run);
      autoAdvancedRef.current = true;
      navigate('/setup/1');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restart setup');
    } finally {
      setRestarting(false);
    }
  }, [tenantId, navigate]);

  // ---- render ----

  if (loading) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (!run) {
    return (
      <Alert severity="error">
        {error || 'Could not open setup for this tenant.'}
      </Alert>
    );
  }

  const active = currentStep ?? run.current_step;
  const definition = STEPS.find((s) => s.step === active) ?? STEPS[0];
  const StepComponent = definition.Component;

  const packName = run.pack ?? (run.applied.pack?.name ?? null);
  const pack = catalog?.packs.find((p) => p.pack === packName) ?? null;

  const stepProps: SetupStepProps = {
    // `current_step` is overridden with the step actually on screen. The URL is
    // the truth about where somebody IS; the row catches up a beat later on the
    // debounce, and a screen that read the row directly would render the
    // previous step's copy for one frame after every Next.
    run: { ...run, current_step: active },
    tenantId,
    catalog,
    pack,
    preSeeded,
    patchState,
    refreshRun,
    goToStep,
    finish,
  };

  return (
    <Box sx={{ maxWidth: 1100, mx: 'auto' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1, flexWrap: 'wrap' }}>
        <Typography variant="h4" fontWeight={700}>
          Set up this tenant
        </Typography>
        {run.status !== 'draft' && (
          <Chip size="small" label={run.status} color="default" variant="outlined" />
        )}
        <Box sx={{ flexGrow: 1 }} />
        <SaveIndicator state={saveState} />
        <Button
          size="small"
          startIcon={<RestartIcon />}
          disabled={restarting}
          onClick={() => void restart()}
        >
          Start over
        </Button>
      </Box>

      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Each screen writes to this tenant as you go, so you can leave at any point and pick up where
        you stopped. Nothing here is a prerequisite for anything else — the portal already works
        with none of it.
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      <Stepper nonLinear activeStep={active - 1} sx={{ mb: 3 }} alternativeLabel>
        {STEPS.map((s) => (
          <Step key={s.step} completed={false}>
            <StepButton onClick={() => goToStep(s.step)}>{s.label}</StepButton>
          </Step>
        ))}
      </Stepper>

      <Paper variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
        <Typography variant="h5" fontWeight={700} gutterBottom>
          {definition.title}
        </Typography>
        <Divider sx={{ mb: 2 }} />
        <StepComponent {...stepProps} />
      </Paper>

      <Box sx={{ display: 'flex', gap: 1, mt: 2, alignItems: 'center' }}>
        <Button
          startIcon={<BackIcon />}
          disabled={active <= 1}
          onClick={() => goToStep(active - 1)}
        >
          Back
        </Button>
        <Box sx={{ flexGrow: 1 }} />
        <Button onClick={() => navigate('/dashboard')}>Finish later</Button>
        {active < TENANT_SETUP_STEPS ? (
          // Never disabled. The nudging is the teaching; blocking would turn
          // the wizard back into a form.
          <Button variant="contained" endIcon={<NextIcon />} onClick={() => goToStep(active + 1)}>
            Next
          </Button>
        ) : (
          <Button variant="contained" endIcon={<CheckIcon />} onClick={() => void finish()}>
            Done
          </Button>
        )}
      </Box>
    </Box>
  );
}

export default SetupWizard;
