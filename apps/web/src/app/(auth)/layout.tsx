import { BrandPanel } from '@/components/brand-panel';
import { Logo } from '@/components/logo';

/**
 * Split sign-in layout: the form on the left, where the eye and the tab order
 * both start, and the product panel on the right. Below `lg` the panel is not
 * rendered at all, so a phone or a small reception monitor gets the form and
 * nothing competing with it.
 */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const environment = process.env.NEXT_PUBLIC_ENVIRONMENT;

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <div className="flex min-h-screen flex-col">
        <header className="flex items-center justify-between px-6 py-6 sm:px-10">
          <Logo className="h-10 w-auto" compact priority />

          {/* A visible environment badge, so nobody types production
              credentials into staging by accident. */}
          {environment && (
            <span className="rounded-full border border-warning/40 bg-warning-soft px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-warning">
              {environment}
            </span>
          )}
        </header>

        <main className="flex flex-1 items-center justify-center px-6 py-6 sm:px-10">
          <div className="w-full max-w-[26rem]">{children}</div>
        </main>

        <footer className="px-6 pb-8 sm:px-10">
          <div className="flex flex-col gap-1 border-t border-line pt-5 text-xs text-muted sm:flex-row sm:items-center sm:gap-6">
            <p>Trouble signing in? Ask your clinic administrator.</p>
            <p className="sm:ml-auto">Accounts are personal and are never shared.</p>
          </div>
        </footer>
      </div>

      <BrandPanel />
    </div>
  );
}
