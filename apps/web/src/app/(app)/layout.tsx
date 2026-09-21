"use client";

import { SessionProvider, useSession } from "@/lib/session";
import { AppShell } from "@/components/app-shell";
import { Logo } from "@/components/logo";
import { Alert, Button } from "@/components/ui";

function Gate({ children }: { children: React.ReactNode }) {
  const { me, loading, error, suspended, logout } = useSession();

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="h-8 w-40 animate-pulse rounded-md bg-surface-muted" />
        <div className="mt-4 h-48 animate-pulse rounded-lg bg-surface-muted" />
      </div>
    );
  }

  // TEN-F-03: the clinic is suspended. Its data is untouched, and there is
  // nothing the person at the counter can do, so the screen says so plainly
  // rather than bouncing them back to a login that will not work.
  if (suspended) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 px-4 py-16 text-center">
        <Logo className="h-12 w-auto" priority />
        <h1 className="text-xl font-semibold">
          This clinic account is suspended
        </h1>
        <p className="text-sm text-muted">{suspended}</p>
        <p className="text-sm text-muted">
          Nothing has been deleted. Every record is exactly as it was and comes
          back the moment access is restored.
        </p>
        <Button variant="secondary" onClick={() => void logout()}>
          Sign out
        </Button>
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
