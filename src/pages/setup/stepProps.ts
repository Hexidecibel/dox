/**
 * The contract every setup screen is handed.
 *
 * In its own module so the shell can import the screens and the screens can
 * import this without a cycle — the shape is shared, the shell is not.
 *
 * WHAT A SCREEN GETS, AND WHAT IT DOES NOT. It gets the run (its position, and
 * the ledger of what has already been applied), the tenant it is configuring,
 * and the pack catalog. It does NOT get a setter for "the wizard's answers",
 * because there is no such thing: a screen writes its configuration to the real
 * table through the real endpoint, immediately. `patchState` exists only for
 * the wizard's own scratch — a selection made but not yet applied, a block
 * somebody dismissed — and nothing outside the wizard ever reads it.
 */

import type { ComponentType } from 'react';
import type {
  StarterPackCatalogEntry,
  StarterPackCatalogResponse,
  TenantSetupRun,
} from '../../lib/types';

export interface SetupStepProps {
  run: TenantSetupRun;
  /** The tenant being configured. Undefined means "the caller's own". */
  tenantId?: string;
  /** Every pack that ships, with its honest counts. Null while loading. */
  catalog: StarterPackCatalogResponse | null;
  /** The pack this run is walking, if one has been chosen. */
  pack: StarterPackCatalogEntry | null;
  /**
   * What the tenant ALREADY had before this run touched it.
   *
   * A tenant created by `bin/create-tenant --pack fsqa` arrives fully seeded
   * with no run row at all, so "has the pack been applied" cannot be answered
   * from the ledger alone. Probed once by the shell — which also uses it to
   * open on screen 2 rather than making somebody dismiss a step that is already
   * done — and shared, so no screen repeats the reads. Null while loading or
   * when the probe failed.
   */
  preSeeded: { types: number; requirements: number } | null;
  /**
   * Merge keys into the run's scratch blob. Debounced by the shell — a screen
   * may call it on every keystroke.
   */
  patchState: (patch: Record<string, unknown>) => void;
  /** Re-read the run after a write-through action that changed its ledger. */
  refreshRun: () => Promise<void>;
  /** Jump to a screen. The stepper is navigable; nothing here is a gate. */
  goToStep: (step: number) => void;
  /**
   * Let the screen on display spend ONE press of Next on itself.
   *
   * WHY THIS EXISTS AT ALL, given that Back and Next are never disabled and no
   * screen gates the one after it. Screen 4 is not collecting configuration,
   * it is teaching an idea, and the only moment at which it can tell whether
   * the idea landed is the moment somebody decides they are finished with it.
   * Somebody who ticks one box and reaches for Next has understood the screen
   * as a form; a sentence shown after they have left is a sentence nobody
   * reads.
   *
   * IT IS NOT A GATE, and the difference is worth being precise about. The
   * button stays enabled. The intercept returns `true` at most ONCE per visit
   * — the screen is responsible for disarming itself — so the second press
   * always advances, whatever the screen thinks of the answer. It cannot
   * refuse; it can only ask once, in place, without a modal.
   *
   * Pass `null` to disarm. A screen MUST disarm on unmount (return it from the
   * registering effect) — React runs an unmounting child's cleanup before the
   * replacing child's effects, so that ordering is what keeps one screen's
   * intercept from firing on the next screen's Next.
   */
  setNextIntercept: (intercept: (() => boolean) | null) => void;
  /**
   * Mark the run `completed` and leave the wizard.
   *
   * COMPLETION IS A DECLARATION, NOT A SCORE. The run finishes because somebody
   * said it was finished, whether or not the readiness list is fully green —
   * there is no computed threshold anywhere, and a tenant that skipped four
   * screens is allowed to be done. Screens 5 and 6 both show what is still
   * empty; neither of them gates on it.
   *
   * `patch` is merged into the run's scratch in the SAME write, so a screen can
   * record why it finished (`{ demo_skipped: true }`) without a second request
   * that might land after the status change — or not at all.
   */
  finish: (patch?: Record<string, unknown>) => Promise<void>;
}

/** One screen, as the stepper knows it. */
export interface SetupStepDefinition {
  /** 1-based, matching `/setup/:step` and `tenant_setup_runs.current_step`. */
  step: number;
  /** The stepper label — short. */
  label: string;
  /** The question the screen answers, as the person would ask it. */
  title: string;
  Component: ComponentType<SetupStepProps>;
}
