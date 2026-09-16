/**
 * Modules — which parts of the portal a given tenant bought, and which of
 * those a given person is expected to work in.
 *
 * WHY THIS EXISTS (walkthrough, 2026-09-02). The portal shows every surface to
 * every tenant, including the ones a customer will never use: a food-safety
 * tenant carries Orders / Lots / Customers around forever, a finance tenant
 * carries Review Queue. The meeting asked for two things at once — hide what a
 * customer does not use, and let the SAME departmental roles that already
 * route alerts decide what a person sees on login. "One concept, two effects."
 *
 * THIS IS SCOPE, NOT SECURITY. Tenant isolation and the four permission tiers
 * (super_admin / org_admin / user / reader) remain the security boundary and
 * are untouched by anything here. A module gate answers "should this person be
 * looking at this at all today", which is why the enforcement path is allowed
 * to fail OPEN on a database error: a tenant briefly seeing a surface they do
 * not use is a nuisance, a tenant locked out of their own documents by a D1
 * blip is an outage.
 *
 * NO MODULE-KEY LITERAL MAY BE WRITTEN ANYWHERE ELSE. Same discipline as
 * `shared/specCriticality.ts`: every other module imports `ModuleKey`,
 * `MODULE_KEYS` or `MODULES`, so renaming a module is one edit here plus
 * whatever fails to compile. Deliberately there is NO enumerated CHECK on
 * `module_key` in the database (migration 0099) — the structural guarantee is
 * stronger than a constraint, because a row naming a module that does not
 * exist in this file cannot produce a surface: surfaces come from code.
 *
 * PURE AND DEPENDENCY-FREE. Imported by the React app, by Pages Functions and
 * (eventually) by the background workers, so it pulls in nothing — no React,
 * no MUI, no D1 types. The resolver takes rows, not a database.
 */

/**
 * The modules, in the order they are presented. The order is load-bearing:
 * it is the order of the nav groups and the order `resolveVisibleModules`
 * returns, so a caller never has to re-sort.
 */
export const MODULE_KEYS = ['library', 'compliance', 'fulfillment', 'records'] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export function isModuleKey(value: unknown): value is ModuleKey {
  return typeof value === 'string' && (MODULE_KEYS as readonly string[]).includes(value);
}

export interface ModuleDefinition {
  key: ModuleKey;
  /** The nav group heading, and the name a tenant is shown on the toggle. */
  label: string;
  /**
   * One line for the person deciding whether to switch it on. Written about
   * WHO uses it rather than what it does — an admin picking modules for their
   * company knows their org chart, not our feature list.
   */
  blurb: string;
  /**
   * What a tenant that never touches the toggle gets. ALL FOUR ARE TRUE and
   * migration 0099 inserts zero rows, so every existing user's visible set the
   * day after the migration is byte-identical to the day before.
   *
   * ONCE A MODULE SHIPS, ITS DEFAULT IS FROZEN. Flipping a shipped module's
   * `defaultEnabled` to false silently narrows every tenant that never opened
   * the screen, with no row anywhere recording that it happened. Changing what
   * an existing tenant sees is done by INSERTing `tenant_modules` rows in a
   * later migration, explicitly and reviewably.
   */
  defaultEnabled: boolean;
  /**
   * The front-end paths this module owns. Matched as whole path segments, so
   * `/documents` covers `/documents/:id` but never `/documentsomething`.
   */
  uiPrefixes: readonly string[];
  /**
   * The API paths this module owns, for the middleware gate that lands in a
   * later pass — hiding a nav item that leaves its route and its endpoint
   * reachable by URL is not hiding anything.
   *
   * ONLY ENDPOINTS THAT EXCLUSIVELY SERVE THIS MODULE'S SURFACES ARE LISTED.
   * `/api/documents` is the load-bearing omission: a renewal digest, an alert
   * landing page and a COA fulfillment join all read documents, so gating it
   * behind `library` would break `compliance` and `fulfillment` for a tenant
   * that switched library off — a module gate taking down a module that is
   * switched ON is a far worse bug than a deep link still resolving. Shared
   * read primitives stay always-on and are gated by the permission tiers, as
   * they always were.
   */
  apiPrefixes: readonly string[];
}

