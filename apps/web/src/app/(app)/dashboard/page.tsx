'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  minutes,
  senToRinggit,
  type DashboardTiles,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { Alert, Card, EmptyState } from '@/components/ui';

const STATION: Record<string, string> = {
  REGISTERED: 'Waiting for triage',
  TRIAGE_IN_PROGRESS: 'In triage',
  DOCTOR_WAITING: 'Waiting for the doctor',
  IN_CONSULTATION: 'With the doctor',
  PHARMACY_WAITING: 'Waiting at the pharmacy',
  DISPENSING: 'Being dispensed',
  PAYMENT_WAITING: 'Waiting to pay',
};

/**
 * The numbers the owner checks before going home (RPT-F-01).
 *
 * Financial tiles are **absent** rather than empty for anybody without
 * the permission — the API does not send them, so there is nothing here
 * to hide. That is the difference between a screen that does not show a
 * number and one that was told the number and chose not to draw it.
 */
export default function DashboardPage() {
  const { me, can } = useSession();
  const branchId = me?.activeBranchId;
  const [tiles, setTiles] = useState<DashboardTiles | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [freshAt, setFreshAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      setTiles(await api<DashboardTiles>(`/branches/${branchId}/dashboard`));
      setFreshAt(new Date());
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not read the dashboard.');
    }
  }, [branchId]);

  useAsyncEffect(() => load(), [load]);

  // RPT-F-02: the stream carries a nudge, not the numbers, and the
  // server already coalesces to one every five seconds — so this can
  // re-read on every message without thinking about it.
  //
  // `load` is held in a ref so the connection is opened once per branch
  // rather than being torn down and rebuilt every time the callback
  // changes identity. The ref is written inside an effect, not during
  // render, because a render can be thrown away and re-run.
  const reload = useRef(load);
  useEffect(() => {
    reload.current = load;
  }, [load]);

  useEffect(() => {
    if (!branchId) return;
    const source = new EventSource(`/api/v1/branches/${branchId}/dashboard/stream`);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { heartbeat?: string };
      if (!payload.heartbeat) void reload.current();
    };
    return () => source.close();
  }, [branchId]);

  if (!branchId) return <EmptyState title="No branch selected" />;
  if (!tiles) return <p className="text-sm text-muted">Loading…</p>;

  const waiting = tiles.queue.reduce((sum, row) => sum + row.waiting, 0);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold">Today</h1>
          <p className="text-sm text-muted">
            {tiles.day} · {tiles.timezone}
            {freshAt ? ` · updated ${freshAt.toLocaleTimeString('en-MY')}` : ''}
          </p>
        </div>
        <Link href="/reports" className="text-sm text-primary-ink underline">
          All reports
        </Link>
      </div>

      {error && <Alert title="Not shown">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Tile
          title="Patients today"
          value={String(tiles.patients.registered)}
          hint={`${tiles.patients.completed} finished · ${tiles.patients.inProgress} still here`}
          href="/reports/patient-register"
        />
        <Tile
          title="Waiting now"
          value={String(waiting)}
          hint={
            tiles.queue.length === 0
              ? 'Nobody is waiting'
              : tiles.queue
                  .map((row) => `${STATION[row.status] ?? row.status}: ${row.waiting}`)
                  .join(' · ')
          }
          href="/queue"
        />
        <Tile
          title="Average wait to the doctor"
          value={minutes(tiles.waitToDoctor.meanSeconds)}
          hint={`${tiles.waitToDoctor.seen} called today`}
          href="/reports/queue-performance"
        />

        {tiles.money ? (
          <>
            <Tile
              title="Billed today"
              value={senToRinggit(tiles.money.billedSen)}
              hint={`${tiles.money.issued} invoice${tiles.money.issued === 1 ? '' : 's'} · ${senToRinggit(
                tiles.money.discountedSen,
              )} discounted`}
              href="/reports/daily-sales"
            />
            <Tile
              title="Voided today"
              value={String(tiles.money.voided)}
              hint={
                tiles.money.voided === 0
                  ? 'Nothing cancelled after being issued'
                  : `${senToRinggit(tiles.money.voidedSen)} taken back`
              }
              href="/reports/voids"
            />
            <Tile
              title="Collected today"
              value={senToRinggit(tiles.collections?.totalSen ?? '0')}
              hint={
                Object.keys(tiles.collections?.byMethod ?? {}).length === 0
                  ? 'Nothing taken yet'
                  : Object.entries(tiles.collections?.byMethod ?? {})
                      .map(([method, total]) => `${method.replace('_', ' ')}: ${senToRinggit(total)}`)
                      .join(' · ')
              }
              href="/reports/collections"
            />
          </>
        ) : null}

        <Tile
          title="Drawer"
          value={tiles.cashSession.open ? senToRinggit(tiles.cashSession.expectedCashSen) : '—'}
          hint={
            tiles.cashSession.open
              ? `${tiles.cashSession.drawerCode} open since ${new Date(
                  tiles.cashSession.openedAt,
                ).toLocaleTimeString('en-MY')}`
              : 'No drawer is open — nothing can be taken'
          }
          href="/drawer"
          tone={tiles.cashSession.open ? undefined : 'warning'}
        />
        <Tile
          title="Stock needing attention"
          value={String(tiles.stock.low + tiles.stock.critical)}
          hint={`${tiles.stock.critical} critical · ${tiles.stock.expiring} expiring · ${tiles.stock.expired} expired`}
          href="/reports/stock-alerts"
          tone={tiles.stock.critical > 0 ? 'warning' : undefined}
        />
        <Tile
          title="Unsigned notes"
          value={String(tiles.unsignedDraftsOver24h)}
          hint="Drafts more than a day old. A visit with no record."
          tone={tiles.unsignedDraftsOver24h > 0 ? 'warning' : undefined}
        />
        {tiles.money ? (
          <Tile
            title="Unbilled visits"
            value={String(tiles.money.openDrafts)}
            hint="Bills started and never issued."
            tone={tiles.money.openDrafts > 0 ? 'warning' : undefined}
            href="/billing"
          />
        ) : null}
      </div>

      {!can('report.financial') && (
        <p className="text-xs text-muted">
          Takings, discounts and outstanding balances are the administrator&rsquo;s.
        </p>
      )}
    </div>
  );
}

function Tile({
  title,
  value,
  hint,
  href,
  tone,
}: {
  title: string;
  value: string;
  hint: string;
  href?: string;
  tone?: 'warning';
}) {
  const body = (
    <Card title={title} className={tone === 'warning' ? 'border-warning/50' : undefined}>
      <p className="text-3xl font-semibold tabular-nums">{value}</p>
      <p className="mt-1 text-sm text-muted">{hint}</p>
    </Card>
  );
  return href ? (
    <Link href={href} className="block transition-opacity hover:opacity-90">
      {body}
    </Link>
  ) : (
    body
  );
}
