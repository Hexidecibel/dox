/**
 * Screen 2 — the two things that would otherwise be quietly wrong.
 *
 *   1. THE PACK'S OPINION IS NOT THE TENANT'S STATE. A pack that starts Order
 *      Fulfillment off has to be visible as a RECOMMENDATION the person can
 *      disagree with, not silently applied a second time by the wizard. And a
 *      module the pack mentions in neither list must leave the tenant's own
 *      default alone — "no opinion" and "wants it on" are different.
 *   2. THE SIDEBAR PREVIEW IS THE REAL SIDEBAR. It is built by
 *      `navGroupsForRole`, the function `Layout.tsx` calls, so a surface added
 *      to a module tomorrow appears here with no second edit. Asserting it
 *      against real labels is what stops it drifting back into a hand-written
 *      list — the exact failure `src/lib/surfaces.tsx` was created to end.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModuleSummary, TenantSetupRun } from '../../lib/types';
import type { SetupStepProps } from './stepProps';

const list = vi.fn();
const update = vi.fn();
const refreshModuleAccess = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'org_admin', tenant_id: 't1' }, isSuperAdmin: false }),
}));
vi.mock('../../contexts/ModuleAccessContext', () => ({
  useModuleAccess: () => ({ refresh: refreshModuleAccess }),
}));
vi.mock('../../lib/api', () => ({
  api: {
    modules: {
      list: (...a: unknown[]) => list(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import { StepModules, packModulePreference, modulesDifferingFromPack } from './StepModules';

function summary(over: Partial<ModuleSummary> & Pick<ModuleSummary, 'key'>): ModuleSummary {
  return {
    label: over.key,
    blurb: '',
    enabled: true,
    configured: false,
    updated_at: null,
    updated_by: null,
    ...over,
  } as ModuleSummary;
}

const ALL_ON: ModuleSummary[] = [
  summary({ key: 'library', label: 'Supplier Documents' }),
  summary({ key: 'compliance', label: 'Compliance' }),
  summary({ key: 'fulfillment', label: 'Order Fulfillment' }),
  summary({ key: 'records', label: 'Records' }),
];

const run: TenantSetupRun = {
  id: 'run1',
  tenant_id: 't1',
  status: 'draft',
  current_step: 2,
  pack: 'fsqa',
  state: {},
  applied: {},
  started_by: 'u1',
  started_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
  completed_at: null,
  completed_by: null,
};

const pack = {
  pack: 'fsqa',
  label: 'Food Safety',
  description: '',
  sections: [],
  owner_labels: [],
  total_rows: 0,
  modules: { default_on: ['library', 'compliance', 'records'], default_off: ['fulfillment'] },
  teach: null,
  packets: [],
};

function props(over: Partial<SetupStepProps> = {}): SetupStepProps {
  return {
    run,
    tenantId: 't1',
    catalog: null,
    pack: null,
    preSeeded: null,
    patchState: vi.fn(),
    refreshRun: vi.fn().mockResolvedValue(undefined),
    goToStep: vi.fn(),
    setNextIntercept: vi.fn(),
    finish: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('packModulePreference', () => {
  it('has no opinion about a module the pack does not mention', () => {
    expect(packModulePreference({ default_on: ['library'], default_off: [] })).toEqual({
      library: true,
    });
  });

  it('drops a key this build does not ship rather than failing', () => {
    // Pack keys are plain strings on purpose: a JSON file may name a module
    // this build has never heard of, and it is inert — a `tenant_modules` row
    // can hide nothing, because surfaces come from code.
    expect(
      packModulePreference({ default_on: ['library', 'telepathy'], default_off: [] }),
    ).toEqual({ library: true });
  });

  it('lets OFF win a contradiction', () => {
    // The pack compiler rejects a key in both lists, but this reads a network
    // response. Reading "on" when the pack meant "off" is the more expensive
    // mistake — it puts empty surfaces in front of a customer on day one.
    expect(
      packModulePreference({ default_on: ['fulfillment'], default_off: ['fulfillment'] }),
    ).toEqual({ fulfillment: false });
  });
});

describe('modulesDifferingFromPack', () => {
  it('names only the modules the tenant actually disagrees on', () => {
    expect(modulesDifferingFromPack(ALL_ON, packModulePreference(pack.modules))).toEqual([
      'fulfillment',
    ]);
  });

  it('is empty when the tenant already matches', () => {
    const matching = ALL_ON.map((m) =>
      m.key === 'fulfillment' ? { ...m, enabled: false } : m,
    );
    expect(modulesDifferingFromPack(matching, packModulePreference(pack.modules))).toEqual([]);
  });
});

describe('StepModules', () => {
  it('shows the pack’s recommendation as a recommendation, not as a fait accompli', async () => {
    list.mockResolvedValue({ tenant_id: 't1', modules: ALL_ON });
    render(<StepModules {...props({ pack })} />);

    await waitFor(() =>
      expect(screen.getByText(/starts order fulfillment off/i)).toBeInTheDocument(),
    );
    // Nothing was written on render. The wizard does not re-apply what the pack
    // already did on screen 1, and it does not decide for the person here.
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /use the pack’s setting/i })).toBeInTheDocument();
  });

  it('writes through PUT /api/modules/:key and mirrors the whole answer into the run', async () => {
    list.mockResolvedValue({ tenant_id: 't1', modules: ALL_ON });
    update.mockResolvedValue({
      module: { ...ALL_ON[2], enabled: false, configured: true },
    });
    const patchState = vi.fn();
    render(<StepModules {...props({ pack, patchState })} />);

    await screen.findByLabelText('Order Fulfillment enabled');
    await userEvent.click(screen.getByLabelText('Order Fulfillment enabled'));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith('fulfillment', { enabled: false, tenant_id: 't1' }),
    );
    // The mirror describes the WHOLE answer, not the switch that moved: a
    // per-key patch would leave the blob half-populated for anyone who changed
    // one switch and left.
    expect(patchState).toHaveBeenCalledWith({
      modules: { library: true, compliance: true, fulfillment: false, records: true },
    });
    // The admin is looking at their own portal; the rail has to catch up.
    expect(refreshModuleAccess).toHaveBeenCalled();
  });

  it('redraws the real sidebar as the switch moves', async () => {
    list.mockResolvedValue({
      tenant_id: 't1',
      modules: ALL_ON.map((m) => (m.key === 'fulfillment' ? { ...m, enabled: false } : m)),
    });
    render(<StepModules {...props({ pack })} />);

    // From `navGroupsForRole`, not from a list written here: the Compliance
    // heading and its items are present, and the switched-off module's heading
    // is gone entirely rather than left hanging over nothing.
    await waitFor(() => expect(screen.getByText('COMPLIANCE')).toBeInTheDocument());
    expect(screen.getByText('Renewals')).toBeInTheDocument();
    expect(screen.queryByText('ORDER FULFILLMENT')).toBeNull();
    expect(screen.queryByText('Orders')).toBeNull();
    // Always-on surfaces survive every switch.
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });
});
