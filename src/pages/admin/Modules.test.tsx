/**
 * Settings ▸ Modules — the two states that would otherwise be traps.
 *
 *   1. SWITCHING A MODULE OFF TAKES THINGS AWAY FROM PEOPLE WHO ARE NOT IN
 *      THE ROOM. "Are you sure?" tells the admin nothing they did not already
 *      know; the count and the names of the sidebar items that disappear is a
 *      decision they can actually make.
 *   2. UNTICKING THE LAST BOX MUST NOT SEND `{ constrained: true,
 *      modules: [] }`. The server rejects it with a 400 and is right to:
 *      absence of rows already means UNCONSTRAINED, so an empty constrained
 *      set would grant the opposite of what the admin intended. This screen
 *      has to make that state hard to reach, not merely surface the error.
 *
 * The grid's greyed-under-a-switched-off-ceiling rendering is pinned too,
 * because "QA has Orders ticked and still cannot see Orders" reads as a bug in
 * the grid unless the ceiling is visibly doing it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ModuleSummary, ModuleVisibilityFunction } from '../../lib/types';

const visibility = vi.fn();
const updateModule = vi.fn();
const setVisibility = vi.fn();
const refreshModuleAccess = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'org_admin', tenant_id: 't1' }, isSuperAdmin: false }),
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ selectedTenantId: 't1' }),
}));
vi.mock('../../contexts/ModuleAccessContext', () => ({
  useModuleAccess: () => ({ refresh: refreshModuleAccess }),
}));
vi.mock('../../lib/api', () => ({
  api: {
    modules: {
      visibility: (...args: unknown[]) => visibility(...args),
      update: (...args: unknown[]) => updateModule(...args),
      setVisibility: (...args: unknown[]) => setVisibility(...args),
    },
  },
}));

import { Modules, toggleFunctionModule, isFunctionModuleChecked } from './Modules';

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

function fn(over: Partial<ModuleVisibilityFunction>): ModuleVisibilityFunction {
  return {
    owner_key: 'qa',
    owner_label: 'QA',
    constrained: false,
    modules: [],
    route_count: 2,
    declared: true,
    ...over,
  };
}

const MODULE_SUMMARIES: ModuleSummary[] = [
  summary({ key: 'library', label: 'Supplier Documents' }),
  summary({ key: 'compliance', label: 'Compliance' }),
  summary({ key: 'fulfillment', label: 'Order Fulfillment' }),
  summary({ key: 'records', label: 'Records' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  visibility.mockResolvedValue({
    tenant_id: 't1',
    modules: MODULE_SUMMARIES,
    functions: [fn({})],
  });
  updateModule.mockResolvedValue({ module: MODULE_SUMMARIES[0] });
  setVisibility.mockResolvedValue({ function: fn({}) });
});

describe('toggleFunctionModule', () => {
  it('starts a scope of everything-EXCEPT-that on the first untick', () => {
    // The admin removed one thing; they did not name one thing. Reading it the
    // other way would silently take three modules away from a department that
    // was only meant to lose one.
    const edit = toggleFunctionModule(fn({ constrained: false }), 'fulfillment', false);
    expect(edit).toEqual({ kind: 'scope', modules: ['library', 'compliance', 'records'] });
  });

  it('edits an existing scope in both directions, keeping presentation order', () => {
    const scoped = fn({ constrained: true, modules: ['library'] });
    expect(toggleFunctionModule(scoped, 'fulfillment', true)).toEqual({
      kind: 'scope',
      modules: ['library', 'fulfillment'],
    });
    expect(
      toggleFunctionModule(fn({ constrained: true, modules: ['library', 'records'] }), 'records', false)
    ).toEqual({ kind: 'scope', modules: ['library'] });
  });

  it('never produces the empty set the server refuses — it asks instead', () => {
    const edit = toggleFunctionModule(fn({ constrained: true, modules: ['library'] }), 'library', false);
    expect(edit).toEqual({ kind: 'confirm_unconstrain' });
  });

  it('renders an unconstrained function with every box ticked', () => {
    const open = fn({ constrained: false });
    expect(isFunctionModuleChecked(open, 'library')).toBe(true);
    expect(isFunctionModuleChecked(open, 'records')).toBe(true);

    const scoped = fn({ constrained: true, modules: ['library'] });
    expect(isFunctionModuleChecked(scoped, 'library')).toBe(true);
    expect(isFunctionModuleChecked(scoped, 'records')).toBe(false);
  });
});

describe('Modules screen', () => {
  it('reads the tenant ceiling first and the department grid second', async () => {
    render(<Modules />);
    await waitFor(() => expect(screen.getByText('What this organization uses')).toBeInTheDocument());
    expect(screen.getByText('What each department works in')).toBeInTheDocument();
  });

  it('says how many sidebar items disappear before switching a module off', async () => {
    const userEv = userEvent.setup();
    render(<Modules />);
    // By label rather than by text: "Order Fulfillment" is deliberately
    // written twice on this screen — once as the switch, once as a grid
    // column — because the ceiling and the scope are two different questions.
    await userEv.click(await screen.findByLabelText('Order Fulfillment enabled'));

    // Concrete, not "are you sure?": the count AND the names, straight from
    // the surface table, so a surface added tomorrow is counted with no edit.
    expect(await screen.findByText('Switch off Order Fulfillment?')).toBeInTheDocument();
    expect(screen.getByText(/4 sidebar items/)).toBeInTheDocument();
    expect(
      screen.getByText(/Orders, Lots, Customers, COA Fulfillment/)
    ).toBeInTheDocument();
    // Nothing has been written yet — the dialog is the decision point.
    expect(updateModule).not.toHaveBeenCalled();

    await userEv.click(screen.getByRole('button', { name: 'Switch off' }));
    await waitFor(() =>
      expect(updateModule).toHaveBeenCalledWith('fulfillment', { enabled: false, tenant_id: 't1' })
    );
    // The admin may be looking at their own portal; the rail has to move too.
    await waitFor(() => expect(refreshModuleAccess).toHaveBeenCalled());
  });

  it('offers "everything" rather than sending a set the server rejects', async () => {
    const userEv = userEvent.setup();
    visibility.mockResolvedValue({
      tenant_id: 't1',
      modules: MODULE_SUMMARIES,
      functions: [fn({ constrained: true, modules: ['library'] })],
    });

    render(<Modules />);
    await waitFor(() => expect(screen.getByText('QA')).toBeInTheDocument());

    await userEv.click(screen.getByLabelText('QA can see Supplier Documents'));

    expect(
      await screen.findByText('Give QA access to everything?')
    ).toBeInTheDocument();
    expect(setVisibility).not.toHaveBeenCalled();

    await userEv.click(screen.getByRole('button', { name: 'Give access to everything' }));
    await waitFor(() =>
      expect(setVisibility).toHaveBeenCalledWith('qa', {
        constrained: false,
        modules: undefined,
        tenant_id: 't1',
      })
    );
  });

  it('greys a checkbox that sits under a switched-off ceiling', async () => {
    visibility.mockResolvedValue({
      tenant_id: 't1',
      modules: [
        MODULE_SUMMARIES[0],
        MODULE_SUMMARIES[1],
        summary({ key: 'fulfillment', label: 'Order Fulfillment', enabled: false, configured: true }),
        MODULE_SUMMARIES[3],
      ],
      functions: [fn({})],
    });

    render(<Modules />);
    await waitFor(() => expect(screen.getByText('QA')).toBeInTheDocument());

    // Unreachable, not unticked. The function layer can only narrow within the
    // ceiling and never grant past it, so an enabled checkbox here would be a
    // promise the resolver will not keep.
    expect(screen.getByLabelText('QA can see Order Fulfillment')).toBeDisabled();
    expect(screen.getByLabelText('QA can see Supplier Documents')).not.toBeDisabled();
  });

  it('explains an empty grid instead of showing a bare table', async () => {
    visibility.mockResolvedValue({ tenant_id: 't1', modules: MODULE_SUMMARIES, functions: [] });
    render(<Modules />);
    await waitFor(() => expect(screen.getByText('No departments yet')).toBeInTheDocument());
    // And says where departments come from: they are owner routes, not a
    // second role table.
    expect(screen.getByText(/Settings ▸ Owner Routing/)).toBeInTheDocument();
  });
});
