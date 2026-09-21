"use client";

import { SessionProvider, useSession } from "@/lib/session";
import { Logo } from "@/components/logo";
import { Alert, Button } from "@/components/ui";

/**
 * The frame for a screen that is the whole of a monitor.
 *
 * Deliberately *not* `AppShell`. A station monitor stands on a counter
 * and does one job for twelve hours: the navigation rail, the branch
 * switcher and the page heading are all things nobody standing at the
 * pharmacy counter will ever press, and every one of them is a pixel
 * not spent on the number the patient is being called by.
 *
 * It is still signed in, unlike the waiting-room display. The people
 * using it are calling patients and opening records, and that has to be
 * attributable to somebody.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const { me, loading, error, suspended, logout } = useSession();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-surface-sunken">
        <div className="h-10 w-48 animate-pulse rounded-md bg-surface-muted" />
      </div>
    );
  }

  if (suspended) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-5 px-4 text-center">
        <Logo className="h-12 w-auto" priority />
        <h1 className="text-xl font-semibold">
          This clinic account is suspended
        </h1>
        <p className="text-sm text-muted">{suspended}</p>
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
  return <>{children}</>;
}

export default function StationLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <SessionProvider>
      <Gate>{children}</Gate>
    </SessionProvider>
  );
}
