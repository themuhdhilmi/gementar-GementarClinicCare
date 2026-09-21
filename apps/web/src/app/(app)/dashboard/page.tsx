"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  api,
  minutes,
  senToRinggit,
  type DashboardTiles,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
} from "@/components/ui";

const STATION: Record<string, string> = {
  REGISTERED: "Waiting for triage",
  TRIAGE_IN_PROGRESS: "In triage",
  DOCTOR_WAITING: "Waiting for the doctor",
  IN_CONSULTATION: "With the doctor",
  PHARMACY_WAITING: "Waiting at the pharmacy",
  DISPENSING: "Being dispensed",
  PAYMENT_WAITING: "Waiting to pay",
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
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not read the dashboard.",
      );
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
    const source = new EventSource(
      `/api/v1/branches/${branchId}/dashboard/stream`,
    );
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { heartbeat?: string };
      if (!payload.heartbeat) void reload.current();
    };
    return () => source.close();
  }, [branchId]);

  if (!branchId) return <EmptyState title="No branch selected" />;
  if (!tiles)
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
    );

  const waiting = tiles.queue.reduce((sum, row) => sum + row.waiting, 0);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Today"
        description="The numbers this branch is running on right now. Each one opens the report it came from."
        meta={
          <>
            <span className="text-muted">
              {tiles.day} · {tiles.timezone}
            </span>
            {freshAt && (
              <span className="inline-flex items-center gap-2 text-muted">
                <span
                  aria-hidden
                  className="size-1.5 rounded-full bg-success"
                />
                updated {freshAt.toLocaleTimeString("en-MY")}
              </span>
            )}
          </>
        }
        actions={
          <Link href="/reports">
            <Button variant="secondary">All reports</Button>
          </Link>
        }
      />

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
              ? "Nobody is waiting"
              : tiles.queue
                  .map(
                    (row) =>
                      `${STATION[row.status] ?? row.status}: ${row.waiting}`,
                  )
                  .join(" · ")
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
              hint={`${tiles.money.issued} invoice${tiles.money.issued === 1 ? "" : "s"} · ${senToRinggit(
                tiles.money.discountedSen,
              )} discounted`}
              href="/reports/daily-sales"
            />
            <Tile
              title="Voided today"
              value={String(tiles.money.voided)}
              hint={
                tiles.money.voided === 0
                  ? "Nothing cancelled after being issued"
                  : `${senToRinggit(tiles.money.voidedSen)} taken back`
              }
              href="/reports/voids"
            />
            <Tile
              title="Collected today"
              value={senToRinggit(tiles.collections?.totalSen ?? "0")}
              hint={
                Object.keys(tiles.collections?.byMethod ?? {}).length === 0
                  ? "Nothing taken yet"
                  : Object.entries(tiles.collections?.byMethod ?? {})
                      .map(
                        ([method, total]) =>
                          `${method.replace("_", " ")}: ${senToRinggit(total)}`,
                      )
                      .join(" · ")
              }
              href="/reports/collections"
            />
          </>
        ) : null}

        <Tile
          title="Drawer"
          value={
            tiles.cashSession.open
              ? senToRinggit(tiles.cashSession.expectedCashSen)
              : "—"
          }
          hint={
            tiles.cashSession.open
              ? `${tiles.cashSession.drawerCode} open since ${new Date(
                  tiles.cashSession.openedAt,
                ).toLocaleTimeString("en-MY")}`
              : "No drawer is open — nothing can be taken"
          }
          href="/drawer"
          tone={tiles.cashSession.open ? undefined : "warning"}
        />
        <Tile
          title="Stock needing attention"
          value={String(tiles.stock.low + tiles.stock.critical)}
          hint={`${tiles.stock.critical} critical · ${tiles.stock.expiring} expiring · ${tiles.stock.expired} expired`}
          href="/reports/stock-alerts"
          tone={tiles.stock.critical > 0 ? "warning" : undefined}
        />
        <Tile
          title="Unsigned notes"
          value={String(tiles.unsignedDraftsOver24h)}
          hint="Drafts more than a day old. A visit with no record."
          tone={tiles.unsignedDraftsOver24h > 0 ? "warning" : undefined}
        />
        {tiles.money ? (
          <Tile
            title="Unbilled visits"
            value={String(tiles.money.openDrafts)}
            hint="Bills started and never issued."
            tone={tiles.money.openDrafts > 0 ? "warning" : undefined}
            href="/billing"
          />
        ) : null}
      </div>

      {!can("report.financial") && (
        <p className="text-xs text-muted">
          Takings, discounts and outstanding balances are the
          administrator&rsquo;s.
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
  tone?: "warning";
}) {
  const body = (
    <Card
      padding="tight"
      className={`h-full ${
        tone === "warning" ? "border-warning/60 bg-warning-soft/20" : ""
      } ${href ? "transition-shadow group-hover:shadow-e2" : ""}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        {title}
      </p>
      <p className="mt-1.5 text-3xl font-semibold tracking-tight tabular-nums">
        {value}
      </p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{hint}</p>
    </Card>
  );
  return href ? (
    <Link href={href} className="group block focus-visible:outline-none">
      {body}
    </Link>
  ) : (
    body
  );
}
