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
