'use client';

import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Alert, Button, Modal, TextField } from './ui';

/**
 * IAM-F-11 made visible: when the API says a sensitive action needs a fresh
 * proof of identity, ask for the password here and retry the action rather
 * than throwing the person back to the login screen.
 */
export function useReauth() {
  const [pending, setPending] = useState<null | (() => Promise<void>)>(null);

  async function guard(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'reauth_required') {
        setPending(() => action);
        return;
      }
      throw caught;
    }
  }

  const dialog = (
    <ReauthDialog
      open={pending !== null}
      onCancel={() => setPending(null)}
      onConfirmed={async () => {
        const action = pending;
        setPending(null);
        if (action) await action();
      }}
    />
  );

  return { guard, dialog };
}

function ReauthDialog({
  open,
  onCancel,
  onConfirmed,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirmed: () => Promise<void>;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/reauth', { method: 'POST', body: { password } });
      setPassword('');
      await onConfirmed();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not confirm.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} title="Confirm it is you" onClose={onCancel}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          This action changes how the account is secured, so it needs your password again. The
          confirmation lasts five minutes.
        </p>
        {error && <Alert>{error}</Alert>}
        <TextField
          label="Password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" loading={busy}>
            Confirm
          </Button>
        </div>
      </form>
    </Modal>
  );
}
