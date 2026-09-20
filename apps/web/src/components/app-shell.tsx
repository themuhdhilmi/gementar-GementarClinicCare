'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { api, ROLE_LABEL } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Logo, LogoMark } from './logo';
import { Button, Select } from './ui';

/**
 * The header a clinic sees all day: who is signed in, which branch they are
 * working at, and the way out. The branch switcher is a server-side action —
 * the client is never trusted to say where someone may work.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, refresh, logout, can } = useSession();
  const pathname = usePathname();
  const [switching, setSwitching] = useState(false);

  if (!me) return null;

  const links = [
    { href: '/workspace', label: 'Workspace', show: true },
    { href: '/admin/users', label: 'Staff', show: can('admin.users') },
    { href: '/admin/branches', label: 'Branches', show: can('admin.settings') },
    { href: '/admin/clinic', label: 'Clinic', show: can('admin.settings') },
    { href: '/admin/audit', label: 'Audit', show: can('audit.read') },
    { href: '/account', label: 'My account', show: true },
  ].filter((link) => link.show);

  async function switchBranch(branchId: string) {
    setSwitching(true);
    try {
      await api('/auth/me/branch', { method: 'PUT', body: { branchId } });
      await refresh();
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
          {/* The breakpoint lives on the wrapper: Logo already uses display
              classes of its own to pick the light or dark artwork. */}
          <Link href="/workspace" aria-label="ClinicCare" className="flex items-center">
            <span className="hidden sm:block">
              <Logo className="h-10 w-auto" priority />
            </span>
            <span className="sm:hidden">
              <LogoMark className="size-8" />
            </span>
          </Link>

          <nav className="flex items-center gap-1" aria-label="Main">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname.startsWith(link.href) ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  pathname.startsWith(link.href)
                    ? 'bg-primary-soft font-medium text-primary-ink'
                    : 'text-muted hover:bg-surface-muted hover:text-foreground'
                }`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-3">
            {me.branches.length > 1 ? (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">Branch</span>
                <Select
                  value={me.activeBranchId}
                  disabled={switching}
                  onChange={(event) => void switchBranch(event.target.value)}
                  className="w-48"
                >
                  {me.branches.map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name} ({branch.code})
                    </option>
                  ))}
                </Select>
              </label>
            ) : (
              <span className="text-sm text-muted">
                {me.branches[0]?.name ?? 'No branch'}
              </span>
            )}

            <div className="hidden text-right sm:block">
              <p className="text-sm font-medium leading-tight">{me.user.name}</p>
              <p className="text-xs text-muted leading-tight">
                {me.roles.map((role) => ROLE_LABEL[role]).join(', ') || 'No role here'}
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={() => void logout()}>
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