export const MODULES: Record<ModuleKey, ModuleDefinition> = {
  library: {
    key: 'library',
    label: 'Supplier Documents',
    blurb:
      'For whoever chases paperwork out of suppliers — the certificates arrive, get reviewed by a person, and end up filed against the right supplier.',
    defaultEnabled: true,
    uiPrefixes: ['/documents', '/import', '/review', '/requests', '/bundles', '/ingest-history', '/admin/suppliers'],
    apiPrefixes: [
      '/api/queue',
      '/api/suppliers',
      '/api/bundles',
      '/api/document-requests',
      '/api/request-lines',
      '/api/request-uploads',
      '/api/request-templates',
      '/api/supplier-requests',
      '/api/supplier-gaps',
      // The verified supplier list import creates suppliers and derives what
      // they owe; with Supplier Documents off there are no suppliers to own it.
      '/api/supplier-list',
      // Getting documents out of search — the ZIP and the "send to an address"
      // path (migration 0115). Listed even though `/api/documents` deliberately
      // is not: this prefix serves ONE surface (the supplier-document library's
      // export), so gating it cannot take a module that is switched ON down
      // with it. The token-gated recipient routes live under
      // /api/document-exports/public and reach the gate with no user, so a
      // recipient is never narrowed by the sender's module settings.
      '/api/document-exports',
    ],
  },
  compliance: {
    key: 'compliance',
    label: 'Compliance',
    blurb:
      'For the person who answers to the auditor — what expires soon, what came back out of spec, and evidence that somebody was told.',
    defaultEnabled: true,
    uiPrefixes: ['/expirations', '/spec-alerts'],
    apiPrefixes: [
      '/api/expirations',
      '/api/spec-checks',
      '/api/spec-gaps',
      '/api/spec-limits',
      '/api/spec-required-analytes',
      '/api/spec-tests',
      '/api/spec-unit-policy',
    ],
  },
  fulfillment: {
    key: 'fulfillment',
    label: 'Order Fulfillment',
    blurb:
      'For the people shipping product — the orders, the lots that filled them, and the certificates a customer asks for after delivery.',
    defaultEnabled: true,
    uiPrefixes: ['/orders', '/lots', '/reports', '/admin/customers'],
    apiPrefixes: ['/api/orders', '/api/lots', '/api/customers', '/api/reports', '/api/lot-matches', '/api/order-products'],
  },
  records: {
    key: 'records',
    label: 'Records',
    blurb:
      'For teams keeping a log the rest of the system does not — their own sheets, public intake forms, and the approvals on top of them.',
    defaultEnabled: true,
    uiPrefixes: ['/records', '/approvals'],
    apiPrefixes: ['/api/records', '/api/forms', '/api/update-requests', '/api/workflow-approvals'],
  },
};

/**
 * Longest-prefix match against a list of (module, prefix) pairs.
 *
 * Longest wins because prefixes nest: `/admin/suppliers` belongs to `library`
 * while the rest of `/admin` is always-on configuration, so a shorter accidental
 * match would hand a whole area to the wrong module. Comparison is
 * case-SENSITIVE, matching both routers: React Router and Pages Functions both
 * dispatch on the exact path, so a lower-cased comparison here would answer for
 * a request that never reaches the surface it names.
 */
