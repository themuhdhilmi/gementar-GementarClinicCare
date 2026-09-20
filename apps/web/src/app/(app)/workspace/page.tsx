'use client';

import Link from 'next/link';
import { ROLE_LABEL } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Alert, Card } from '@/components/ui';

/**
 * A placeholder workspace. The real role workspaces — reception, triage,
 * doctor, pharmacy, cashier — arrive with their own modules; this page exists
 * so signing in lands somewhere sensible and shows what access you have.
 */
export default function WorkspacePage() {
  const { me, can } = useSession();
  if (!me) return null;

  const branch = me.branches.find((b) => b.id === me.activeBranchId);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Good day, {me.user.name.split(' ')[0]}</h1>
        <p className="text-sm text-muted">
          Signed in at {branch?.name ?? 'an unknown branch'} as{' '}
          {me.roles.map((role) => ROLE_LABEL[role]).join(', ').toLowerCase() || 'no role'}.
        </p>
      </div>

      {me.mfa.enabled && me.mfa.recoveryCodesRemaining <= 2 && (
        <Alert tone="warning" title="Running low on recovery codes">
          You have {me.mfa.recoveryCodesRemaining} left. Generate a fresh set from{' '}
          <Link href="/account" className="underline underline-offset-4">
            your account
          </Link>{' '}
          before you run out.
        </Alert>
      )}

      {!me.mfa.enabled && (
        <Alert tone="info" title="Two-step verification is off">
          It is not required for your role, but it is the single best protection for a clinical
          account.{' '}
          <Link href="/account" className="underline underline-offset-4">
            Turn it on
          </Link>
          .
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Your access" description="What this role can do at this branch.">
          <ul className="grid grid-cols-1 gap-1 text-sm sm:grid-cols-2">
            {me.permissions.map((permission) => (
              <li key={permission} className="font-mono text-xs text-muted">
                {permission}
              </li>
            ))}
          </ul>
        </Card>

        <Card title="Coming next" description="Modules that will land in this workspace.">
          <ul className="space-y-2 text-sm text-muted">
            <li>Patient registry and fast search</li>
            <li>Live queue board, per station</li>
            <li>Triage vitals and the consultation workspace</li>
            <li>Pharmacy queue, dispensing and stock</li>
            <li>Billing, payment and receipts</li>
          </ul>
          {can('admin.users') && (
            <p className="mt-4 text-sm">
              In the meantime, set up your staff on the{' '}
              <Link href="/admin/users" className="underline underline-offset-4">
                staff page
              </Link>
              .
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
