/**
 * Settings › API Keys — expiry, with a pinned clock.
 *
 *   1. The status badge uses the shared rule: a legacy date-only expiry of
 *      TODAY is Active (it works through the end of the day), yesterday is
 *      Expired, and the row says exactly when in words.
 *   2. The create form does not default to a date, will not submit a past
 *      date, and sends the END of the picked day in the admin's own time zone
 *      rather than a bare date the server would have to guess a zone for.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ApiKey } from '../../lib/types';
import { endOfLocalDayIso, localDateString } from '../../../shared/apiKeyExpiry';

const listKeys = vi.fn();
const createKey = vi.fn();
const listTenants = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'org_admin', tenant_id: 't1' }, isSuperAdmin: false }),
}));
vi.mock('../../lib/api', () => ({
  api: {
    apiKeys: {
      list: (...args: unknown[]) => listKeys(...args),
      create: (...args: unknown[]) => createKey(...args),
      revoke: vi.fn(),
    },
    tenants: { list: (...args: unknown[]) => listTenants(...args) },
  },
}));

import { ApiKeys, describeApiKeyExpiry } from './ApiKeys';

// Midday UTC on 2026-09-15 is 2026-09-15 on the local calendar for any runner
// between UTC-11 and UTC+11.
const NOW = new Date('2026-09-15T12:00:00.000Z');
const clock = () => NOW;

function key(over: Partial<ApiKey>): ApiKey {
  return {
    id: 'k1',
    name: 'Key',
    key_prefix: 'dox_sk_abcde',
    user_id: 'u1',
    tenant_id: 't1',
    permissions: '["*"]',
    last_used_at: null,
    expires_at: null,
    revoked: 0,
    created_at: '2026-09-01 10:00:00',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listTenants.mockResolvedValue([{ id: 't1', name: 'Tenant One' }]);
  listKeys.mockResolvedValue([]);
});

describe('describeApiKeyExpiry', () => {
  it('names the UTC end of day for a legacy date-only expiry', () => {
    expect(describeApiKeyExpiry('2026-09-15', NOW)).toMatch(/^Expires at the end of .*2026 \(UTC\)$/);
    expect(describeApiKeyExpiry('2026-09-14', NOW)).toMatch(/^Expired at the end of/);
    expect(describeApiKeyExpiry(null, NOW)).toBe('Never expires');
  });
});

describe('ApiKeys status badges', () => {
  it("shows a date-only expiry of today as Active and yesterday's as Expired", async () => {
    listKeys.mockResolvedValue([
      key({ id: 'today', name: 'Today key', expires_at: '2026-09-15' }),
      key({ id: 'yesterday', name: 'Yesterday key', expires_at: '2026-09-14' }),
    ]);
    render(<ApiKeys now={clock} />);

    const todayRow = (await screen.findByText('Today key')).closest('tr')!;
    const yesterdayRow = screen.getByText('Yesterday key').closest('tr')!;
    expect(within(todayRow).getByText('Active')).toBeInTheDocument();
    expect(within(todayRow).getByText(/Expires at the end of/)).toBeInTheDocument();
    expect(within(yesterdayRow).getByText('Expired')).toBeInTheDocument();
    // An expired key offers no revoke button; a live one does.
    expect(within(todayRow).queryByRole('button', { name: 'Revoke' })).not.toBeNull();
    expect(within(yesterdayRow).queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});

describe('ApiKeys create form expiry', () => {
  async function openCreate() {
    render(<ApiKeys now={clock} />);
    const [button] = await screen.findAllByRole('button', { name: /create key/i });
    await userEvent.click(button);
    await userEvent.type(screen.getByLabelText(/^Name/), 'Seed key');
    return screen.getByTestId('api-key-expires-at') as HTMLInputElement;
  }

  const submit = () => {
    const buttons = screen.getAllByRole('button', { name: /^create key$/i });
    return buttons[buttons.length - 1];
  };

  it('defaults to no expiry, forbids past dates in the picker, and says so', async () => {
    const input = await openCreate();
    expect(input.value).toBe('');
    expect(input.min).toBe(localDateString(NOW));
    expect(screen.getByText('Leave empty for a key that never expires.')).toBeInTheDocument();
  });

  it('will not submit a past date', async () => {
    const input = await openCreate();
    fireEvent.change(input, { target: { value: '2026-09-14' } });
    expect(await screen.findByText(/already passed/)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });

  it("sends the end of today in the admin's time zone when today is picked", async () => {
    createKey.mockResolvedValue({ apiKey: key({}), key: 'dox_sk_secret' });
    const input = await openCreate();
    const today = localDateString(NOW);
    fireEvent.change(input, { target: { value: today } });
    expect(screen.getByText(/Works through the end of .*11:59 PM/)).toBeInTheDocument();

    await userEvent.click(submit());
    await waitFor(() => expect(createKey).toHaveBeenCalledTimes(1));
    expect(createKey.mock.calls[0][0]).toMatchObject({
      name: 'Seed key',
      expiresAt: endOfLocalDayIso(today),
    });
  });
});
