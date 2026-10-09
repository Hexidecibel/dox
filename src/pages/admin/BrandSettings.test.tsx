/**
 * Settings > Brand (migration 0140).
 *
 * The screen exists so an admin SEES what a supplier or customer will see
 * before it is saved -- the support line is the one field of this record a
 * person could regret. So: the preview follows the draft, nothing is saved
 * until Save, a bad colour cannot be saved at all, and a pale colour is
 * explained rather than refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { TenantBrandResponse } from '../../../shared/types';

const get = vi.fn();
const put = vi.fn();
const uploadLogo = vi.fn();
const removeLogo = vi.fn();
let tenant: { selectedTenantId: string | null } = { selectedTenantId: 't1' };

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', role: 'org_admin', tenant_id: 't1' } }),
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => tenant,
}));
vi.mock('../../lib/api', () => ({
  api: {
    tenantBrand: {
      get: (...a: unknown[]) => get(...a),
      put: (...a: unknown[]) => put(...a),
      uploadLogo: (...a: unknown[]) => uploadLogo(...a),
      removeLogo: (...a: unknown[]) => removeLogo(...a),
    },
  },
}));

import { BrandSettings } from './BrandSettings';

const LOGO = `/api/public/brand-logo/${'ab12'.repeat(10)}`;

const record = (over: Partial<TenantBrandResponse> = {}): TenantBrandResponse => ({
  tenant_id: 't1',
  tenant_name: 'Northfield Provisions LLC',
  configured: false,
  display_name: null,
  primary_color: null,
  accent_color: null,
  support: { text: null, email: null, phone: null },
  support_overrides: {},
  logo: null,
  updated_at: null,
  updated_by_name: null,
  ...over,
});

const bg = (el: Element) => getComputedStyle(el).backgroundColor.replace(/\s+/g, '').toLowerCase();
const isColor = (value: string, hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return value === hex.toLowerCase() || value === `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
};

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  uploadLogo.mockReset();
  removeLogo.mockReset();
  tenant = { selectedTenantId: 't1' };
});

describe('Settings > Brand', () => {
  it('a tenant with no brand: says so, previews the organisation name in the navy, and has nothing to save', async () => {
    get.mockResolvedValue(record());
    render(<BrandSettings />);
    expect(await screen.findByText(/Nothing is set yet/)).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('t1');
    const page = screen.getByTestId('brand-preview-page');
    expect(within(page).getByTestId('brand-name')).toHaveTextContent('Northfield Provisions LLC');
    expect(isColor(bg(within(page).getByTestId('brand-header')), '#1A365D')).toBe(true);
    expect(screen.getByTestId('brand-save')).toBeDisabled();
    expect(screen.queryByTestId('brand-contrast')).toBeNull();
    expect(screen.getByText('No logo')).toBeInTheDocument();
  });

  it('the preview follows the draft, and nothing is sent until Save', async () => {
    get.mockResolvedValue(record());
    const user = userEvent.setup();
    render(<BrandSettings />);
    await screen.findByTestId('brand-settings');

    await user.type(screen.getByTestId('brand-display-name'), 'Northfield Foods');
    await user.type(screen.getByTestId('brand-primary-color'), '#0b6e4f');
    await user.type(screen.getByTestId('brand-support-text'), 'Questions? Ask Purchasing');
    await user.type(screen.getByTestId('brand-support-email'), 'purchasing@northfield.example');

    const page = screen.getByTestId('brand-preview-page');
    expect(within(page).getByTestId('brand-name')).toHaveTextContent('Northfield Foods');
    expect(isColor(bg(within(page).getByTestId('brand-header')), '#0B6E4F')).toBe(true);
    expect(within(page).getByTestId('brand-support').textContent).toBe(
      'Northfield Foods · Questions? Ask Purchasing · purchasing@northfield.example',
    );
    expect(within(screen.getByTestId('brand-preview-mail')).getByText('Northfield Foods', { selector: 'div' })).toBeInTheDocument();
    expect(screen.getByTestId('brand-contrast').textContent).toMatch(/drawn in white \(contrast \d+\.\d:1\)/);
    expect(screen.getByText(/Not saved yet/)).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();

    put.mockResolvedValue(
      record({
        configured: true,
        display_name: 'Northfield Foods',
        primary_color: '#0B6E4F',
        support: { text: 'Questions? Ask Purchasing', email: 'purchasing@northfield.example', phone: null },
      }),
    );
    await user.click(screen.getByTestId('brand-save'));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put).toHaveBeenCalledWith('t1', {
      display_name: 'Northfield Foods',
      primary_color: '#0b6e4f',
      accent_color: null,
      support: { text: 'Questions? Ask Purchasing', email: 'purchasing@northfield.example', phone: null },
      support_overrides: {},
    });
    expect(await screen.findByText(/Saved\./)).toBeInTheDocument();
    expect(screen.getByTestId('brand-save')).toBeDisabled();
    // The stored, normalised colour is what the field now shows.
    expect(screen.getByTestId('brand-primary-color')).toHaveValue('#0B6E4F');
  });

  it('a colour that is not #RRGGBB is said to be wrong, is not previewed, and cannot be saved', async () => {
    get.mockResolvedValue(record({ configured: true, primary_color: '#0B6E4F' }));
    const user = userEvent.setup();
    render(<BrandSettings />);
    const field = await screen.findByTestId('brand-primary-color');
    await user.clear(field);
    await user.type(field, 'red');
    expect(screen.getByText('Use a six-digit hex colour such as #1A365D')).toBeInTheDocument();
    expect(isColor(bg(within(screen.getByTestId('brand-preview-page')).getByTestId('brand-header')), '#1A365D')).toBe(true);
    expect(screen.getByTestId('brand-save')).toBeDisabled();
  });

  it('a pale colour is explained, not refused: black text on the band, links stay navy', async () => {
    get.mockResolvedValue(record({ configured: true, primary_color: '#FFE08A' }));
    render(<BrandSettings />);
    expect((await screen.findByTestId('brand-contrast')).textContent).toMatch(/drawn in black/);
    expect(screen.getByTestId('brand-pale-warning').textContent).toMatch(/too pale to read as text on a white page/);
    expect(screen.getByTestId('brand-pale-warning').textContent).toMatch(/links and small headings stay navy/);
  });

  it('a line set for one page replaces the default line on that page only', async () => {
    get.mockResolvedValue(
      record({
        configured: true,
        support: { text: 'Questions? Ask Purchasing', email: 'purchasing@northfield.example', phone: '555 0100' },
        support_overrides: { order_send: { text: 'Order desk', email: null, phone: null } },
      }),
    );
    const user = userEvent.setup();
    render(<BrandSettings />);
    const page = await screen.findByTestId('brand-preview-page');
    // Default preview surface: supplier requests -> the default line.
    expect(within(page).getByTestId('brand-support').textContent).toContain('Questions? Ask Purchasing');

    await user.selectOptions(screen.getByTestId('brand-preview-surface'), 'order_send');
    expect(within(page).getByTestId('brand-support').textContent).toBe('Northfield Provisions LLC · Order desk');
    // ...and the default phone did not leak into the override.
    expect(within(page).getByTestId('brand-support').textContent).not.toContain('555 0100');

    // Saving sends only the overrides that hold something.
    await user.click(screen.getByTestId('brand-overrides-toggle'));
    await user.type(screen.getByTestId('brand-override-alert-text'), 'QA desk');
    put.mockResolvedValue(record({ configured: true }));
    await user.click(screen.getByTestId('brand-save'));
    await waitFor(() => expect(put).toHaveBeenCalled());
    expect(put.mock.calls[0][1].support_overrides).toEqual({
      order_send: { text: 'Order desk', email: null, phone: null },
      alert: { text: 'QA desk', email: null, phone: null },
    });
  });

  it('a logo uploads at once, is previewed from our own address, and can be removed', async () => {
    get.mockResolvedValue(record({ configured: true }));
    const withLogo = record({
      configured: true,
      logo: { url: LOGO, content_type: 'image/png', size_bytes: 2000, width: 320, height: 96, uploaded_at: '2026-10-08 12:00:00' },
    });
    uploadLogo.mockResolvedValue(withLogo);
    removeLogo.mockResolvedValue(record({ configured: true }));
    const user = userEvent.setup();
    render(<BrandSettings />);
    const input = await screen.findByTestId('brand-logo-input');
    expect(input).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp');

    const file = new File([new Uint8Array(2000)], 'logo.png', { type: 'image/png' });
    await user.upload(input, file);
    await waitFor(() => expect(uploadLogo).toHaveBeenCalledWith('t1', file));
    expect(await screen.findByTestId('brand-logo-preview')).toHaveAttribute('src', LOGO);
    expect(within(screen.getByTestId('brand-preview-page')).getByTestId('brand-logo')).toHaveAttribute('src', LOGO);
    expect(screen.getByText(/Current: 320 x 96 px/)).toBeInTheDocument();

    await user.click(screen.getByTestId('brand-logo-remove'));
    await waitFor(() => expect(removeLogo).toHaveBeenCalledWith('t1'));
    await waitFor(() => expect(screen.queryByTestId('brand-logo-preview')).toBeNull());
  });

  it('an oversize file is refused before it is sent, and a server refusal is shown', async () => {
    get.mockResolvedValue(record({ configured: true }));
    const user = userEvent.setup();
    render(<BrandSettings />);
    const input = await screen.findByTestId('brand-logo-input');
    await user.upload(input, new File([new Uint8Array(512 * 1024 + 1)], 'big.png', { type: 'image/png' }));
    expect(await screen.findByText(/too large \(512 KB at most\)/)).toBeInTheDocument();
    expect(uploadLogo).not.toHaveBeenCalled();

    uploadLogo.mockRejectedValue(new Error('The logo must be a PNG, JPEG or WebP image (SVG is not accepted)'));
    await user.upload(input, new File(['<svg/>'], 'logo.png', { type: 'image/png' }));
    expect(await screen.findByText(/must be a PNG, JPEG or WebP image/)).toBeInTheDocument();
  });

  it('a super admin with no organization chosen is asked to choose one', async () => {
    tenant = { selectedTenantId: null };
    vi.doMock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 's1', role: 'super_admin', tenant_id: null } }) }));
    vi.resetModules();
    const { BrandSettings: Fresh } = await import('./BrandSettings');
    render(<Fresh />);
    expect(await screen.findByText(/Choose an organization/)).toBeInTheDocument();
    expect(get).not.toHaveBeenCalled();
  });
});
