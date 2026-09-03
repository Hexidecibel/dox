/**
 * ModuleAccessContext — which modules the signed-in person sees, fetched once
 * per session and re-fetched when the tenant under them changes.
 *
 * WHY IT IS NOT IN THE JWT. Tokens live 24 hours here. Putting the module set
 * in the token would mean an admin switching Orders off, watching it stay on
 * the screen, switching it back, and filing a bug — the toggle would take
 * effect somewhere between now and tomorrow. So it is a request, made after
 * auth resolves, against `GET /api/module-access`.
 *
 * WHY IT IS NOT CACHED IN localStorage. The stale direction is the wrong
 * direction: a cache would keep rendering a surface the tenant has since
 * disabled, on the one machine whose owner is least likely to hard-refresh.
 * A cheap request on load is the correct trade; there is exactly one of them.
 *
 * IT FAILS OPEN, ON PURPOSE, AND SO DOES THE SERVER. `loadModuleAccess` in
 * `functions/lib/module-access.ts` falls open on a D1 error and says why:
 * module visibility is a SCOPE control, not a confidentiality boundary.
 * Tenant isolation and the four permission tiers are the security boundary
 * and are enforced server-side on every call regardless of what this context
 * believes. So a failed fetch here shows everything and logs, rather than
 * blanking somebody's portal because a request timed out. The alternative —
 * fail closed — turns a transient blip into "the app stopped working", to
 * protect a preference.
 */

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { useTenant } from './TenantContext';
import { api } from '../lib/api';
import { MODULE_KEYS } from '../lib/types';
import type { ModuleKey } from '../lib/types';

export interface ModuleAccessContextType {
  /**
   * True until the first answer arrives. Consumers hold their render rather
   * than flashing a full nav and then pulling items out of it — see
   * `ProtectedRoute`, which owns the one spinner in the authenticated shell.
   */
  loading: boolean;
  /**
   * The TENANT ceiling: what this organization has switched on, before this
   * person's functions narrow it. Carried separately from `visible` so a
   * denial can say WHICH layer refused — "your company does not use Orders"
   * and "your role does not include Orders" are fixed on different screens by
   * different people.
   */
  tenantEnabled: ModuleKey[];
  /** What this person sees: the ceiling, narrowed by their functions. */
  visible: ModuleKey[];
  /**
   * The departmental functions this user holds, from `owner_routes`. Named in
   * the denial panel so "why can't I see Orders" has an answer that points at
   * a row somebody wrote, rather than at a mystery.
   */
  functions: string[];
  /** True when a lookup fell open — either the server's or ours. */
  degraded: boolean;
  /**
   * Does this person see the given surface's module? `null` means the surface
   * belongs to no module (Dashboard, Search, Activity, Settings) and is
   * therefore always on, so it answers true.
   */
  isVisible: (module: ModuleKey | null) => boolean;
  /** Re-read after a toggle, so the nav moves without a page reload. */
  refresh: () => void;
}

const ModuleAccessContext = createContext<ModuleAccessContextType | null>(null);

/** The fail-open answer: every module, and a flag saying we guessed. */
function everything(degraded: boolean): {
  tenantEnabled: ModuleKey[];
  visible: ModuleKey[];
  functions: string[];
  degraded: boolean;
} {
  return { tenantEnabled: [...MODULE_KEYS], visible: [...MODULE_KEYS], functions: [], degraded };
}

export function ModuleAccessProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, loading: authLoading } = useAuth();
  // A super_admin scoping into another tenant is looking at that tenant's
  // portal, so the answer is re-asked when the selection moves.
  //
  // TODAY THAT RE-ASK RETURNS THE SAME THING, AND THE DEPENDENCY IS STILL
  // RIGHT. `GET /api/module-access` resolves the tenant from the caller's own
  // JWT and ignores any tenant_id, and `loadModuleAccess` short-circuits
  // super_admin to every module by deliberate design — they cross tenants and
  // are the person a customer calls when a toggle went wrong, so they must
  // never be able to hide the screen holding it from themselves. The moment
  // that endpoint learns to answer "as this tenant", the rail follows with no
  // second edit; leaving the dependency out would make that a silent bug.
  const { selectedTenantId } = useTenant();

  const [state, setState] = useState(() => everything(false));
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  useEffect(() => {
    // Nothing to ask about until auth has settled. A signed-out visitor never
    // reaches a gated surface — `ProtectedRoute` sends them to /login first —
    // so the un-authenticated state is "everything", not "nothing": it is
    // never read, and a `[]` here would make a logout flash an empty nav.
    if (authLoading) return;
    if (!isAuthenticated) {
      setState(everything(false));
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    api.modules
      .access()
      .then((res) => {
        if (cancelled) return;
        setState({
          tenantEnabled: res.tenant_enabled,
          visible: res.visible,
          functions: res.functions,
          degraded: res.degraded,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Fail OPEN and say so out loud. See the header: this is scope, not
        // security, and the server gates every call again anyway.
        console.error(
          '[module-access] could not read module visibility, showing everything:',
          err instanceof Error ? err.message : String(err),
        );
        setState(everything(true));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [authLoading, isAuthenticated, selectedTenantId, reloadToken]);

  const isVisible = useCallback(
    (module: ModuleKey | null) => module === null || state.visible.includes(module),
    [state.visible],
  );

  return (
    <ModuleAccessContext.Provider
      value={{
        loading,
        tenantEnabled: state.tenantEnabled,
        visible: state.visible,
        functions: state.functions,
        degraded: state.degraded,
        isVisible,
        refresh,
      }}
    >
      {children}
    </ModuleAccessContext.Provider>
  );
}

export function useModuleAccess(): ModuleAccessContextType {
  const context = useContext(ModuleAccessContext);
  if (!context) {
    throw new Error('useModuleAccess must be used within a ModuleAccessProvider');
  }
  return context;
}
