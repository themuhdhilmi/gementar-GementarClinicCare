'use client';

import { useCallback, useState } from 'react';
import { ApiError, api, type SessionRow } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { useReauth } from '@/components/reauth';
import { MfaEnrolment } from '@/components/mfa-enrolment';
import { PasswordField } from '@/components/password-field';
import { Alert, Button, Card, Chip, EmptyState, timeAgo } from '@/components/ui';

export default function AccountPage() {
  const { me, refresh } = useSession();
  const { guard, dialog } = useReauth();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [password, setPassword] = useState('');
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadSessions = useCallback(async () => {
    const result = await api<{ items: SessionRow[] }>('/auth/me/sessions');
    setSessions(result.items);
  }, []);

  useAsyncEffect(() => loadSessions(), [loadSessions]);

  if (!me) return null;

  async function run(action: () => Promise<void>, message?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await guard(action);
      if (message) setNotice(message);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    setPasswordMessage(null);
    await run(async () => {
      try {
        await api('/auth/me/password', { method: 'PUT', body: { password } });
        setPassword('');
        await loadSessions();
      } catch (caught) {
        if (caught instanceof ApiError && caught.code === 'password_rejected') {
          setPasswordMessage(caught.message);
          return;
        }
        throw caught;
      }
    }, 'Password changed. Your other devices have been signed out.');
  }

  if (enrolling) {
    return (
      <div className="mx-auto max-w-md">
        <MfaEnrolment
          forced={false}
          onDone={async () => {
            setEnrolling(false);
            await refresh();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">My account</h1>
        <p className="text-sm text-muted">
          {me.user.name} · {me.user.email}
        </p>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}

      <Card
        title="Signed-in devices"
        description="Anything you do not recognise should be signed out, then tell your administrator."
      >
        {sessions.length === 0 ? (
          <EmptyState title="No other sessions" />
        ) : (
          <ul className="divide-y divide-line">
            {sessions.map((session) => (
              <li key={session.id} className="flex items-center gap-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {describeDevice(session.userAgent)}{' '}
                    {session.current && <Chip tone="ACTIVE">this device</Chip>}
                  </p>
                  <p className="text-xs text-muted">
                    {session.ip ?? 'unknown address'} · last used {timeAgo(session.lastSeenAt)} ·
                    signed in {timeAgo(session.createdAt)}
                  </p>
                </div>
                {!session.current && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void run(async () => {
                        await api(`/auth/me/sessions/${session.id}`, { method: 'DELETE' });
                        await loadSessions();
                      }, 'That device has been signed out.')
                    }
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Two-step verification"
        description={
          me.mfa.required
            ? 'Required for your role. It cannot be switched off.'
            : 'A code from your phone, on top of your password.'
        }
      >
        {me.mfa.enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <Chip tone="ACTIVE">On</Chip>
              <p className="mt-1 text-sm text-muted">
                {me.mfa.recoveryCodesRemaining} recovery code
                {me.mfa.recoveryCodesRemaining === 1 ? '' : 's'} left.
              </p>
            </div>
            {!me.mfa.required && (
              <Button
                variant="danger"
                loading={busy}
                onClick={() =>
                  void run(async () => {
                    await api('/auth/me/mfa', { method: 'DELETE' });
                    await refresh();
                  }, 'Two-step verification is off.')
                }
              >
                Turn off
              </Button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Chip tone="DISABLED">Off</Chip>
            <Button onClick={() => setEnrolling(true)}>Turn on</Button>
          </div>
        )}
      </Card>

      <Card title="Change password" description="Signs out every other device.">
        <form onSubmit={changePassword} className="flex max-w-md flex-col gap-4">
          <PasswordField
            value={password}
            onChange={setPassword}
            context={{ email: me.user.email, name: me.user.name }}
            serverMessage={passwordMessage}
          />
          <Button type="submit" loading={busy} disabled={password.length < 12}>
            Change password
          </Button>
        </form>
      </Card>

      {dialog}
    </div>
  );
}

function describeDevice(userAgent: string | null): string {
  if (!userAgent) return 'Unknown device';
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Safari\//.test(userAgent) ? 'Safari'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : 'Browser';
  const platform =
    /Windows/.test(userAgent) ? 'Windows'
    : /Macintosh/.test(userAgent) ? 'Mac'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'device';
  return `${browser} on ${platform}`;
}
