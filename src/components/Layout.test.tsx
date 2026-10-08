/**
 * Layout — the rail actually applies the tenant module gate.
 *
 * `surfaces.test.ts` proves `navGroupsForRole` computes the right list; this
 * proves the rail is rendered FROM that list with the visible set passed in.
 * The two are separate failures: a Layout that forgot the second argument
 * would keep every unit test green and still ship a sidebar advertising a
 * module the tenant switched off — links that all end in a refusal panel.
 *
 * The heading assertion is the one that matters most. Empty groups drop their
 * heading (the `Settings.tsx` filter-then-drop-empty shape), so a lone "Order
 * Fulfillment" subheader with nothing beneath it is the visible symptom of a
 * filter applied to the items and not to the groups.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ModuleKey, Role, User } from '../lib/types';

let currentUser: User | null = null;
let visibleModules: ModuleKey[] = ['library', 'compliance', 'fulfillment', 'records'];

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: currentUser,
    logout: vi.fn(),
    isSuperAdmin: currentUser?.role === 'super_admin',
  }),
}));
vi.mock('../contexts/TenantContext', () => ({
  useTenant: () => ({ tenants: [], selectedTenantId: null, setSelectedTenantId: vi.fn() }),
}));
vi.mock('../contexts/ModuleAccessContext', () => ({
  useModuleAccess: () => ({ visible: visibleModules }),
}));
// The bell polls; it has nothing to do with the rail.
vi.mock('./NotificationsBell', () => ({ NotificationsBell: () => null }));

// "Waiting for QA" (migration 0138) is drawn only for a person the server says
// may release. Everything else on `api` stays the real client.
const pendingMock = vi.fn();
vi.mock('../lib/api', async (orig) => {
  const actual = await orig<typeof import('../lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, orderDocuments: { pending: (...args: unknown[]) => pendingMock(...args) } },
  };
});

import { Layout } from './Layout';

function user(role: Role): User {
  return {
    id: 'u1',
    email: 'someone@example.com',
    name: 'Some One',
    role,
    tenant_id: 't1',
    active: 1,
    last_login_at: null,
    created_at: '',
  } as User;
}

function renderRail() {
  return render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <Layout />
    </MemoryRouter>
  );
}

beforeEach(() => {
  currentUser = user('org_admin');
  visibleModules = ['library', 'compliance', 'fulfillment', 'records'];
  pendingMock.mockReset();
  pendingMock.mockResolvedValue({ can_release: false, count: 0, lines: [] });
});

describe('Layout — Waiting for QA in the rail', () => {
  it('is drawn, with the number waiting, for a person who can release', async () => {
    currentUser = user('user');
    pendingMock.mockResolvedValue({ can_release: true, count: 3, lines: [] });
    renderRail();
    expect(await screen.findByText('Waiting for QA')).toBeInTheDocument();
    expect(screen.getByTestId('nav-waiting-for-qa-count')).toHaveTextContent('3');
  });

  it('is drawn without a number when nothing is waiting', async () => {
    pendingMock.mockResolvedValue({ can_release: true, count: 0, lines: [] });
    renderRail();
    expect(await screen.findByText('Waiting for QA')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-waiting-for-qa-count')).not.toBeInTheDocument();
  });

  it('is not drawn for a person who cannot release, or when the question fails', async () => {
    currentUser = user('user');
    const { unmount } = renderRail();
    await waitFor(() => expect(pendingMock).toHaveBeenCalled());
    expect(screen.queryByText('Waiting for QA')).not.toBeInTheDocument();
    unmount();

    pendingMock.mockRejectedValue(new Error('no'));
    renderRail();
    await waitFor(() => expect(pendingMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Waiting for QA')).not.toBeInTheDocument();
  });

  it('is never asked about for a read-only account, or with order fulfillment switched off', () => {
    currentUser = user('reader');
    const first = renderRail();
    expect(pendingMock).not.toHaveBeenCalled();
    first.unmount();

    currentUser = user('org_admin');
    visibleModules = ['library', 'compliance', 'records'];
    renderRail();
    expect(pendingMock).not.toHaveBeenCalled();
    expect(screen.queryByText('Waiting for QA')).not.toBeInTheDocument();
  });
});

describe('Layout — the module-gated rail', () => {
  it('renders every group when the tenant uses everything', () => {
    renderRail();
    expect(screen.getByText('Order Fulfillment')).toBeInTheDocument();
    expect(screen.getAllByText('Orders').length).toBeGreaterThan(0);
    expect(screen.getByText('Compliance')).toBeInTheDocument();
  });

  it('drops a switched-off module\'s items AND its heading', () => {
    visibleModules = ['library', 'compliance', 'records'];
    renderRail();

    expect(screen.queryByText('Order Fulfillment')).not.toBeInTheDocument();
    expect(screen.queryByText('Orders')).not.toBeInTheDocument();
    expect(screen.queryByText('Lots')).not.toBeInTheDocument();
    expect(screen.queryByText('COA Fulfillment')).not.toBeInTheDocument();

    // Everything else is untouched: the gate narrows, it never re-homes.
    expect(screen.getByText('Compliance')).toBeInTheDocument();
    expect(screen.getByText('Documents')).toBeInTheDocument();
  });

  it('keeps the always-on surfaces when every module is off', () => {
    // A tenant with nothing switched on still has a portal to log into — and,
    // for an admin, the pinned Settings entry that switches one back on.
    visibleModules = [];
    renderRail();

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Search')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    for (const heading of ['Supplier Documents', 'Compliance', 'Order Fulfillment', 'Records']) {
      expect(screen.queryByText(heading), heading).not.toBeInTheDocument();
    }
  });

  it('still applies the role tier on top of the module gate', () => {
    // Both predicates, ANDed. A reader with every module enabled must not
    // gain Review Queue or Import just because `library` is on.
    currentUser = user('reader');
    renderRail();

    expect(screen.getByText('Documents')).toBeInTheDocument();
    expect(screen.queryByText('Review Queue')).not.toBeInTheDocument();
    expect(screen.queryByText('Import')).not.toBeInTheDocument();
    expect(screen.queryByText('Settings')).not.toBeInTheDocument();
  });
});
