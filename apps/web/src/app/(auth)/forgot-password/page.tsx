'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { Alert, Button, Card, TextField } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/auth/password/forgot', { method: 'POST', body: { email } });
    } finally {
      // The API answers the same way whether or not the account exists, and so
      // does this screen.
      setSent(true);
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Card title="Check your email">
        <Alert tone="info">
          If that account exists, we have sent a link to reset its password. The link works once and
          expires in 30 minutes.
        </Alert>
        <Link
          href="/login"
          className="mt-4 inline-block text-sm text-muted underline underline-offset-4"
        >
          Back to sign in
        </Link>
      </Card>
    );
  }

  return (
    <Card title="Reset your password" description="We will email you a link.">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <TextField
          label="Email"
          type="email"
          autoFocus
          required
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <Button type="submit" loading={busy}>
          Send the link
        </Button>
        <Link href="/login" className="text-sm text-muted underline underline-offset-4">
          Back to sign in
        </Link>
      </form>
    </Card>
  );
}
