'use client';

import { useCallback, useState } from 'react';
import {
  ApiError,
  api,
  ROLE_LABEL,
  type Page,
  type Role,
  type UserRow,
  type UserStatus,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import {
  Alert,
  Button,
  Card,
  Chip,
  Drawer,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  TextField,
  timeAgo,
} from '@/components/ui';

const ROLES: Role[] = ['ADMIN', 'DOCTOR', 'NURSE', 'FRONTDESK'];
const STATUSES: UserStatus[] = ['ACTIVE', 'INVITED', 'LOCKED', 'DISABLED'];

type Draft = {
  name: string;
  email: string;
  phone: string;
  roles: Array<{ branchId: string; role: Role }>;
};

export default function UsersPage() {
  const { me } = useSession();
  const [page, setPage] = useState<Page<UserRow> | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<UserStatus | ''>('');
  const [branchId, setBranchId] = useState('');
  const [role, setRole] = useState<Role | ''>('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const [confirming, setConfirming] = useState<UserRow | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await api<Page<UserRow>>('/users', {
      query: { q: query || undefined, status: status || undefined, branchId: branchId || undefined, role: role || undefined, pageSize: 50 },
    });
    setPage(result);
  }, [query, status, branchId, role]);

  // Search as you type, without a request per keystroke.
  useAsyncEffect(() => load(), [load], { debounceMs: 200 });

  if (!me) return null;
  const branches = me.branches;

  async function act(action: () => Promise<void>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      await load();
      setNotice(message);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Staff</h1>
          <p className="text-sm text-muted">
            Everyone with a login. Disabling is immediate; nobody is ever deleted.
          </p>
        </div>
        <Button onClick={() => setEditing('new')}>Add a person</Button>
      </div>

      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert>{error}</Alert>}
      {inviteLink && (
        <Alert tone="info" title="Invitation link">
          Email is not connected yet, so hand this link over yourself. It works once and expires in
          72 hours.
          <p className="mt-2 font-mono text-xs break-all">{inviteLink}</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => void navigator.clipboard.writeText(inviteLink)}>
              Copy
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setInviteLink(null)}>
              Dismiss
            </Button>
          </div>
        </Alert>
      )}

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <Field label="Search">
              <Input
                placeholder="Name, email or phone"
                value={query}
                autoFocus
                onChange={(event) => setQuery(event.target.value)}
              />
            </Field>
          </div>
          <div className="w-40">
            <Field label="Status">
              <Select value={status} onChange={(event) => setStatus(event.target.value as UserStatus | '')}>
                <option value="">Any</option>
                {STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {value.charAt(0) + value.slice(1).toLowerCase()}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-48">
            <Field label="Branch">
              <Select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
                <option value="">Any</option>
                {branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-44">
            <Field label="Role">
              <Select value={role} onChange={(event) => setRole(event.target.value as Role | '')}>
                <option value="">Any</option>
                {ROLES.map((value) => (
                  <option key={value} value={value}>
                    {ROLE_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      {!page ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : page.items.length === 0 ? (
        <EmptyState title="Nobody matches that">Try a different search or filter.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Roles</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Last sign-in</th>
                <th className="px-4 py-2.5 font-medium">MFA</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {page.items.map((user) => (
                <tr key={user.id} className="align-middle">
                  <td className="px-4 py-3">
                    <p className="font-medium">{user.name}</p>
                    <p className="text-xs text-muted">{user.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {user.roles.map((assignment) => (
                        <span
                          key={`${assignment.branchId}:${assignment.role}`}
                          className="rounded bg-surface-muted px-1.5 py-0.5 text-xs"
                        >
                          {ROLE_LABEL[assignment.role]}
                          <span className="text-muted">
                            {' '}
                            · {branches.find((b) => b.id === assignment.branchId)?.code ?? '—'}
                          </span>
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Chip>{user.status}</Chip>
                  </td>
                  <td className="px-4 py-3 text-muted">
                    {user.lastLoginAt ? timeAgo(user.lastLoginAt) : 'never'}
                  </td>
                  <td className="px-4 py-3 text-muted">{user.mfaEnabled ? 'On' : 'Off'}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap justify-end gap-1.5">
                      <Button size="sm" variant="secondary" onClick={() => setEditing(user)}>
                        Edit
                      </Button>
                      {user.status === 'LOCKED' && (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void act(() => api(`/users/${user.id}/unlock`, { method: 'POST' }), `${user.name} is unlocked.`)}
                        >
                          Unlock
                        </Button>
                      )}
                      {user.status === 'DISABLED' ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void act(() => api(`/users/${user.id}/enable`, { method: 'POST' }), `${user.name} can sign in again.`)}
                        >
                          Enable
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => setConfirming(user)}>
                          Disable
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <UserDrawer
        key={editing === 'new' ? 'new' : (editing?.id ?? 'closed')}
        target={editing}
        branches={branches.map((b) => ({ id: b.id, code: b.code, name: b.name }))}
        busy={busy}
        onClose={() => setEditing(null)}
        onCreated={(link) => {
          setInviteLink(link ?? null);
          setEditing(null);
          void load();
          setNotice('Invitation created.');
        }}
        onSaved={() => {
          setEditing(null);
          void load();
          setNotice('Saved.');
        }}
        onError={setError}
        onAction={act}
      />

      <Modal
        open={confirming !== null}
        title={`Disable ${confirming?.name ?? ''}?`}
        onClose={() => setConfirming(null)}
      >
        <p className="text-sm text-muted">
          They are signed out everywhere immediately and cannot sign in again until you re-enable
          them. Their name stays on every record they have already made.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={() => {
              const user = confirming;
              setConfirming(null);
              if (user) {
                void act(
                  () => api(`/users/${user.id}/disable`, { method: 'POST', body: {} }),
                  `${user.name} is disabled and signed out.`,
                );
              }
            }}
          >
            Disable
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function UserDrawer({
  target,
  branches,
  busy,
  onClose,
  onCreated,
  onSaved,
  onError,
  onAction,
}: {
  target: UserRow | 'new' | null;
  branches: Array<{ id: string; code: string; name: string }>;
  busy: boolean;
  onClose: () => void;
  onCreated: (inviteLink?: string) => void;
  onSaved: () => void;
  onError: (message: string) => void;
  onAction: (action: () => Promise<void>, message: string) => Promise<void>;
}) {
  const isNew = target === 'new';
  const user = target === 'new' ? null : target;
  // The drawer is remounted per person (see `key` at the call site), so the
  // draft starts from the right row without an effect to copy props to state.
  const [draft, setDraft] = useState<Draft>(() =>
    user
      ? { name: user.name, email: user.email, phone: user.phone ?? '', roles: user.roles }
      : { name: '', email: '', phone: '', roles: [] },
  );
  const [saving, setSaving] = useState(false);

  if (!target) return null;

  const toggle = (branchId: string, role: Role) => {
    setDraft((current) => {
      const exists = current.roles.some((r) => r.branchId === branchId && r.role === role);
      return {
        ...current,
        roles: exists
          ? current.roles.filter((r) => !(r.branchId === branchId && r.role === role))
          : [...current.roles, { branchId, role }],
      };
    });
  };

  async function save() {
    setSaving(true);
    try {
      if (isNew) {
        const created = await api<{ invite: { link?: string } }>('/users', {
          method: 'POST',
          body: {
            name: draft.name,
            email: draft.email,
            phone: draft.phone || undefined,
            roles: draft.roles,
          },
        });
        onCreated(created.invite.link);
      } else if (user) {
        await api(`/users/${user.id}`, {
          method: 'PATCH',
          body: { name: draft.name, phone: draft.phone || null },
        });
        await api(`/users/${user.id}/roles`, { method: 'PUT', body: { roles: draft.roles } });
        onSaved();
      }
    } catch (caught) {
      onError(caught instanceof ApiError ? caught.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      open
      title={isNew ? 'Add a person' : `Edit ${user?.name ?? ''}`}
      onClose={onClose}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={saving}
            disabled={draft.roles.length === 0 || draft.name.trim() === ''}
            onClick={() => void save()}
          >
            {isNew ? 'Create and invite' : 'Save changes'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <TextField
          label="Full name"
          value={draft.name}
          autoFocus
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
        />
        <TextField
          label="Email"
          type="email"
          value={draft.email}
          disabled={!isNew}
          hint={isNew ? 'The invitation goes here.' : 'Changing an email address is not supported yet.'}
          onChange={(event) => setDraft({ ...draft, email: event.target.value })}
        />
        <TextField
          label="Phone"
          value={draft.phone}
          hint="Malaysian numbers can be typed as 012-3456789."
          onChange={(event) => setDraft({ ...draft, phone: event.target.value })}
        />

        <fieldset className="rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-medium">Roles by branch</legend>
          <p className="mb-2 text-xs text-muted">
            Permissions apply at the branch where they are granted. At least one is required.
          </p>
          <div className="flex flex-col gap-3">
            {branches.map((branch) => (
              <div key={branch.id}>
                <p className="text-sm font-medium">
                  {branch.name} <span className="text-muted">({branch.code})</span>
                </p>
                <div className="mt-1 flex flex-wrap gap-3">
                  {ROLES.map((role) => (
                    <label key={role} className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        className="size-4"
                        checked={draft.roles.some((r) => r.branchId === branch.id && r.role === role)}
                        onChange={() => toggle(branch.id, role)}
                      />
                      {ROLE_LABEL[role]}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        {user && (
          <div className="rounded-md border border-line p-3">
            <p className="text-sm font-medium">Account recovery</p>
            <p className="mb-2 text-xs text-muted">
              Each of these signs the person out everywhere, and is recorded in the audit trail.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void onAction(
                    () => api(`/users/${user.id}/password/force-reset`, { method: 'POST' }),
                    'A reset link has been sent.',
                  )
                }
              >
                Force password reset
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void onAction(
                    () => api(`/users/${user.id}/sessions/revoke-all`, { method: 'POST' }),
                    'Signed out of every device.',
                  )
                }
              >
                Sign out everywhere
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy || !user.mfaEnabled}
                onClick={() =>
                  void onAction(
                    () =>
                      api(`/users/${user.id}/mfa/reset`, {
                        method: 'POST',
                        body: { reason: 'Identity verified in person' },
                      }),
                    'Two-step verification reset. They must enrol again.',
                  )
                }
              >
                Reset two-step verification
              </Button>
            </div>
          </div>
        )}
      </div>
    </Drawer>
  );
}
