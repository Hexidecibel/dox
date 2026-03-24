import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import { api } from '../lib/api';
import type { User } from '../lib/types';
import { AUTH_TOKEN_KEY, AUTH_USER_KEY } from '../lib/types';

interface AuthContextType {
  isAuthenticated: boolean;
  loading: boolean;
  user: User | null;
  isSuperAdmin: boolean;
  isOrgAdmin: boolean;
  isAdmin: boolean;
  isUser: boolean;
  isReader: boolean;
  forcePasswordChange: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  clearForcePasswordChange: () => void;
}

const AuthContext = createContext<AuthContextType | null>(null);

function isTokenExpired(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return true;
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (!decoded.exp) return true;
    return decoded.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

function parseUserFromToken(token: string): User | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return decoded.user || null;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const isAuthenticated = user !== null;
  const isSuperAdmin = user?.role === 'super_admin';
  const isOrgAdmin = user?.role === 'org_admin';
  const isAdmin = user?.role === 'super_admin' || user?.role === 'org_admin';
  const isUser = user?.role === 'user';
  const isReader = user?.role === 'reader';
  const forcePasswordChange = !!(user?.force_password_change);

  useEffect(() => {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    const storedUser = localStorage.getItem(AUTH_USER_KEY);

    if (token && !isTokenExpired(token)) {
      if (storedUser) {
        try {
          setUser(JSON.parse(storedUser));
        } catch {
          setUser(parseUserFromToken(token));
        }
      } else {
        setUser(parseUserFromToken(token));
      }
    } else if (token) {
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_USER_KEY);
    }
    setLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const { token, user: authUser } = await api.auth.login(email, password);
    localStorage.setItem(AUTH_TOKEN_KEY, token);
    localStorage.setItem(AUTH_USER_KEY, JSON.stringify(authUser));
    setUser(authUser);
  }, []);

  const clearForcePasswordChange = useCallback(() => {
    if (user) {
      const updatedUser = { ...user, force_password_change: 0 };
      setUser(updatedUser);
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(updatedUser));
    }
  }, [user]);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      // Best-effort — still clear local state even if API call fails
    }
    localStorage.removeItem(AUTH_TOKEN_KEY);
    localStorage.removeItem(AUTH_USER_KEY);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ isAuthenticated, loading, user, isSuperAdmin, isOrgAdmin, isAdmin, isUser, isReader, forcePasswordChange, login, logout, clearForcePasswordChange }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
