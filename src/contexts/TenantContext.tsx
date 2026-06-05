import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { useAuth } from './AuthContext';
import { api } from '../lib/api';
import type { Tenant } from '../lib/types';

interface TenantContextType {
  tenants: Tenant[];
  selectedTenantId: string | null;
  selectedTenant: Tenant | null;
  setSelectedTenantId: (id: string | null) => void;
  isFiltering: boolean;
  loading: boolean;
}

const TenantContext = createContext<TenantContextType | null>(null);

/** Persist the super_admin's selected tenant across reloads/navigation. */
const SELECTED_TENANT_KEY = 'dox.selectedTenantId';

export function TenantProvider({ children }: { children: ReactNode }) {
  const { user, isSuperAdmin, isAuthenticated } = useAuth();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [selectedTenantId, setSelectedTenantIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      setTenants([]);
      setSelectedTenantIdState(null);
      return;
    }

    const loadTenants = async () => {
      setLoading(true);
      try {
        const list = await api.tenants.list();
        setTenants(list);
        // Restore a previously-selected tenant (super_admin) across reloads —
        // but only if it's still a tenant they can actually see.
        if (isSuperAdmin) {
          try {
            const saved = localStorage.getItem(SELECTED_TENANT_KEY);
            if (saved && list.some((t) => t.id === saved)) {
              setSelectedTenantIdState(saved);
            }
          } catch {
            /* localStorage unavailable — ignore */
          }
        }
      } catch {
        // Silently fail — tenants may not be accessible
        setTenants([]);
      } finally {
        setLoading(false);
      }
    };

    loadTenants();
  }, [isAuthenticated, isSuperAdmin]);

  // For non-super_admin, lock to their own tenant
  useEffect(() => {
    if (user && !isSuperAdmin && user.tenant_id) {
      setSelectedTenantIdState(user.tenant_id);
    }
  }, [user, isSuperAdmin]);

  const setSelectedTenantId = useCallback(
    (id: string | null) => {
      if (!isSuperAdmin) return; // Only super_admin can switch
      setSelectedTenantIdState(id);
      try {
        if (id) localStorage.setItem(SELECTED_TENANT_KEY, id);
        else localStorage.removeItem(SELECTED_TENANT_KEY);
      } catch {
        /* localStorage unavailable — selection just won't persist */
      }
    },
    [isSuperAdmin]
  );

  const selectedTenant = selectedTenantId
    ? tenants.find((t) => t.id === selectedTenantId) || null
    : null;

  const isFiltering = selectedTenantId !== null;

  return (
    <TenantContext.Provider
      value={{
        tenants,
        selectedTenantId,
        selectedTenant,
        setSelectedTenantId,
        isFiltering,
        loading,
      }}
    >
      {children}
    </TenantContext.Provider>
  );
}

export function useTenant(): TenantContextType {
  const context = useContext(TenantContext);
  if (!context) {
    throw new Error('useTenant must be used within a TenantProvider');
  }
  return context;
}
