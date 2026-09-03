/**
 * Surfaces — the one list of what this portal has, who may reach it, and
 * where it appears in the nav.
 *
 * WHY THIS EXISTS. Until this file there were TWO lists: `navItems` in
 * `src/components/Layout.tsx` and the `<Route>` JSX in `src/App.tsx`. They
 * shared no data structure, so a path existed in both independently — and they
 * had already drifted, in BOTH directions, on production:
 *
 *   /review      nav said admins only,  the route was UNGATED  → a `user`
 *                worked the review queue by typing the URL.
 *   /spec-alerts nav said `user`+,      the route said admins  → a `user` saw
 *                the link and was bounced to /dashboard.
 *   /import      nav said `user`+,      the route was UNGATED.
 *   /orders      nav said `user`+,      the route was UNGATED.
 *
 * No data leaked — every endpoint gates itself — but three layers disagreed
 * about who may review documents, and a fourth opinion (the tenant module gate
 * that lands next) on top of that would have been malpractice. So: ONE list.
 * A surface's `roles` is simultaneously its `<ProtectedRoute>` tier and its
 * nav visibility, because those were never two questions.
 *
 * THE MODULE KEYS ARE IMPORTED, NEVER RESTATED. `shared/modules.ts` is the
 * single vocabulary site; `moduleForUiPath` already encodes the path→module
 * prefix mapping and `tests/unit/surfaces.test.ts` asserts every declaration
 * here agrees with it, so a renamed module or a re-homed path fails a test
 * rather than drifting quietly.
 *
 * THIS FILE DOES NOT APPLY THE TENANT MODULE GATE. `module` is declared here
 * and used today only to GROUP the nav. Reading `tenant_modules` and hiding
 * disabled modules is a later pass; this one is a pure refactor plus the four
 * deliberate gating fixes above.
 */

import { MODULE_KEYS, MODULES } from '../../shared/modules';
import type { ModuleKey } from '../../shared/modules';
import type { Role } from './types';

