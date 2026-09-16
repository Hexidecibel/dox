/**
 * The anti-drift lock.
 *
 * `SURFACES` replaced ~60 hand-written `<Route>` elements in `src/App.tsx`.
 * A route dropped in that translation is a 404 nobody notices until a customer
 * finds it, and no type checks it: the compiler is perfectly happy with a
 * shorter array. So the path set of today's App.tsx is checked in below,
 * verbatim, and asserted against what the table emits. This snapshot is the
 * only thing standing between that refactor and a silently deleted surface.
 *
 * WHY IT LIVES UNDER src/ RATHER THAN tests/unit/. `vitest.config.mts` runs
 * `tests/**` inside the Cloudflare Workers pool, which has no DOM: importing
 * `surfaces.tsx` there pulls in the page components and dies in `pdfjs-dist`
 * with `ReferenceError: DOMMatrix is not defined` before a single assertion
 * runs. The `frontend` project (happy-dom, `src/**\/*.test.{ts,tsx}`) exists
 * for exactly this, and every other component-level test in this repo is
 * already there.
 *
 * CHANGING THE SNAPSHOT IS ALLOWED — DELETING A LINE BY ACCIDENT IS NOT. When
 * a surface is genuinely added or retired, edit `ROUTE_SNAPSHOT` in the same
 * commit and the diff shows a reviewer exactly which URL changed.
 */

import { describe, it, expect } from 'vitest';
import { SURFACES, navGroupsForRole, navLabelsForModule, pinnedNavSurfaces } from './surfaces';
import appSource from '../App.tsx?raw';
import { MODULE_KEYS, MODULES, moduleForUiPath } from '../../shared/modules';
import type { ModuleKey } from '../../shared/modules';
import type { Role } from './types';

/**
 * Every `<Route path=...>` in `src/App.tsx` at commit caa3e5e, in source
 * order. 65 paths: 53 surfaces inside the authenticated shell, 10 public
 * no-shell routes, and the two redirects.
 *
 * Added since: `/setup` and `/setup/:step` (the first-run wizard) and
 * `/export/:token` (documents sent out of search, migration 0115).
 */
const ROUTE_SNAPSHOT: readonly string[] = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/f/:slug',
  '/u/:token',
  '/a/:token',
  '/alert/:token',
  // Documents sent out of search (migration 0115): the recipient is a customer
  // or a salesperson with no account, so this is a no-shell landing like the
  // alert page above, not a surface.
  '/export/:token',
  '/r/:token',
  '/drop/:slug/:token',
  '/docs/connectors',
  '/dashboard',
  '/documents',
  '/documents/new',
  '/documents/:id',
  '/search',
  '/profile',
  '/bundles',
  '/bundles/:id',
  '/ingest-history',
  '/activity',
  '/import',
  '/review',
  '/orders',
  '/orders/:id',
  '/lots',
  '/requests',
  '/requests/templates',
  // Added with migration 0104: what suppliers sent back through their links.
  '/requests/arrivals',
  '/requests/new',
  '/requests/:id',
  '/reports',
  '/expirations',
  '/records',
  '/records/:sheetId',
  '/records/:sheetId/forms/:formId',
  '/records/:sheetId/workflows/:workflowId',
  '/approvals',
  '/help',
  '/help/:module',
  '/settings',
  '/settings/:section',
  // Added deliberately with the first-run setup wizard: two surfaces, both
  // admin-gated, neither with a nav entry.
  '/setup',
  '/setup/:step',
  '/spec-alerts',
  '/admin/users',
  '/admin/api-keys',
  '/admin/audit',
  '/admin/document-types',
  '/admin/requirements',
  '/admin/claim-types',
  '/admin/claim-rules',
  '/admin/products',
  '/admin/products/:id',
  '/admin/suppliers',
  '/admin/suppliers/:id',
  '/admin/sources',
  '/admin/sources/new',
  '/admin/sources/:id/edit',
  '/admin/sources/:id',
  '/admin/customers',
  '/admin/customers/:id',
  '/admin/learning-dashboard',
  '/admin/tenants',
  '/admin/processing-status',
  '/',
  '*',
];

/**
 * The paths that are deliberately NOT surfaces and stay hand-written in
 * App.tsx: the unauthenticated, no-shell pages (token-gated landings, public
 * forms, login) and the two redirects. They are outside the authenticated
 * shell, have no nav entry and no module, so putting them in the table would
 * mean inventing fields that mean nothing for them.
 */
