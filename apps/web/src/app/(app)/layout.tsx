'use client';

import { SessionProvider, useSession } from '@/lib/session';
import { AppShell } from '@/components/app-shell';
import { Alert } from '@/components/ui';

function Gate({ children }: { children: React.ReactNode }) {
  const { me, loading, error } = useSession();

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="h-8 w-40 animate-pulse rounded-md bg-surface-muted" />
        <div className="mt-4 h-48 animate-pulse rounded-lg bg-surface-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-md px-4 py-10">
        <Alert title="Cannot load your session">{error}</Alert>
      </div>
    );
  }

  if (!me) return null;
  return <AppShell>{children}</AppShell>;
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}
