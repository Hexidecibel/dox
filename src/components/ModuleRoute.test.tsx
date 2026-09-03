/**
 * ModuleRoute — a refused surface must EXPLAIN itself, at the URL that was
 * opened.
 *
 * The bug this replaces was a silent `<Navigate to="/dashboard">`: a
 * bookmarked or shared link dumped you on the dashboard with no way to tell a
 * retired feature from a permission problem from an outage, and the colleague
 * who sent the link got "it doesn't work for me" and nothing else.
 *
 * The assertions below therefore pin two things at once — that the panel
 * appears, and that the router did NOT move. A test that only looked for the
 * text would still pass if the panel flashed and then redirected.
 *
 * Each of the three conjuncts gets its own case because each is fixed by a
 * different person on a different screen, and "I enabled it for QA and she
 * still cannot see it" is answerable only if the panel says which one refused.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ModuleKey, Role, User } from '../lib/types';

let currentUser: User | null = null;
let accessState = {
  tenantEnabled: ['library', 'compliance', 'fulfillment', 'records'] as ModuleKey[],
  visible: ['library', 'compliance', 'fulfillment', 'records'] as ModuleKey[],
  functions: [] as string[],
};

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ user: currentUser }),
}));
vi.mock('../contexts/ModuleAccessContext', () => ({
  useModuleAccess: () => accessState,
}));

import { ModuleRoute } from './ModuleRoute';

function user(role: Role): User {
  return {
    id: 'u1',
    email: 'someone@example.com',
    name: 'Someone',
    role,
    tenant_id: 't1',
    active: 1,
    last_login_at: null,
    created_at: '',
  } as User;
}

/**
 * Render one gated surface at /orders, with a distinguishable /dashboard
 * alongside it. If the component redirects, the dashboard marker appears —
 * which is the regression this whole file is about.
 */
function renderAt(props: { module: ModuleKey | null; roles?: Role[] }) {
  return render(
    <MemoryRouter initialEntries={['/orders']}>
      <Routes>
        <Route
          path="/orders"
          element={
            <ModuleRoute module={props.module} roles={props.roles}>
              <div>The orders screen</div>
            </ModuleRoute>
          }
        />
        <Route path="/dashboard" element={<div>REDIRECTED TO DASHBOARD</div>} />
        <Route path="/login" element={<div>REDIRECTED TO LOGIN</div>} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  currentUser = user('user');
  accessState = {
    tenantEnabled: ['library', 'compliance', 'fulfillment', 'records'],
    visible: ['library', 'compliance', 'fulfillment', 'records'],
    functions: [],
  };
});

describe('ModuleRoute', () => {
  it('renders the surface when all three conjuncts hold', () => {
    renderAt({ module: 'fulfillment' });
    expect(screen.getByText('The orders screen')).toBeInTheDocument();
  });

  it('never gates an always-on surface', () => {
    // `module: null` is Dashboard, Search, Activity, Settings. A tenant with
    // every module switched off still has a portal to log into.
    accessState = { tenantEnabled: [], visible: [], functions: [] };
    renderAt({ module: null });
    expect(screen.getByText('The orders screen')).toBeInTheDocument();
  });

  it('says the ORGANIZATION switched it off, and does not redirect', () => {
    accessState = {
      tenantEnabled: ['library'],
      visible: ['library'],
      functions: ['qa'],
    };
    renderAt({ module: 'fulfillment' });

    expect(screen.getByText(/switched off for your organization/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings ▸ Modules/)).toBeInTheDocument();
    expect(screen.queryByText('REDIRECTED TO DASHBOARD')).not.toBeInTheDocument();
    expect(screen.queryByText('The orders screen')).not.toBeInTheDocument();
  });

  it('distinguishes a scoped DEPARTMENT from a switched-off module, and names it', () => {
    // The company has Order Fulfillment; this person's department was scoped
    // away from it. Different screen, different person, different fix — and
    // naming the department is what turns the support question into an answer.
    accessState = {
      tenantEnabled: ['library', 'fulfillment'],
      visible: ['library'],
      functions: ['qa'],
    };
    renderAt({ module: 'fulfillment' });

    expect(screen.getByText(/not part of your role's access/i)).toBeInTheDocument();
    expect(screen.getByText('qa')).toBeInTheDocument();
    expect(screen.queryByText(/switched off for your organization/i)).not.toBeInTheDocument();
    expect(screen.queryByText('REDIRECTED TO DASHBOARD')).not.toBeInTheDocument();
  });

  it('reports the tenant ceiling BEFORE the role, so nobody argues with the wrong person', () => {
    // Both layers refuse. Telling a reader "your role is too low" for a module
    // their company does not even have would send them to their admin for a
    // change that would not help.
    accessState = { tenantEnabled: ['library'], visible: ['library'], functions: [] };
    currentUser = user('reader');
    renderAt({ module: 'fulfillment', roles: ['super_admin', 'org_admin'] });

    expect(screen.getByText(/switched off for your organization/i)).toBeInTheDocument();
    expect(screen.queryByText(/does not have access to this page/i)).not.toBeInTheDocument();
  });

  it('explains a role refusal instead of bouncing to the dashboard', () => {
    currentUser = user('reader');
    renderAt({ module: 'fulfillment', roles: ['super_admin', 'org_admin'] });

    expect(screen.getByText(/does not have access to this page/i)).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
    expect(screen.queryByText('REDIRECTED TO DASHBOARD')).not.toBeInTheDocument();
  });

  it('shows everything when visibility fell open', () => {
    // The degraded answer from ModuleAccessContext is "every module". A gate
    // that refused on a failed lookup would take the portal down to protect a
    // preference; the server still enforces on every call.
    accessState = {
      tenantEnabled: ['library', 'compliance', 'fulfillment', 'records'],
      visible: ['library', 'compliance', 'fulfillment', 'records'],
      functions: [],
    };
    renderAt({ module: 'fulfillment' });
    expect(screen.getByText('The orders screen')).toBeInTheDocument();
  });

  it('sends a session-less render to login rather than showing a panel', () => {
    currentUser = null;
    renderAt({ module: 'fulfillment' });
    expect(screen.getByText('REDIRECTED TO LOGIN')).toBeInTheDocument();
  });
});