import {
  Dashboard as DashboardIcon,
  Description as DocsIcon,
  Search as SearchIcon,
  LocalShipping as SuppliersIcon,
  Timeline as ActivityIcon,
  FileUpload as ImportIcon,
  RateReview as RateReviewIcon,
  ShoppingCart as OrdersIcon,
  Inventory2 as LotsIcon,
  Assessment as ReportsIcon,
  EventBusy as RenewalsIcon,
  ErrorOutline as OutOfSpecIcon,
  ContactMail as CustomersIcon,
  ForwardToInbox as RequestsIcon,
  TableView as RecordsIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';

import { Dashboard } from '../pages/Dashboard';
import { Documents } from '../pages/Documents';
import { DocumentDetail } from '../pages/DocumentDetail';
import { DocumentCreate } from '../pages/DocumentCreate';
import { Search } from '../pages/Search';
import { Profile } from '../pages/Profile';
import { Users } from '../pages/admin/Users';
import { Tenants } from '../pages/admin/Tenants';
import { AuditLog } from '../pages/admin/AuditLog';
import { ApiKeys } from '../pages/admin/ApiKeys';
import { Products } from '../pages/admin/Products';
import { ProductDetail } from '../pages/admin/ProductDetail';
import { Suppliers } from '../pages/admin/Suppliers';
import { SupplierDetail } from '../pages/admin/SupplierDetail';
import { DocumentTypes } from '../pages/admin/DocumentTypes';
import { Requirements } from '../pages/admin/Requirements';
import { SpecAlerts } from '../pages/SpecAlerts';
import { ClaimTypes } from '../pages/admin/ClaimTypes';
import { ClaimRules } from '../pages/admin/ClaimRules';
import { Requests } from '../pages/requests/Requests';
import { RequestCompose } from '../pages/requests/RequestCompose';
import { RequestDetail } from '../pages/requests/RequestDetail';
import { RequestTemplates } from '../pages/requests/RequestTemplates';
import { Bundles } from '../pages/Bundles';
import { BundleDetail } from '../pages/BundleDetail';
import { IngestHistory } from '../pages/IngestHistory';
import { Import } from '../pages/Import';
import ReviewQueue from '../pages/ReviewQueue';
import { Sources } from '../pages/admin/Sources';
import { SourceDetail } from '../pages/admin/SourceDetail';
import { SourceWizard } from '../pages/admin/SourceWizard';
import { Customers } from '../pages/admin/Customers';
import { CustomerDetail } from '../pages/admin/CustomerDetail';
import LearningDashboard from '../pages/admin/LearningDashboard';
import { ProcessingStatus } from '../pages/admin/ProcessingStatus';
import { Orders } from '../pages/Orders';
import { OrderDetail } from '../pages/OrderDetail';
import { Lots } from '../pages/Lots';
import { Reports } from '../pages/Reports';
import { Expirations } from '../pages/Expirations';
import { Activity } from '../pages/Activity';
import { Sheets } from '../pages/records/Sheets';
import { SheetDetail } from '../pages/records/SheetDetail';
import { FormBuilder } from '../pages/records/FormBuilder';
import { WorkflowBuilder } from '../pages/records/WorkflowBuilder';
import { Approvals } from '../pages/Approvals';
import { Help } from '../pages/Help';
import { Settings } from '../pages/Settings';

/** Where a surface sits in the rail, when it has a rail entry at all. */
export interface SurfaceNav {
  label: string;
  icon: React.ReactNode;
  /**
   * Position within the surface's own nav group. Unique per group and
   * asserted so, because two items sharing an order sort unstably — the rail
   * would reshuffle between builds for no reason a reader could see.
   */
  order: number;
}

export interface Surface {
  /** The `<Route path>`, verbatim. */
  path: string;
  element: React.ReactNode;
  /**
   * Which module owns this surface; `null` means ALWAYS ON — Dashboard,
   * Search, Activity, Settings, the profile and the admin configuration
   * screens belong to no module, and a tenant with every module switched off
   * still has a portal to log into. Must agree with `moduleForUiPath`.
   */
  module: ModuleKey | null;
  /**
   * The permission tier, as `<ProtectedRoute roles>` has always meant it.
   * Omitted = every authenticated role, which is what an un-nested route in
   * the old App.tsx meant.
   */
  roles?: Role[];
  /** Present iff this surface has a rail entry. */
  nav?: SurfaceNav;
}

/**
 * The tiers, named once. `ADMIN` and `CONTRIBUTOR` are the two that recur;
 * everything else is spelled out where it is unusual enough to be worth
 * reading.
 */
const ADMIN: Role[] = ['super_admin', 'org_admin'];
const CONTRIBUTOR: Role[] = ['super_admin', 'org_admin', 'user'];

export const SURFACES: Surface[] = [
  // ---------------------------------------------------------------- always on
  {
    path: '/dashboard',
    element: <Dashboard />,
    module: null,
    nav: { label: 'Dashboard', icon: <DashboardIcon />, order: 10 },
  },
  {
    path: '/search',
    element: <Search />,
    module: null,
    nav: { label: 'Search', icon: <SearchIcon />, order: 20 },
  },
  {
    path: '/activity',
    element: <Activity />,
    module: null,
    nav: { label: 'Activity', icon: <ActivityIcon />, order: 30 },
  },
  { path: '/profile', element: <Profile />, module: null },
  { path: '/help', element: <Help />, module: null },
  { path: '/help/:module', element: <Help />, module: null },

  // ------------------------------------------------------------------ library
  {
    path: '/documents',
    element: <Documents />,
    module: 'library',
    nav: { label: 'Documents', icon: <DocsIcon />, order: 10 },
  },
  // Creating a document is a write; reading the list is not. This split
  // predates the refactor and is preserved exactly.
  { path: '/documents/new', element: <DocumentCreate />, module: 'library', roles: CONTRIBUTOR },
  { path: '/documents/:id', element: <DocumentDetail />, module: 'library' },
  {
    // DRIFT FIX. Nav said `user`+, the route was ungated — so a `reader` could
    // open the bulk-upload screen and a `user` could not see the link they
    // were entitled to. The API decides: `POST /api/documents/ingest` and
    // `POST /api/documents/process`, the two endpoints this page exists to
    // drive, both `requireRole(user, 'super_admin', 'org_admin', 'user')`.
    // Import is a write-only surface, so the write tier IS the page tier.
    path: '/import',
    element: <Import />,
    module: 'library',
    roles: CONTRIBUTOR,
    nav: { label: 'Import', icon: <ImportIcon />, order: 20 },
  },
  {
    // DRIFT FIX, and the one that mattered. Nav said admins only, the route
    // was ungated: a `user` worked the review queue by typing /review, which
    // is exactly what the API already permits — `GET /api/queue`,
    // `/api/queue/:id`, `/file`, `/results` and `/reprocess` all allow `user`.
    // Only the approve/reject PUT is admin-only, and that is a control INSIDE
    // the page, not a reason to hide the queue from the people who triage it.
    // So the nav widens to `user` (matching what the API always allowed) and
    // the route narrows to exclude `reader` (whose every call here 403s).
    path: '/review',
    element: <ReviewQueue />,
    module: 'library',
    roles: CONTRIBUTOR,
    nav: { label: 'Review Queue', icon: <RateReviewIcon />, order: 30 },
  },
  {
    path: '/admin/suppliers',
    element: <Suppliers />,
    module: 'library',
    roles: ADMIN,
    nav: { label: 'Suppliers', icon: <SuppliersIcon />, order: 40 },
  },
  { path: '/admin/suppliers/:id', element: <SupplierDetail />, module: 'library', roles: ADMIN },
  // The request composer (migration 0090). Reading is open to any
  // authenticated user of the tenant — an outstanding-request list is
  // evidence, not configuration, and the API says the same. The composing
  // route is gated to the roles that may commit the organization to an
  // outbound ask.
  {
    path: '/requests',
    element: <Requests />,
    module: 'library',
    nav: { label: 'Requests', icon: <RequestsIcon />, order: 50 },
  },
  { path: '/requests/templates', element: <RequestTemplates />, module: 'library' },
  { path: '/requests/new', element: <RequestCompose />, module: 'library', roles: ADMIN },
  { path: '/requests/:id', element: <RequestDetail />, module: 'library' },
  { path: '/bundles', element: <Bundles />, module: 'library' },
  { path: '/bundles/:id', element: <BundleDetail />, module: 'library' },
  { path: '/ingest-history', element: <IngestHistory />, module: 'library' },

  // --------------------------------------------------------------- compliance
  {
    path: '/expirations',
    element: <Expirations />,
    module: 'compliance',
    roles: CONTRIBUTOR,
    nav: { label: 'Renewals', icon: <RenewalsIcon />, order: 10 },
  },
  {
    // DRIFT FIX. Nav offered it to `user`, the route refused — a `user` saw
    // the link and was bounced to /dashboard, which reads as a broken portal.
    // `GET /api/spec-checks` carries no `requireRole` at all and says why in
    // its header: "Read access is any tenant user — the register is evidence,
    // not configuration." So the route opens to `user`, matching both the nav
    // and the API.
    //
    // Deliberately NOT opened to `reader`, even though the endpoint would
    // allow it: the page's one write, POST /api/spec-checks (acknowledge),
    // has no role gate either, and that looks like an oversight rather than a
    // decision — the file documents READ access as open and says nothing
    // about who may acknowledge. Handing a read-only role an Acknowledge
    // button on a food-safety register on the strength of a missing check is
    // not a call this refactor should make. Reported separately.
    path: '/spec-alerts',
    element: <SpecAlerts />,
    module: 'compliance',
    roles: CONTRIBUTOR,
    nav: { label: 'Out of Spec', icon: <OutOfSpecIcon />, order: 20 },
  },

  // -------------------------------------------------------------- fulfillment
  {
    // DRIFT FIX. Nav said `user`+, the route was ungated. `GET /api/orders`
    // has no role gate (only `POST` requires `user`+), so reading orders is
    // already open to `reader` — and /lots, the neighbouring surface of the
    // same shape, has said so in both its nav entry and its route all along.
    // Matching the API keeps every existing route reachable and brings the
    // nav into line with it rather than the other way round.
    path: '/orders',
    element: <Orders />,
    module: 'fulfillment',
    nav: { label: 'Orders', icon: <OrdersIcon />, order: 10 },
  },
  { path: '/orders/:id', element: <OrderDetail />, module: 'fulfillment' },
  {
    path: '/lots',
    element: <Lots />,
    module: 'fulfillment',
    nav: { label: 'Lots', icon: <LotsIcon />, order: 20 },
  },
  {
    path: '/admin/customers',
    element: <Customers />,
    module: 'fulfillment',
    roles: ADMIN,
    nav: { label: 'Customers', icon: <CustomersIcon />, order: 30 },
  },
  { path: '/admin/customers/:id', element: <CustomerDetail />, module: 'fulfillment', roles: ADMIN },
  {
    path: '/reports',
    element: <Reports />,
    module: 'fulfillment',
    roles: CONTRIBUTOR,
    nav: { label: 'COA Fulfillment', icon: <ReportsIcon />, order: 40 },
  },

  // ------------------------------------------------------------------ records
  {
    path: '/records',
    element: <Sheets />,
    module: 'records',
    nav: { label: 'Records', icon: <RecordsIcon />, order: 10 },
  },
  { path: '/records/:sheetId', element: <SheetDetail />, module: 'records' },
  { path: '/records/:sheetId/forms/:formId', element: <FormBuilder />, module: 'records' },
  { path: '/records/:sheetId/workflows/:workflowId', element: <WorkflowBuilder />, module: 'records' },
  { path: '/approvals', element: <Approvals />, module: 'records' },

  // ---------------------------------------------- always-on admin & settings
  // Settings is pinned to the bottom of the rail by Layout rather than sorted
  // with the groups, so it carries a nav entry but no group of its own.
  {
    path: '/settings',
    element: <Settings />,
    module: null,
    roles: ADMIN,
    // Ordered last among the always-on surfaces even though Layout pins it
    // below every group: `order` is unique per group by contract, and a
    // pinned item that also claimed Dashboard's slot would be a collision
    // waiting for whoever un-pins it.
    nav: { label: 'Settings', icon: <SettingsIcon />, order: 100 },
  },
  { path: '/settings/:section', element: <Settings />, module: null, roles: ADMIN },
  { path: '/admin/users', element: <Users />, module: null, roles: ADMIN },
  { path: '/admin/api-keys', element: <ApiKeys />, module: null, roles: ADMIN },
  { path: '/admin/audit', element: <AuditLog />, module: null, roles: ADMIN },
  { path: '/admin/document-types', element: <DocumentTypes />, module: null, roles: ADMIN },
  // Registry taxonomy vocabularies (migration 0080).
  { path: '/admin/requirements', element: <Requirements />, module: null, roles: ADMIN },
  { path: '/admin/claim-types', element: <ClaimTypes />, module: null, roles: ADMIN },
  { path: '/admin/claim-rules', element: <ClaimRules />, module: null, roles: ADMIN },
  { path: '/admin/products', element: <Products />, module: null, roles: ADMIN },
  { path: '/admin/products/:id', element: <ProductDetail />, module: null, roles: ADMIN },
  { path: '/admin/sources', element: <Sources />, module: null, roles: ADMIN },
  { path: '/admin/sources/new', element: <SourceWizard />, module: null, roles: ADMIN },
  { path: '/admin/sources/:id/edit', element: <SourceWizard />, module: null, roles: ADMIN },
  { path: '/admin/sources/:id', element: <SourceDetail />, module: null, roles: ADMIN },
  { path: '/admin/learning-dashboard', element: <LearningDashboard />, module: null, roles: ADMIN },
  { path: '/admin/tenants', element: <Tenants />, module: null, roles: ['super_admin'] },
  { path: '/admin/processing-status', element: <ProcessingStatus />, module: null, roles: ['super_admin'] },
];

/**
 * Settings is pinned to the bottom of the rail with a divider above it, so
 * Layout pulls it out of the grouped set rather than sorting it in. Named
 * here as a path lookup rather than re-declared, so the surface above stays
 * the only place its element and roles are written.
 */
export const PINNED_NAV_PATHS: readonly string[] = ['/settings'];

/** One rendered block of the rail: a heading (or none) and its items. */
export interface NavGroup {
  /** `null` is the always-on block that renders above the headed groups. */
  module: ModuleKey | null;
  /** `null` for the always-on block, which deliberately has no heading. */
  heading: string | null;
  items: Surface[];
}

/**
 * The rail for one role: always-on surfaces first, then one block per module
 * in `MODULE_KEYS` order.
 *
 * EMPTY GROUPS DROP THEIR HEADING — a lone "Compliance" subheader with
 * nothing beneath it is worse than no grouping at all. Same shape as
 * `Settings.tsx`'s `.map(...).filter(s => s.items.length > 0)`, which is the
 * codebase's existing precedent for computing a visible surface list.
 *
 * Pinned surfaces are excluded; Layout renders those itself at the bottom.
 */
export function navGroupsForRole(role: Role | undefined): NavGroup[] {
  if (!role) return [];

  const visible = SURFACES.filter(
    (s) =>
      s.nav !== undefined &&
      !PINNED_NAV_PATHS.includes(s.path) &&
      (s.roles === undefined || s.roles.includes(role))
  );

  const groups: NavGroup[] = [
    { module: null, heading: null, items: visible.filter((s) => s.module === null) },
    ...MODULE_KEYS.map((key) => ({
      module: key,
      heading: MODULES[key].label,
      items: visible.filter((s) => s.module === key),
    })),
  ];

  for (const group of groups) {
    group.items.sort((a, b) => a.nav!.order - b.nav!.order);
  }

  return groups.filter((g) => g.items.length > 0);
}

/** The pinned surfaces this role may see, in declaration order. */
export function pinnedNavSurfaces(role: Role | undefined): Surface[] {
  if (!role) return [];
  return SURFACES.filter(
    (s) =>
      s.nav !== undefined &&
      PINNED_NAV_PATHS.includes(s.path) &&
      (s.roles === undefined || s.roles.includes(role))
  );
}
