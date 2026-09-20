'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, api, type Me } from './api';
import { useAsyncEffect } from './use-async';

type SessionState = {
  me: Me | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
  can: (permission: string) => boolean;
};

const SessionContext = createContext<SessionState | null>(null);

/**
 * Holds the answer to `/auth/me` for the signed-in part of the app, and sends
 * the browser where it belongs when the API says the session is not usable
 * yet: to the second factor, or to enrolment.
 */
export function SessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Me>('/auth/me');
      setMe(next);
      setError(null);
      if (next.mfa.required && !next.mfa.enabled) {
        router.replace('/enrol-mfa');
        return next;
      }
      if (next.mfa.enabled && !next.mfa.verified) {
        router.replace('/mfa');
        return next;
      }
      return next;
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.status === 401) {
          router.replace('/login');
          return null;
        }
        if (caught.code === 'mfa_enrolment_required') {
          router.replace('/enrol-mfa');
          return null;
        }
        if (caught.code === 'mfa_required') {
          router.replace('/mfa');
          return null;
        }
        setError(caught.message);
      } else {
        setError('Cannot reach the server.');
      }
      return null;
    } finally {
      setLoading(false);
    }
  }, [router]);

  useAsyncEffect(() => refresh(), [refresh]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      setMe(null);
      router.replace('/login');
    }
  }, [router]);

  const value = useMemo<SessionState>(
    () => ({
      me,
      loading,
      error,
      refresh,
      logout,
      can: (permission: string) => Boolean(me?.permissions.includes(permission)),
    }),
    [me, loading, error, refresh, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const context = useContext(SessionContext);
  if (!context) throw new Error('useSession must be used inside SessionProvider');
  return context;
}
