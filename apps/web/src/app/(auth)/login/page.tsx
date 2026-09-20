'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, api } from '@/lib/api';
import { Alert, Button, Card, TextField } from '@/components/ui';

type LoginResponse = {
  mfaRequired: boolean;
  mfaEnrolmentRequired: boolean;
};

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [retryAfter, setRetryAfter] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setRetryAfter(null);
    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        body: { email, password },
      });
      if (result.mfaEnrolmentRequired) router.replace('/enrol-mfa');
      else if (result.mfaRequired) router.replace('/mfa');
      else router.replace('/workspace');
    } catch (caught) {
      if (caught instanceof ApiError) {
        // The server deliberately says the same thing for a wrong password, an
        // unknown address and a locked account. Do not embellish it here.
        setError(caught.message);
        if (caught.code === 'rate_limited') {
          const seconds = (caught.problem.errors as { retryAfter?: number } | undefined)?.retryAfter;
          if (seconds) setRetryAfter(Math.ceil(seconds / 60));
        }
      } else {
        setError('Cannot reach the server. Check the connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Sign in" description="Use the account your clinic administrator created for you.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        {error && (
          <Alert tone={retryAfter ? 'warning' : 'danger'}>
            {error}
            {retryAfter ? ` Try again in about ${retryAfter} minute${retryAfter === 1 ? '' : 's'}.` : ''}
          </Alert>
        )}
        <TextField
          label="Email"
          type="email"
          name="email"
          autoFocus
          required
          autoComplete="username"
          inputMode="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          name="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <Button type="submit" loading={busy}>
          Sign in
        </Button>
        <Link href="/forgot-password" className="text-sm text-muted underline underline-offset-4">
          Forgot your password?
        </Link>
      </form>
      <p className="mt-6 border-t border-line pt-4 text-xs text-muted">
        Accounts are personal. Never sign in as a colleague — every clinical record is attributed to
        whoever is signed in.
      </p>
    </Card>
  );
}
