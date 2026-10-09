/**
 * The tenant brand on the pages outsiders open (migration 0140).
 *
 *   1. NO BRAND IS THE PAGE AS IT WAS: the organisation name in the navy, no
 *      band, no logo, no support line.
 *   2. A brand draws the band, the logo, the display name and the support line
 *      for that page -- and a tenant colour is never applied to body text.
 *   3. Whatever is in the payload is drawn as TEXT. A name with a script tag
 *      in it is a name with a script tag in it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BrandHeader, BrandSupport } from './BrandHeader';
import { ExportLanding } from '../../pages/ExportLanding';
import { SupplierRequestPortal } from '../../pages/supplier/RequestPortal';
import type { DocumentExportLandingView, PublicBrand, SupplierRequestView } from '../../../shared/types';

const LOGO = `/api/public/brand-logo/${'ab12'.repeat(10)}`;

const brand = (over: Partial<PublicBrand> = {}): PublicBrand => ({
  display_name: 'Northfield Foods',
  logo_url: LOGO,
  primary_color: '#0B6E4F',
  accent_color: '#F2A900',
  support: { text: 'Questions? Ask Purchasing', email: 'purchasing@northfield.example', phone: '555 0100' },
  ...over,
});

/** happy-dom reports colours as written; normalise the two spellings. */
const rgb = (el: Element, prop: 'color' | 'backgroundColor') => getComputedStyle(el)[prop].replace(/\s+/g, '').toLowerCase();
const isColor = (value: string, hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return value === hex.toLowerCase() || value === `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
};

function stubFetch(payload: unknown, status = 200) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrandHeader / BrandSupport', () => {
  it('no brand: the children, and nothing else', () => {
    const { container } = render(
      <BrandHeader brand={null}>
        <span>Plain Corp</span>
      </BrandHeader>,
    );
    expect(container.innerHTML).toBe('<span>Plain Corp</span>');
    expect(render(<BrandSupport brand={null} />).container.innerHTML).toBe('');
    expect(render(<BrandSupport brand={undefined} />).container.innerHTML).toBe('');
  });

  it('a brand: the band in the primary colour with readable text, the logo, the name', () => {
    render(
      <BrandHeader brand={brand()}>
        <span>never drawn</span>
      </BrandHeader>,
    );
    expect(screen.queryByText('never drawn')).toBeNull();
    const band = screen.getByTestId('brand-header');
    expect(isColor(rgb(band, 'backgroundColor'), '#0B6E4F')).toBe(true);
    expect(isColor(rgb(band, 'color'), '#ffffff')).toBe(true);
    expect(screen.getByTestId('brand-name')).toHaveTextContent('Northfield Foods');
    const logo = screen.getByTestId('brand-logo');
    expect(logo).toHaveAttribute('src', LOGO);
    expect(logo).toHaveAttribute('alt', 'Northfield Foods logo');
  });

  it('a pale primary gets black text on the band', () => {
    render(<BrandHeader brand={brand({ primary_color: '#FFE08A', logo_url: null })} />);
    const band = screen.getByTestId('brand-header');
    expect(isColor(rgb(band, 'backgroundColor'), '#FFE08A')).toBe(true);
    expect(isColor(rgb(band, 'color'), '#000000')).toBe(true);
    expect(screen.queryByTestId('brand-logo')).toBeNull();
  });

  it('a colour that is not a colour is the navy; a logo that is not the logo route is not drawn', () => {
    render(
      <BrandHeader
        brand={brand({ primary_color: 'red; background:url(//evil.example/x)', logo_url: 'https://evil.example/pixel.png' })}
      />,
    );
    expect(isColor(rgb(screen.getByTestId('brand-header'), 'backgroundColor'), '#1A365D')).toBe(true);
    expect(screen.queryByTestId('brand-logo')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('a hostile name and support line are drawn as text, never as elements', () => {
    const hostile = brand({
      display_name: `<script>window.__pwned = 1</script><img src=x onerror="window.__pwned = 1">`,
      logo_url: null,
      support: { text: `"><b id="injected">bold</b>`, email: null, phone: null },
    });
    const { container } = render(
      <>
        <BrandHeader brand={hostile} />
        <BrandSupport brand={hostile} />
      </>,
    );
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('#injected')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByTestId('brand-name').textContent).toBe(hostile.display_name);
    expect(screen.getByTestId('brand-support').textContent).toContain(`"><b id="injected">bold</b>`);
  });

  it('the support line: name, sentence, a mailto link, the phone; nothing when none is set', () => {
    render(<BrandSupport brand={brand()} />);
    const line = screen.getByTestId('brand-support');
    expect(line.textContent).toBe('Northfield Foods · Questions? Ask Purchasing · purchasing@northfield.example · 555 0100');
    expect(screen.getByRole('link', { name: 'purchasing@northfield.example' })).toHaveAttribute('href', 'mailto:purchasing@northfield.example');
    expect(render(<BrandSupport brand={brand({ support: null })} />).container.innerHTML).toBe('');
    expect(render(<BrandSupport brand={brand({ support: { text: null, email: null, phone: null } })} />).container.innerHTML).toBe('');
  });
});

// ---------------------------------------------------------------------------
// /export/:token
// ---------------------------------------------------------------------------

