/**
 * ModuleAccessContext — the two behaviours that decide whether somebody can
 * find their own work.
 *
 *   1. A FAILED FETCH SHOWS EVERYTHING. Module visibility is a scope control,
 *      not a confidentiality boundary: the server re-checks every call, and
 *      failing closed would turn a transient blip into an empty portal. The
 *      server's own read falls open for the same reason
 *      (`functions/lib/module-access.ts`), so a test that let this drift would
 *      leave the two halves disagreeing about what an error means.
 *   2. IT RE-ASKS WHEN THE TENANT UNDER IT MOVES. A super_admin scoping into
 *      another organization is looking at that organization's portal; a cached
 *      answer from the previous tenant would show them the wrong rail and,
 *      worse, would look correct.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const access = vi.fn();

let authState = { isAuthenticated: true, loading: false };
let tenantState: { selectedTenantId: string | null } = { selectedTenantId: 't1' };

vi.mock('./AuthContext', () => ({
  useAuth: () => authState,
}));
vi.mock('./TenantContext', () => ({
  useTenant: () => tenantState,
}));
vi.mock('../lib/api', () => ({
  api: { modules: { access: (...args: unknown[]) => access(...args) } },
}));

import { ModuleAccessProvider, useModuleAccess } from './ModuleAccessContext';

/** A probe that renders the context as text, so assertions read as sentences. */
function Probe() {
  const { loading, visible, tenantEnabled, functions, degraded } = useModuleAccess();
  return (
    <div>
      <span data-testid="loading">{loading ? 'loading' : 'ready'}</span>
      <span data-testid="visible">{visible.join(',')}</span>
      <span data-testid="tenant">{tenantEnabled.join(',')}</span>
      <span data-testid="functions">{functions.join(',')}</span>
      <span data-testid="degraded">{degraded ? 'degraded' : 'ok'}</span>
    </div>
  );
}

function renderProbe() {
  return render(
    <ModuleAccessProvider>
      <Probe />
    </ModuleAccessProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  authState = { isAuthenticated: true, loading: false };
  tenantState = { selectedTenantId: 't1' };
});

describe('ModuleAccessProvider', () => {
  it('exposes both layers, so a denial can say which one refused', async () => {
    access.mockResolvedValue({
      tenant_id: 't1',
      role: 'user',
      tenant_enabled: ['library', 'compliance'],
      visible: ['library'],
      functions: ['qa'],
      degraded: false,
    });

    renderProbe();

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('visible')).toHaveTextContent('library');
    expect(screen.getByTestId('tenant')).toHaveTextContent('library,compliance');
    expect(screen.getByTestId('functions')).toHaveTextContent('qa');
    expect(screen.getByTestId('degraded')).toHaveTextContent('ok');
  });

  it('fails OPEN when the fetch fails, and says it guessed', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    access.mockRejectedValue(new Error('network down'));

    renderProbe();

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    // Everything, not nothing: the nav shows too much for a moment rather
    // than the customer's portal going blank because a request timed out.
    expect(screen.getByTestId('visible')).toHaveTextContent(
      'library,compliance,fulfillment,records'
    );
    expect(screen.getByTestId('degraded')).toHaveTextContent('degraded');
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('holds its render until the first answer arrives', async () => {
    let resolve: ((value: unknown) => void) | undefined;
    access.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      })
    );

    renderProbe();

    // The rail must not be drawn from a guess and then pruned — that flash is
    // exactly what `ProtectedRoute`'s single spinner exists to prevent.
    expect(screen.getByTestId('loading')).toHaveTextContent('loading');
    resolve?.({
      tenant_id: 't1',
      role: 'user',
      tenant_enabled: ['library'],
      visible: ['library'],
      functions: [],
      degraded: false,
    });
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
  });

  it('re-asks when the selected tenant changes', async () => {
    access.mockResolvedValue({
      tenant_id: 't1',
      role: 'super_admin',
      tenant_enabled: ['library'],
      visible: ['library'],
      functions: [],
      degraded: false,
    });

    const { rerender } = renderProbe();
    await waitFor(() => expect(access).toHaveBeenCalledTimes(1));

    tenantState = { selectedTenantId: 't2' };
    rerender(
      <ModuleAccessProvider>
        <Probe />
      </ModuleAccessProvider>
    );

    await waitFor(() => expect(access).toHaveBeenCalledTimes(2));
  });

  it('asks nothing at all while auth is still resolving', () => {
    authState = { isAuthenticated: false, loading: true };
    renderProbe();
    expect(access).not.toHaveBeenCalled();
  });

  it('does not narrow a signed-out visitor to nothing', async () => {
    // They never reach a gated surface — ProtectedRoute sends them to /login —
    // so "everything" is the state that never flashes an empty nav on logout.
    authState = { isAuthenticated: false, loading: false };
    renderProbe();
    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('ready'));
    expect(screen.getByTestId('visible')).toHaveTextContent(
      'library,compliance,fulfillment,records'
    );
    expect(access).not.toHaveBeenCalled();
  });
});
