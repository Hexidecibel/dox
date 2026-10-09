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
const listMock = vi.fn();
// "Holds" (migration 0139) carries the number of certificates on hold.
const holdsCountMock = vi.fn();
const holdsListMock = vi.fn();
vi.mock('../lib/api', async (orig) => {
  const actual = await orig<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      // The rail asks for the COUNT only; the list (and its live judgement of
      // every waiting line) is for the page.
      orderDocuments: {
        pendingCount: (...args: unknown[]) => pendingMock(...args),
        pending: (...args: unknown[]) => listMock(...args),
      },
      holds: {
        ...actual.api.holds,
        count: (...args: unknown[]) => holdsCountMock(...args),
        list: (...args: unknown[]) => holdsListMock(...args),
      },
    },
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
  listMock.mockReset();
  pendingMock.mockResolvedValue({ can_release: false, count: 0 });
  holdsCountMock.mockReset();
  holdsListMock.mockReset();
  holdsCountMock.mockResolvedValue({ count: 0, failures: 0 });
});

describe('Layout: Holds in the rail', () => {
  it('is drawn for every role, a read-only account included, with the number on hold', async () => {
    for (const role of ['reader', 'user', 'org_admin'] as Role[]) {
      currentUser = user(role);
      holdsCountMock.mockResolvedValue({ count: 4, failures: 0 });
      const view = renderRail();
      expect(await screen.findByText('Holds')).toBeInTheDocument();
      expect(await screen.findByTestId('nav-holds-count')).toHaveTextContent('4');
      view.unmount();
    }
    // The count form only: the rail never runs the list.
    expect(holdsListMock).not.toHaveBeenCalled();
  });

  it('counts a hold that should have been placed and was not: it needs somebody too (C-087)', async () => {
    holdsCountMock.mockResolvedValue({ count: 2, failures: 1 });
    renderRail();
    expect(await screen.findByTestId('nav-holds-count')).toHaveTextContent('3');
  });

  it('shows no number when nothing is on hold, or when the question fails', async () => {
    holdsCountMock.mockResolvedValue({ count: 0, failures: 0 });
    const first = renderRail();
    expect(await screen.findByText('Holds')).toBeInTheDocument();
    await waitFor(() => expect(holdsCountMock).toHaveBeenCalled());
    expect(screen.queryByTestId('nav-holds-count')).not.toBeInTheDocument();
    first.unmount();

    holdsCountMock.mockRejectedValue(new Error('offline'));
    renderRail();
    expect(await screen.findByText('Holds')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-holds-count')).not.toBeInTheDocument();
  });

  it('asks once on mount and again when a screen says a hold was placed or released, not on every navigation', async () => {
    holdsCountMock.mockResolvedValue({ count: 2, failures: 0 });
    const view = renderRail();
    expect(await screen.findByTestId('nav-holds-count')).toHaveTextContent('2');
    expect(holdsCountMock).toHaveBeenCalledTimes(1);
    (await screen.findAllByText('Orders'))[0].click();
    await screen.findByText('Holds');
    expect(holdsCountMock).toHaveBeenCalledTimes(1);

    holdsCountMock.mockResolvedValue({ count: 1, failures: 0 });
    window.dispatchEvent(new Event('dox:holds-changed'));
    await waitFor(() => expect(screen.getByTestId('nav-holds-count')).toHaveTextContent('1'));
    expect(holdsCountMock).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('follows the library module: with it switched off there is no rail entry and no question asked', async () => {
    visibleModules = ['fulfillment'];
    renderRail();
    expect((await screen.findAllByText('Orders')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Holds')).not.toBeInTheDocument();
    expect(holdsCountMock).not.toHaveBeenCalled();
  });
});

describe('Layout — Waiting for QA in the rail', () => {
  it('is drawn, with the number waiting, for a person who can release', async () => {
    currentUser = user('user');
    pendingMock.mockResolvedValue({ can_release: true, count: 3 });
    renderRail();
    expect(await screen.findByText('Waiting for QA')).toBeInTheDocument();
    expect(screen.getByTestId('nav-waiting-for-qa-count')).toHaveTextContent('3');
    // The count form only: the rail never runs the full list.
    expect(listMock).not.toHaveBeenCalled();
  });

  it('asks once on mount and again when a screen says the number changed, not on every navigation', async () => {
    pendingMock.mockResolvedValue({ can_release: true, count: 2 });
    const view = render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Layout />
      </MemoryRouter>
    );
    await screen.findByText('Waiting for QA');
    expect(pendingMock).toHaveBeenCalledTimes(1);
    // Moving around the portal does not ask again.
    (await screen.findAllByText('Orders'))[0].click();
    await screen.findByText('Waiting for QA');
    expect(pendingMock).toHaveBeenCalledTimes(1);
    // A release elsewhere on the screen does.
    pendingMock.mockResolvedValue({ can_release: true, count: 1 });
    window.dispatchEvent(new Event('dox:qa-waiting-changed'));
    await waitFor(() => expect(screen.getByTestId('nav-waiting-for-qa-count')).toHaveTextContent('1'));
    expect(pendingMock).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('is drawn without a number when nothing is waiting', async () => {
    pendingMock.mockResolvedValue({ can_release: true, count: 0 });
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