const exportView = (over: Partial<DocumentExportLandingView> = {}): DocumentExportLandingView => ({
  tenant_name: 'Northfield Provisions LLC',
  sent_by_name: 'Dana Whitlow',
  sent_by_email: 'dana@northfield.example',
  on_behalf_of: null,
  message: 'As requested.',
  expires_at: '2026-11-01T00:00:00Z',
  documents: [
    { index: 0, title: 'COA Lot 24117', supplier_name: 'Harbor Mills', document_type_name: 'COA', lot_label: '24117', production_date: null, file_name: 'coa.pdf', file_size: 1200 } as never,
  ],
  unavailable_count: 0,
  ...over,
});

function renderExport() {
  return render(
    <MemoryRouter initialEntries={['/export/tok']}>
      <Routes>
        <Route path="/export/:token" element={<ExportLanding />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('/export/:token', () => {
  it('no brand: the organisation name in the navy, no band, no logo, no support line', async () => {
    stubFetch(exportView());
    renderExport();
    const name = await screen.findByText('Northfield Provisions LLC');
    expect(isColor(rgb(name, 'color'), '#1A365D')).toBe(true);
    expect(screen.queryByTestId('brand-header')).toBeNull();
    expect(screen.queryByTestId('brand-logo')).toBeNull();
    expect(screen.queryByTestId('brand-support')).toBeNull();
    expect(isColor(rgb(screen.getByTestId('export-landing-zip'), 'backgroundColor'), '#1A365D')).toBe(true);
    await waitFor(() => expect(document.title).toBe('1 document from Northfield Provisions LLC'));
  });

  it('a brand: the band, the logo, the display name, the button in the brand colour, the support line', async () => {
    stubFetch(exportView({ brand: brand() }));
    renderExport();
    expect(await screen.findByTestId('brand-name')).toHaveTextContent('Northfield Foods');
    expect(screen.getByTestId('brand-logo')).toHaveAttribute('src', LOGO);
    // The legal name is replaced by what outsiders are meant to read.
    expect(screen.queryByText('Northfield Provisions LLC')).toBeNull();
    expect(isColor(rgb(screen.getByTestId('export-landing-zip'), 'backgroundColor'), '#0B6E4F')).toBe(true);
    expect(screen.getByTestId('brand-support').textContent).toContain('Questions? Ask Purchasing');
    await waitFor(() => expect(document.title).toBe('1 document from Northfield Foods'));
    // Body text keeps its own colour: the document title is not painted.
    const title = screen.getByText('COA Lot 24117');
    expect(isColor(rgb(title, 'color'), '#0B6E4F')).toBe(false);
    expect(isColor(rgb(title, 'color'), '#F2A900')).toBe(false);
  });

  it('a pale brand colour: the band is pale with black on it, but the button stays readable navy', async () => {
    stubFetch(exportView({ brand: brand({ primary_color: '#FFE08A', accent_color: null }) }));
    renderExport();
    const band = await screen.findByTestId('brand-header');
    expect(isColor(rgb(band, 'backgroundColor'), '#FFE08A')).toBe(true);
    expect(isColor(rgb(band, 'color'), '#000000')).toBe(true);
    expect(isColor(rgb(screen.getByTestId('export-landing-zip'), 'backgroundColor'), '#1A365D')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /r/:token
// ---------------------------------------------------------------------------

const requestView = (over: Partial<SupplierRequestView> = {}): SupplierRequestView => ({
  tenant_name: 'Northfield Provisions LLC',
  supplier_name: 'Harbor Mills',
  title: 'Annual supplier documentation',
  intro: null,
  due_date: '2026-12-01',
  issued_at: '2026-10-01T00:00:00Z',
  amended: false,
  items: [],
  progress: { required_total: 0, required_satisfied: 0, recommended_total: 0, recommended_satisfied: 0 } as never,
  complete: false,
  history: [],
  accepting_uploads: true,
  link_expires_at: '2026-12-31T00:00:00Z',
  ...over,
});

function renderPortal() {
  return render(
    <MemoryRouter initialEntries={['/r/tok']}>
      <Routes>
        <Route path="/r/:token" element={<SupplierRequestPortal />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('/r/:token', () => {
  it('no brand: "<organisation> — document request" in the navy, and nothing added', async () => {
    stubFetch(requestView());
    renderPortal();
    const line = await screen.findByText('Northfield Provisions LLC — document request');
    expect(isColor(rgb(line, 'color'), '#1A365D')).toBe(true);
    expect(screen.queryByTestId('brand-header')).toBeNull();
    expect(screen.queryByTestId('brand-support')).toBeNull();
    expect(document.querySelector('img')).toBeNull();
  });

  it('a brand: the band and logo, the display name in the request line, the supplier support line', async () => {
    stubFetch(
      requestView({
        brand: brand({ support: { text: 'Supplier desk', email: 'suppliers@northfield.example', phone: null } }),
      }),
    );
    renderPortal();
    const line = await screen.findByText('Northfield Foods — document request');
    expect(isColor(rgb(line, 'color'), '#0B6E4F')).toBe(true);
    expect(screen.getByTestId('brand-header')).toBeInTheDocument();
    expect(screen.getByTestId('brand-logo')).toHaveAttribute('src', LOGO);
    expect(screen.getByTestId('brand-support').textContent).toBe('Northfield Foods · Supplier desk · suppliers@northfield.example');
    expect(screen.queryByText(/Northfield Provisions LLC/)).toBeNull();
    // The title of the ask is body text and is not painted.
    expect(isColor(rgb(screen.getByText('Annual supplier documentation'), 'color'), '#0B6E4F')).toBe(false);
  });
});