const NON_SURFACE_PATHS: readonly string[] = [
  '/login',
  '/forgot-password',
  '/reset-password',
  '/f/:slug',
  '/u/:token',
  '/a/:token',
  '/alert/:token',
  '/export/:token',
  '/r/:token',
  '/drop/:slug/:token',
  '/docs/connectors',
  '/',
  '*',
];

const ALL_ROLES: Role[] = ['super_admin', 'org_admin', 'user', 'reader'];

const sorted = (paths: readonly string[]): string[] => [...paths].sort();

describe('SURFACES — the path-set snapshot', () => {
  it('emits exactly the routes App.tsx had before the refactor', () => {
    const emitted = sorted([...SURFACES.map((s) => s.path), ...NON_SURFACE_PATHS]);
    const expected = sorted(ROUTE_SNAPSHOT);

    // Report the two directions separately: a dropped route and an invented
    // one are different bugs and a bare set-equality failure hides which.
    const dropped = expected.filter((p) => !emitted.includes(p));
    const added = emitted.filter((p) => !expected.includes(p));
    expect(dropped, 'routes present before the refactor and missing now').toEqual([]);
    expect(added, 'routes that did not exist before the refactor').toEqual([]);

    expect(emitted).toEqual(expected);
  });

  it('accounts for every snapshot path exactly once', () => {
    expect(ROUTE_SNAPSHOT.length).toBe(67);
    expect(new Set(ROUTE_SNAPSHOT).size).toBe(ROUTE_SNAPSHOT.length);
    expect(SURFACES.length).toBe(ROUTE_SNAPSHOT.length - NON_SURFACE_PATHS.length);
  });

  it('declares each path once', () => {
    const paths = SURFACES.map((s) => s.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('gives every surface an element', () => {
    for (const surface of SURFACES) {
      expect(surface.element, surface.path).toBeTruthy();
    }
  });

  it('only ever names real roles, and never an empty tier', () => {
    for (const surface of SURFACES) {
      if (surface.roles === undefined) continue;
      expect(surface.roles.length, surface.path).toBeGreaterThan(0);
      for (const role of surface.roles) {
        expect(ALL_ROLES, surface.path).toContain(role);
      }
    }
  });

  it('gates each path at the tier it was gated at before, bar the four fixes', () => {
    // The path snapshot proves nothing was DROPPED; this proves nothing was
    // silently WIDENED. Both directions matter and neither is type-checked:
    // deleting a `roles` line compiles perfectly and opens a surface up.
    const tier = (path: string): string => {
      const roles = SURFACES.find((s) => s.path === path)?.roles;
      return roles ? roles.join('+') : '(any authenticated role)';
    };
    const at = (expected: string): string[] =>
      SURFACES.filter((s) => tier(s.path) === expected)
        .map((s) => s.path)
        .sort();

    expect(at('super_admin')).toEqual(['/admin/processing-status', '/admin/tenants']);

    expect(at('super_admin+org_admin')).toEqual([
      '/admin/api-keys',
      '/admin/audit',
      '/admin/claim-rules',
      '/admin/claim-types',
      '/admin/customers',
      '/admin/customers/:id',
      '/admin/document-types',
      '/admin/learning-dashboard',
      '/admin/products',
      '/admin/products/:id',
      '/admin/requirements',
      '/admin/sources',
      '/admin/sources/:id',
      '/admin/sources/:id/edit',
      '/admin/sources/new',
      '/admin/suppliers',
      '/admin/suppliers/:id',
      '/admin/users',
      '/requests/new',
      '/settings',
      '/settings/:section',
      '/setup',
      '/setup/:step',
    ]);

    expect(at('super_admin+org_admin+user')).toEqual([
      // /import, /review and /spec-alerts are the three drift fixes; the rest
      // carried their tier over from App.tsx unchanged.
      '/documents/new',
      '/expirations',
      '/import',
      '/reports',
      '/review',
      '/spec-alerts',
    ]);
  });

  it('leaves App.tsx with no hand-written route outside the non-surface set', () => {
    // The whole point of the table is that App.tsx stops being a second list.
    // A `<Route path="...">` typed straight into App.tsx would be invisible to
    // every assertion above, so catch it in the source.
    const literals = [...appSource.matchAll(/<Route\s[^>]*path="([^"]+)"/g)].map((m) => m[1]);
    expect(sorted(literals)).toEqual(sorted(NON_SURFACE_PATHS));
  });
});

describe('SURFACES — module agreement', () => {
  it('declares the module shared/modules.ts already resolves for the path', () => {
    for (const surface of SURFACES) {
      // `moduleForUiPath` is the single encoding of the prefix mapping; this
      // table restates the answer per surface only so it can be read at a
      // glance. The two must never disagree — if they do, either a surface
      // moved or a prefix did, and both need a human.
      expect(moduleForUiPath(surface.path), surface.path).toBe(surface.module);
    }
  });

  it('never lets two modules claim overlapping UI prefixes', () => {
    const owned: { key: string; prefix: string }[] = MODULE_KEYS.flatMap((key) =>
      MODULES[key].uiPrefixes.map((prefix) => ({ key, prefix }))
    );

    for (const a of owned) {
      for (const b of owned) {
        if (a === b) continue;
        expect(a.prefix, `${a.key} and ${b.key} both claim ${a.prefix}`).not.toBe(b.prefix);
        // Whole-segment containment is the dangerous case: `/orders` owning
        // `/orders/archive` would make longest-prefix silently re-home a
        // surface the moment a second module claimed the deeper path.
        if (a.key !== b.key) {
          expect(
            b.prefix.startsWith(`${a.prefix}/`),
            `${b.key}'s ${b.prefix} sits inside ${a.key}'s ${a.prefix}`
          ).toBe(false);
        }
      }
    }
  });
});

describe('SURFACES — the nav rail', () => {
  it('gives every module at least one nav entry', () => {
    // A module whose surfaces are all deep links would render a heading with
    // nothing under it for a super_admin, which is the one case where the
    // empty-group filter cannot save us: the module IS enabled and IS empty.
    for (const key of MODULE_KEYS) {
      const navItems = SURFACES.filter((s) => s.module === key && s.nav);
      expect(navItems.length, `module ${key} has no nav surface`).toBeGreaterThan(0);
    }
  });

  it('keeps nav order unique within each group', () => {
    const groups = new Map<string, number[]>();
    for (const surface of SURFACES) {
      if (!surface.nav) continue;
      const key = surface.module ?? '(always-on)';
      groups.set(key, [...(groups.get(key) ?? []), surface.nav.order]);
    }
    for (const [key, orders] of groups) {
      expect(new Set(orders).size, `duplicate nav order in ${key}`).toBe(orders.length);
    }
  });

  it('drops empty groups instead of rendering a bare heading', () => {
    // A reader sees Documents, Requests, Orders, Lots and Records but nothing
    // in Compliance, so the Compliance heading must not be rendered at all.
    const readerGroups = navGroupsForRole('reader');
    expect(readerGroups.every((g) => g.items.length > 0)).toBe(true);
    expect(readerGroups.map((g) => g.module)).not.toContain('compliance');

    // And a role with nothing at all yields no headings rather than four.
    expect(navGroupsForRole(undefined)).toEqual([]);
  });

  it('sorts each group by its declared order', () => {
    for (const role of ALL_ROLES) {
      for (const group of navGroupsForRole(role)) {
        const orders = group.items.map((s) => s.nav!.order);
        expect([...orders].sort((a, b) => a - b), `${role} / ${group.module}`).toEqual(orders);
      }
    }
  });

  it('pins Settings for admins only, and never inside a group', () => {
    expect(pinnedNavSurfaces('super_admin').map((s) => s.path)).toEqual(['/settings']);
    expect(pinnedNavSurfaces('org_admin').map((s) => s.path)).toEqual(['/settings']);
    expect(pinnedNavSurfaces('user')).toEqual([]);
    expect(pinnedNavSurfaces('reader')).toEqual([]);

    for (const role of ALL_ROLES) {
      for (const group of navGroupsForRole(role)) {
        expect(group.items.map((s) => s.path)).not.toContain('/settings');
      }
    }
  });
});

describe('SURFACES — the four drift fixes', () => {
  // These four paths are the reason the table exists. Each assertion names the
  // endpoint that decided the answer, so a future change to the tier has to
  // argue with the API rather than with a magic list.
  const rolesFor = (path: string): Role[] | undefined =>
    SURFACES.find((s) => s.path === path)?.roles;

  it('/review matches GET /api/queue (super_admin, org_admin, user)', () => {
    expect(rolesFor('/review')).toEqual(['super_admin', 'org_admin', 'user']);
  });

  it('/import matches POST /api/documents/ingest (super_admin, org_admin, user)', () => {
    expect(rolesFor('/import')).toEqual(['super_admin', 'org_admin', 'user']);
  });

  it('/spec-alerts no longer bounces a user the nav invited', () => {
    expect(rolesFor('/spec-alerts')).toEqual(['super_admin', 'org_admin', 'user']);
  });

  it('/orders stays open, exactly as GET /api/orders and /lots already are', () => {
    expect(rolesFor('/orders')).toBeUndefined();
    expect(rolesFor('/lots')).toBeUndefined();
  });

  it('shows a nav entry only where the route would actually admit the role', () => {
    // The drift was possible because these were two lists. Now they are one
    // field, so the only way to regress is to stop using it.
    for (const role of ALL_ROLES) {
      const linked = [
        ...navGroupsForRole(role).flatMap((g) => g.items),
        ...pinnedNavSurfaces(role),
      ];
      for (const surface of linked) {
        expect(surface.roles === undefined || surface.roles.includes(role), `${role} → ${surface.path}`).toBe(true);
      }
    }
  });
});

describe('SURFACES — the tenant module gate', () => {
  const headings = (role: Role, modules?: readonly ModuleKey[]): (string | null)[] =>
    navGroupsForRole(role, modules).map((g) => g.heading);

  it('drops a switched-off module\'s whole group AND its heading', () => {
    // The `Settings.tsx` shape: filter, then drop the section that emptied.
    // A heading left behind advertises a section that opens onto nothing,
    // which is worse than never having grouped the rail at all.
    const withFulfillment = navGroupsForRole('org_admin');
    expect(withFulfillment.map((g) => g.module)).toContain('fulfillment');
    expect(headings('org_admin')).toContain(MODULES.fulfillment.label);

    const without = navGroupsForRole(
      'org_admin',
      MODULE_KEYS.filter((k) => k !== 'fulfillment')
    );
    expect(without.map((g) => g.module)).not.toContain('fulfillment');
    expect(headings('org_admin', MODULE_KEYS.filter((k) => k !== 'fulfillment'))).not.toContain(
      MODULES.fulfillment.label
    );
    // And nothing else moved: the gate narrows, it never re-homes.
    expect(without.map((g) => g.module)).toEqual(
      withFulfillment.map((g) => g.module).filter((m) => m !== 'fulfillment')
    );
  });

  it('leaves a portal to log into when every module is off', () => {
    // A tenant with nothing switched on still has Dashboard, Search, Activity
    // and (for an admin) the pinned Settings entry that switches one back on.
    const groups = navGroupsForRole('org_admin', []);
    expect(groups.map((g) => g.module)).toEqual([null]);
    expect(groups[0].items.map((s) => s.nav!.label)).toEqual(['Dashboard', 'Search', 'Activity']);
    expect(pinnedNavSurfaces('org_admin').map((s) => s.path)).toEqual(['/settings']);
  });

  it('shows the UNION of a person\'s functions, not the intersection', () => {
    // `resolveVisibleModules` unions several scoped functions; the rail has to
    // render that union rather than quietly picking one. A QA lead who is also
    // on the Purchasing route keeps both sections.
    const union: ModuleKey[] = ['library', 'fulfillment'];
    const groups = navGroupsForRole('org_admin', union);
    expect(groups.map((g) => g.module)).toEqual([null, 'library', 'fulfillment']);
  });

  it('applies no module filter at all when the set is omitted', () => {
    // The fail-open path. Module visibility is a scope control, not a
    // confidentiality boundary, so a caller that could not resolve it draws
    // everything and lets the server refuse — see functions/lib/module-access.ts.
    expect(navGroupsForRole('org_admin', undefined)).toEqual(navGroupsForRole('org_admin'));
    expect(navGroupsForRole('org_admin', MODULE_KEYS)).toEqual(navGroupsForRole('org_admin'));
  });

  it('gates on module and role together, never one or the other', () => {
    // Filtering only the nav leaves every route reachable by URL; filtering
    // only on module would put an admin-only screen in a reader's rail.
    for (const role of ALL_ROLES) {
      for (const group of navGroupsForRole(role, ['library'])) {
        for (const surface of group.items) {
          expect(surface.module === null || surface.module === 'library', surface.path).toBe(true);
          expect(surface.roles === undefined || surface.roles.includes(role), surface.path).toBe(
            true
          );
        }
      }
    }
  });

  it('names what a tenant loses by switching a module off', () => {
    // The Settings confirmation reads this. Role is deliberately NOT applied:
    // the dialog is about what the ORGANIZATION loses, not about what the
    // admin looking at it happens to see.
    expect(navLabelsForModule('fulfillment')).toEqual([
      'Orders',
      'Lots',
      'Customers',
      'COA Fulfillment',
    ]);
    expect(navLabelsForModule('compliance')).toEqual(['Renewals', 'Out of Spec']);

    for (const key of MODULE_KEYS) {
      // Every module owns at least one rail entry, so the dialog can never
      // degrade into "some pages will stop working".
      expect(navLabelsForModule(key).length, key).toBeGreaterThan(0);
    }
  });
});