function matchPrefix(pathname: string, pick: (m: ModuleDefinition) => readonly string[]): ModuleKey | null {
  // A caller holding a whole URL tail rather than a bare pathname is a
  // predictable mistake; trimming is cheaper than a gate that silently misses.
  const cut = pathname.split(/[?#]/, 1)[0] ?? '';
  const path = cut.length > 1 && cut.endsWith('/') ? cut.slice(0, -1) : cut;

  let best: ModuleKey | null = null;
  let bestLength = -1;
  for (const key of MODULE_KEYS) {
    for (const prefix of pick(MODULES[key])) {
      if (prefix.length <= bestLength) continue;
      // Whole-segment match only: `/documents/:id` yes, `/documentsomething` no.
      if (path === prefix || path.startsWith(`${prefix}/`)) {
        best = key;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/**
 * Which module owns a front-end path. `null` means ALWAYS ON — Dashboard,
 * Search, Activity, Settings, profile and the admin configuration screens are
 * not any module's, and a tenant with every module switched off still has a
 * portal to log into.
 */
export function moduleForUiPath(pathname: string): ModuleKey | null {
  return matchPrefix(pathname, (m) => m.uiPrefixes);
}

/** Which module owns an API path. `null` means always on — see above. */
export function moduleForApiPath(pathname: string): ModuleKey | null {
  return matchPrefix(pathname, (m) => m.apiPrefixes);
}

/** A `tenant_modules` row, as read. `enabled` arrives from D1 as 0/1. */
export interface TenantModuleRow {
  module_key: string;
  enabled: number | boolean;
}

/**
 * One row of "which functions does this person hold, and what does each of
 * those functions restrict them to" — the shape of a LEFT JOIN from
 * `owner_routes` (the function membership, migration 0091) onto
 * `module_visibility` (migration 0099).
 *
 * The LEFT is what makes `module_key: null` meaningful: a function nobody has
 * configured visibility for produces exactly one row with a null module_key,
 * and that is how an UNCONSTRAINED function is distinguished from a function
 * that is merely absent from the result set. An INNER JOIN would erase the
 * difference and quietly narrow people.
 */
export interface ModuleFunctionRow {
  owner_key: string;
  module_key: string | null;
}

export interface ResolveVisibleModulesInput {
  role: string;
  /** `tenant_modules` rows for this tenant. Absent key ⇒ `defaultEnabled`. */
  tenantRows: readonly TenantModuleRow[];
  /** The join above, for this user. Empty ⇒ this user holds no function. */
  functionRows: readonly ModuleFunctionRow[];
}

/**
 * Which modules this person should see. TENANT GATES, ROLE FILTERS — the two
 * layers are not symmetric and must not be collapsed:
 *
 *   1. The TENANT layer is the ceiling. A module the tenant switched off is
 *      not available to anybody in it, whatever their function says. Selling
 *      the module is the only thing that turns it back on.
 *   2. The FUNCTION layer only narrows within that ceiling. A person's
 *      functions come from `owner_routes` — the same QA / Insurance /
 *      Accounting / Purchasing labels that already decide who receives an
 *      alert. One concept, two effects; no second role table.
 *
 * ABSENCE MEANS UNCONSTRAINED, AND THAT IS DELIBERATE. A function is
 * *constrained* only once somebody has written at least one visibility row for
 * it. So a user who holds no function at all, and a user who holds any
 * function nobody has configured, sees every enabled module. Where several
 * functions are held the result is their UNION, and a single unconstrained one
 * wins outright — a QA lead who is also on the Purchasing route does not lose
 * QA because Purchasing was scoped.
 *
 * This is the deliberate INVERSE of `owner_routes` itself, where absence means
 * "unrouted, and reported as a gap" (migration 0091). The two rules disagree
 * about what silence means because they fail in opposite directions: an
 * unrouted alert that quietly went to the admin pool is an alert nobody acts
 * on, while an unconfigured user who quietly saw less is a person who cannot
 * find their own work and does not know why. Both rules are chosen so the
 * un-configured case points toward the person seeing MORE, never silently
 * less. Narrowing always requires somebody to have written a row.
 *
 * super_admin bypasses BOTH layers: they cross tenants by definition, and are
 * the person a customer calls when a module toggle went wrong.
 */
export function resolveVisibleModules(input: ResolveVisibleModulesInput): ModuleKey[] {
  if (input.role === 'super_admin') return [...MODULE_KEYS];

  // Layer 1 — the tenant ceiling. Rows naming a module this build does not
  // know about are ignored rather than rejected: there is no CHECK on the
  // column on purpose, and a stale row from a removed module must not be able
  // to make the resolver throw.
  const disabled = new Set<ModuleKey>();
  for (const row of input.tenantRows) {
    if (!isModuleKey(row.module_key)) continue;
    const enabled = typeof row.enabled === 'boolean' ? row.enabled : row.enabled !== 0;
    if (!enabled) disabled.add(row.module_key);
  }
  const enabled = MODULE_KEYS.filter((key) => (disabled.has(key) ? false : MODULES[key].defaultEnabled));

  // Layer 2 — the function filter. Empty input, or any unconstrained function,
  // leaves the ceiling untouched.
  if (input.functionRows.length === 0) return [...enabled];

  const allowed = new Set<ModuleKey>();
  for (const row of input.functionRows) {
    // A null module_key IS the unconstrained function: it means this person
    // holds a role nobody has scoped, so nothing about them is narrowed.
    if (row.module_key === null) return [...enabled];
    if (isModuleKey(row.module_key)) allowed.add(row.module_key);
    // An unrecognised key contributes nothing — and cannot, because the
    // surface it would name does not exist in this build.
  }

  return enabled.filter((key) => allowed.has(key));
}
