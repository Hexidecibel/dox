/**
 * OwnerRoutingPanel — the states that decide whether anybody is actually told.
 *
 * The behaviours worth pinning are the two that fail silently:
 *
 *   1. A label that is on documents with NO active route must surface first and
 *      say so. Renewal alerts pass `adminFallback: false`, so nothing catches
 *      these records — no admin broadcast, no digest, nobody. A row that merely
 *      showed a blank recipient list would look like a formatting quirk.
 *   2. A bare email address must be an obvious, first-class choice. The broker
 *      and the site manager have no portal account and never will, and a UI
 *      that only offers a user picker sends people to ask for one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const listRoutes = vi.fn();
const createRoute = vi.fn();
const removeRoute = vi.fn();
const listUsers = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    ownerRoutes: {
      list: (...args: unknown[]) => listRoutes(...args),
      create: (...args: unknown[]) => createRoute(...args),
      remove: (...args: unknown[]) => removeRoute(...args),
    },
    users: {
      list: (...args: unknown[]) => listUsers(...args),
    },
  },
}));

import OwnerRoutingPanel, { mergeOwnerLabels, routeRecipient } from './OwnerRoutingPanel';
import type { OwnerLabelInUse, OwnerRoute } from '../lib/types';

function route(over: Partial<OwnerRoute>): OwnerRoute {
  return {
    id: 'or_1',
    tenant_id: 't1',
    owner_key: 'qa',
    owner_label: 'QA',
    user_id: null,
    email: 'qa@example.com',
    active: 1,
    created_at: '',
    updated_at: '',
    created_by: null,
    ...over,
  };
}

function label(over: Partial<OwnerLabelInUse>): OwnerLabelInUse {
  return {
    owner_key: 'qa',
    owner_label: 'QA',
    spellings: ['QA'],
    document_count: 3,
    renewal_count: 1,
    route_count: 0,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listUsers.mockResolvedValue([
    { id: 'u1', name: 'Chris', email: 'chris@example.com', active: 1, role: 'org_admin' },
  ]);
  listRoutes.mockResolvedValue({ routes: [], labels_in_use: [] });
});

describe('mergeOwnerLabels', () => {
  it('flags a label that is on documents with no route, and sorts it first', () => {
    const rows = mergeOwnerLabels(
      [route({ owner_key: 'accounting', owner_label: 'Accounting' })],
      [
        label({ owner_key: 'accounting', owner_label: 'Accounting', renewal_count: 9 }),
        label({ owner_key: 'insurance', owner_label: 'Insurance', renewal_count: 2 }),
      ],
    );
    expect(rows[0].owner_key).toBe('insurance');
    expect(rows[0].unrouted).toBe(true);
    expect(rows[1].owner_key).toBe('accounting');
    expect(rows[1].unrouted).toBe(false);
  });

  it('does NOT let an inactive route clear the gap — it reaches nobody', () => {
    const rows = mergeOwnerLabels([route({ active: 0 })], [label({})]);
    expect(rows[0].unrouted).toBe(true);
    expect(rows[0].routes).toHaveLength(1);
  });

  it('keeps a route whose label no document uses, marked as unused and sorted last', () => {
    const rows = mergeOwnerLabels(
      [route({ owner_key: 'purchsing', owner_label: 'Purchsing' })],
      [label({ owner_key: 'purchasing', owner_label: 'Purchasing', route_count: 0 })],
    );
    // The typo stays visible next to the real label rather than vanishing.
    expect(rows.map((r) => r.owner_key)).toEqual(['purchasing', 'purchsing']);
    expect(rows[1].unused).toBe(true);
  });

  it('orders the gaps by how much is riding on them', () => {
    const rows = mergeOwnerLabels(
      [],
      [
        label({ owner_key: 'a', owner_label: 'A', renewal_count: 1, document_count: 50 }),
        label({ owner_key: 'b', owner_label: 'B', renewal_count: 12, document_count: 12 }),
      ],
    );
    expect(rows.map((r) => r.owner_key)).toEqual(['b', 'a']);
  });
});

describe('routeRecipient', () => {
  it('prefers the portal user, whose address follows them', () => {
    const who = routeRecipient(
      route({ user_id: 'u1', email: null, user_name: 'Chris', user_email: 'chris@example.com' }),
    );
    expect(who).toEqual({ name: 'Chris', email: 'chris@example.com', isUser: true });
  });

  it('reports a bare address as exactly that', () => {
    const who = routeRecipient(route({ user_id: null, email: 'broker@agency.example' }));
    expect(who.isUser).toBe(false);
    expect(who.email).toBe('broker@agency.example');
  });
});

describe('OwnerRoutingPanel', () => {
  it('leads with the labels found on documents, not an empty text box', async () => {
    listRoutes.mockResolvedValue({
      routes: [],
      labels_in_use: [
        label({ owner_key: 'insurance', owner_label: 'Insurance', document_count: 12, renewal_count: 4 }),
      ],
    });
    render(<OwnerRoutingPanel />);

    expect(await screen.findByText('Insurance')).toBeInTheDocument();
    expect(screen.getByText(/12 documents, 4 with renewal terms/)).toBeInTheDocument();
  });

  it('says plainly that an unrouted label means nobody is emailed', async () => {
    listRoutes.mockResolvedValue({
      routes: [],
      labels_in_use: [label({ owner_key: 'insurance', owner_label: 'Insurance' })],
    });
    render(<OwnerRoutingPanel />);

    expect(
      await screen.findByText(/Nobody is routed/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/no alert is sent/i)).toBeInTheDocument();
    // The call to action is on the row, not somewhere else.
    expect(screen.getByRole('button', { name: 'Set recipient' })).toBeInTheDocument();
  });

  it('renders a configured label as a sentence, marking an account-less recipient', async () => {
    listRoutes.mockResolvedValue({
      routes: [route({ user_id: null, email: 'broker@agency.example' })],
      labels_in_use: [label({ route_count: 1 })],
    });
    render(<OwnerRoutingPanel />);

    expect(await screen.findByText('alerts go to')).toBeInTheDocument();
    expect(screen.getByText('broker@agency.example (no portal account)')).toBeInTheDocument();
  });

  it('offers a bare email address as a visible option, not a hidden one', async () => {
    const user = userEvent.setup();
    listRoutes.mockResolvedValue({
      routes: [],
      labels_in_use: [label({ owner_key: 'insurance', owner_label: 'Insurance' })],
    });
    render(<OwnerRoutingPanel />);

    await user.click(await screen.findByRole('button', { name: 'Set recipient' }));

    // Both routes to a recipient are on screen at once.
    expect(await screen.findByText(/Somebody with a portal account/i)).toBeInTheDocument();
    expect(screen.getByText(/no account needed, the usual choice for a broker/i)).toBeInTheDocument();
  });

  it('creates a route to a bare address, carrying the label from the row', async () => {
    const user = userEvent.setup();
    listRoutes.mockResolvedValue({
      routes: [],
      labels_in_use: [label({ owner_key: 'insurance', owner_label: 'Insurance' })],
    });
    createRoute.mockResolvedValue({ route: route({}) });
    render(<OwnerRoutingPanel />);

    await user.click(await screen.findByRole('button', { name: 'Set recipient' }));
    await user.click(await screen.findByRole('radio', { name: /An email address/i }));
    await user.type(screen.getByLabelText('Email address'), 'broker@agency.example');
    await user.click(screen.getByRole('button', { name: 'Add recipient' }));

    await waitFor(() =>
      expect(createRoute).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerLabel: 'Insurance',
          email: 'broker@agency.example',
          userId: undefined,
        }),
      ),
    );
  });

  it('explains the empty case instead of showing a blank page', async () => {
    render(<OwnerRoutingPanel />);
    expect(await screen.findByText('No owner labels yet')).toBeInTheDocument();
  });

  it('survives a server that has not been redeployed with labels_in_use', async () => {
    // Defensive: an older worker returns only { routes }. The panel should
    // still render the configured routes rather than throwing.
    listRoutes.mockResolvedValue({ routes: [route({})] });
    render(<OwnerRoutingPanel />);
    expect(await screen.findByText('QA')).toBeInTheDocument();
  });
});
