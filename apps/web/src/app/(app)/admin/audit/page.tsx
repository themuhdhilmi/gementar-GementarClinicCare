'use client';

import { useCallback, useState } from 'react';
import { api, type AuditRow, type Page } from '@/lib/api';
import { useAsyncEffect } from '@/lib/use-async';
import { Alert, Card, Chip, EmptyState, Select, Field, timeAgo } from '@/components/ui';

type Summary = {
  breakGlass: { last24h: number; last7d: number };
  failedLogins: { last24h: number; last7d: number };
};

const FILTERS = [
  { value: '', label: 'Everything' },
  { value: 'audit.break_glass', label: 'Break-glass access' },
  { value: 'auth.login_failed', label: 'Failed sign-ins' },
  { value: 'auth.login', label: 'Sign-ins' },
  { value: 'user.role_changed', label: 'Role changes' },
  { value: 'user.disabled', label: 'Accounts disabled' },
  { value: 'user.mfa_reset', label: 'MFA resets' },
];

export default function AuditPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [events, setEvents] = useState<Page<AuditRow> | null>(null);
  const [action, setAction] = useState('');
  const [days, setDays] = useState('7');

  const load = useCallback(async () => {
    const [nextSummary, nextEvents] = await Promise.all([
      api<Summary>('/audit/summary'),
      api<Page<AuditRow>>('/audit/events', {
        query: { action: action || undefined, days: Number(days), pageSize: 50 },
      }),
    ]);
    setSummary(nextSummary);
    setEvents(nextEvents);
  }, [action, days]);

  useAsyncEffect(() => load(), [load]);

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Audit</h1>
        <p className="text-sm text-muted">
          Who did what, and when. Entries cannot be edited or deleted, by anyone.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="Break-glass access" description="An administrator reading clinical records.">
          <Counters
            last24h={summary?.breakGlass.last24h ?? 0}
            last7d={summary?.breakGlass.last7d ?? 0}
          />
          {(summary?.breakGlass.last24h ?? 0) > 0 && (
            <Alert tone="warning">
              Legitimate when someone is fixing a problem. Worth a question if it was not.
            </Alert>
          )}
        </Card>
        <Card title="Failed sign-ins" description="Wrong passwords, locked or unknown accounts.">
          <Counters
            last24h={summary?.failedLogins.last24h ?? 0}
            last7d={summary?.failedLogins.last7d ?? 0}
          />
        </Card>
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Show">
              <Select value={action} onChange={(event) => setAction(event.target.value)}>
                {FILTERS.map((filter) => (
                  <option key={filter.value} value={filter.value}>
                    {filter.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-40">
            <Field label="Period">
              <Select value={days} onChange={(event) => setDays(event.target.value)}>
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
              </Select>
            </Field>
          </div>
        </div>
      </Card>

      {!events ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : events.items.length === 0 ? (
        <EmptyState title="Nothing recorded for that filter" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5 font-medium">When</th>
                <th className="px-4 py-2.5 font-medium">Action</th>
                <th className="px-4 py-2.5 font-medium">Who</th>
                <th className="px-4 py-2.5 font-medium">Subject</th>
                <th className="px-4 py-2.5 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {events.items.map((row) => (
                <tr key={row.id}>
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                    {timeAgo(row.occurredAt)}
                  </td>
                  <td className="px-4 py-2.5">
                    {row.action === 'audit.break_glass' ? (
                      <Chip tone="LOCKED">break-glass</Chip>
                    ) : (
                      <span className="font-mono text-xs">{row.action}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <p>{row.actorName}</p>
                    <p className="text-xs text-muted">{row.actorRole ?? '—'}</p>
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {row.entityType}
                    {row.entityId ? ` · ${row.entityId.slice(-8)}` : ''}
                  </td>
                  <td className="max-w-md truncate px-4 py-2.5 text-xs text-muted">
                    {row.reason ?? summarise(row.after)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Counters({ last24h, last7d }: { last24h: number; last7d: number }) {
  return (
    <dl className="flex gap-8">
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted">Last 24 hours</dt>
        <dd className="text-2xl font-semibold tabular-nums">{last24h}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted">Last 7 days</dt>
        <dd className="text-2xl font-semibold tabular-nums">{last7d}</dd>
      </div>
    </dl>
  );
}

function summarise(after: unknown): string {
  if (!after || typeof after !== 'object') return '';
  return Object.entries(after as Record<string, unknown>)
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
    .join(' · ');
}
