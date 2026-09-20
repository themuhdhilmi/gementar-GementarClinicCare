'use client';

import { useCallback, useState } from 'react';
import Image from 'next/image';
import { ApiError, api } from '@/lib/api';
import { useAsyncEffect } from '@/lib/use-async';
import { Alert, Button, Card, Field, Input } from './ui';

type Offer = { secret: string; otpauthUri: string; qrDataUrl: string };

/**
 * Enrolment, used both when an administrator is forced through it at first
 * sign-in and when anyone turns it on from their account page.
 */
export function MfaEnrolment({
  forced,
  onDone,
}: {
  forced: boolean;
  onDone: () => void;
}) {
  const [offer, setOffer] = useState<Offer | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showKey, setShowKey] = useState(false);

  const start = useCallback(async () => {
    setError(null);
    try {
      setOffer(await api<Offer>('/auth/me/mfa/enrol', { method: 'POST' }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start enrolment.');
    }
  }, []);

  useAsyncEffect(() => start(), [start]);

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ recoveryCodes: string[] }>('/auth/me/mfa/confirm', {
        method: 'POST',
        body: { code },
      });
      setRecoveryCodes(result.recoveryCodes);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not confirm that code.');
      setCode('');
    } finally {
      setBusy(false);
    }
  }

  if (recoveryCodes) {
    return (
      <Card title="Save your recovery codes" description="This is the only time they are shown.">
        <Alert tone="warning">
          Each code signs you in once if you lose your phone. Print them, or put them somewhere only
          you can reach. Without them, an administrator has to reset your second factor in person.
        </Alert>
        <ul className="my-4 grid grid-cols-2 gap-2 font-mono text-sm">
          {recoveryCodes.map((recoveryCode) => (
            <li key={recoveryCode} className="rounded-md bg-surface-muted px-3 py-2 text-center">
              {recoveryCode}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            onClick={() => void navigator.clipboard.writeText(recoveryCodes.join('\n'))}
          >
            Copy all
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = 'cliniccare-recovery-codes.txt';
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            Download
          </Button>
          <Button onClick={onDone}>I have saved them</Button>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title={forced ? 'Set up two-step verification' : 'Turn on two-step verification'}
      description={
        forced
          ? 'Administrators can read every clinical record, so a second factor is required before you can continue.'
          : 'Adds a code from your phone to your password.'
      }
    >
      {error && <Alert>{error}</Alert>}

      {!offer ? (
        <p className="text-sm text-muted">Preparing…</p>
      ) : (
        <div className="flex flex-col gap-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted">
            <li>Open an authenticator app such as Google Authenticator or Aegis.</li>
            <li>Scan this code.</li>
            <li>Type the 6 digits it shows.</li>
          </ol>

          <div className="flex justify-center rounded-md border border-line bg-white p-3">
            <Image
              src={offer.qrDataUrl}
              alt="QR code for two-step verification setup"
              width={200}
              height={200}
              unoptimized
            />
          </div>

          <button
            type="button"
            className="text-sm text-muted underline underline-offset-4"
            onClick={() => setShowKey(!showKey)}
          >
            {showKey ? 'Hide the setup key' : 'Cannot scan? Show the setup key'}
          </button>
          {showKey && (
            <p className="rounded-md bg-surface-muted px-3 py-2 text-center font-mono text-sm break-all">
              {offer.secret}
            </p>
          )}

          <form onSubmit={confirm} className="flex flex-col gap-3">
            <Field label="Code from the app">
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                value={code}
                className="text-center font-mono text-2xl tracking-[0.5em]"
                onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
            </Field>
            <Button type="submit" loading={busy} disabled={code.length !== 6}>
              Confirm and finish
            </Button>
          </form>
        </div>
      )}
    </Card>
  );
}
