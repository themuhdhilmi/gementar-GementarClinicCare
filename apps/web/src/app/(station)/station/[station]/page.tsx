"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import {
  ApiError,
  PRIORITY_TONE,
  STATION_LABEL,
  STATUS_LABEL,
  WAIT_TONE,
  api,
  type QueueRow,
  type QueueStats,
  type Station,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import { useQueueStream } from "@/lib/use-queue-stream";
import { Alert, Button, Chip } from "@/components/ui";

/** The station names that exist at all, for checking what is in the URL. */
const STATIONS: readonly Station[] = [
  "reception",
  "triage",
  "doctor",
  "procedure",
  "pharmacy",
  "cashier",
  "counter",
];

/** Where the work actually gets done, once a patient has been called. */
function workLink(station: Station, row: QueueRow): { href: string; label: string } {
  if (row.status === "TRIAGE_IN_PROGRESS")
    return { href: `/encounters/${row.id}/triage`, label: "Record vitals" };
  if (row.status === "IN_CONSULTATION")
    return {
      href: `/encounters/${row.id}/consultation`,
      label: "Write the note",
    };
  if (station === "pharmacy" || station === "counter")
    return { href: "/pharmacy", label: "The counter" };
  if (station === "cashier") return { href: "/billing", label: "The bill" };
  return { href: `/encounters/${row.id}`, label: "Open" };
}

/** Remembering what this monitor is, so the picker can offer it back. */
function remember(station: string) {
  try {
    window.localStorage.setItem("cliniccare.station", station);
  } catch {
    // A locked-down kiosk browser may refuse storage. The screen works
    // regardless — this is a convenience, not state anything depends on.
  }
}

/**
 * One station, one monitor, all day (ENC-F-25).
 *
 * The board at `/queue` is for somebody moving between stations: it has
 * tabs, and it sits inside the application's navigation. This does not.
 * It is what the machine on the pharmacy counter shows from eight in the
 * morning until the clinic closes, so it is built for the one thing that
 * happens at that counter a hundred times a day — call the next patient
 * — and the number is large enough to read standing up and a step back.
 */
export default function StationConsolePage() {
  const params = useParams<{ station: string }>();
  const station = params.station as Station;
  const router = useRouter();
  const { me, can } = useSession();

  const [rows, setRows] = useState<QueueRow[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [mine, setMine] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState("");

  const branchId = me?.activeBranchId ?? null;
  const branch = me?.branches.find((b) => b.id === branchId);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const [board, counts] = await Promise.all([
        api<{ items: QueueRow[] }>(
          `/branches/${branchId}/queues/${station}${mine ? "?mine=true" : ""}`,
        ),
        api<QueueStats>(`/branches/${branchId}/queues-stats`),
      ]);
      setRows(board.items);
      setStats(counts);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Cannot reach the clinic system.",
      );
    }
  }, [branchId, station, mine]);

  useAsyncEffect(() => load(), [load]);
  useQueueStream(
    branchId ? `/api/v1/branches/${branchId}/queues-stream` : null,
    () => void load(),
  );

  useEffect(() => remember(station), [station]);

  useEffect(() => {
    const tick = () =>
      setClock(
        new Date().toLocaleTimeString("en-MY", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      );
    tick();
    const timer = setInterval(tick, 10_000);
    return () => clearInterval(timer);
  }, []);

  const callNext = useCallback(async () => {
    if (!branchId) return;
    setBusy(true);
    setError(null);
    try {
      await api(
        `/branches/${branchId}/queues/${station}/call-next${mine ? "?mine=true" : ""}`,
        { method: "POST" },
      );
      await load();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not call anybody.",
      );
    } finally {
      setBusy(false);
    }
  }, [branchId, station, mine, load]);

  // Space calls the next patient. On a counter monitor the keyboard is
  // often the only thing within reach.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(
        (event.target as HTMLElement)?.tagName ?? "",
      );
      if (typing || event.code !== "Space" || station === "reception") return;
      event.preventDefault();
      void callNext();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [callNext, station]);

  if (!me) return null;

  // A station this branch does not run, or a word that is not a station
  // at all. Either way nothing would ever appear here, and saying so is
  // better than an empty board somebody waits in front of.
  const unknown = !STATIONS.includes(station);
  if (unknown || (stats && !stats.stations.includes(station))) {
    return (
      <div className="mx-auto max-w-md px-6 py-16">
        <Alert
          tone="warning"
          title={`This branch has no ${STATION_LABEL[station] ?? station} station`}
          actions={
            <Button onClick={() => router.push("/station")}>
              Pick another
            </Button>
          }
        >
          {unknown
            ? "That is not one of the clinic's stations."
            : `${branch?.name} does not use this station, so nothing would ever appear on this screen.`}
        </Alert>
      </div>
    );
  }

  // Reception sees every open visit rather than a queue of its own, so
  // there is no head to call: the server refuses `call-next` there, and
  // offering the button would be offering an error (ENC-F-15).
  const callable = station !== "reception";
  // Which rows are in the line and which are already being dealt with is
  // the server's answer (`callable`), not a second copy of the station
  // table kept here — the copy was wrong for triage and the doctor, and
  // their consoles showed nothing while somebody was in the room.
  const waiting = rows.filter((row) => row.callable);
  const withYou = rows.filter((row) => !row.callable);
  const next = waiting[0];

  return (
    <div className="flex min-h-screen flex-col bg-surface-sunken">
      {/* --------------------------------------------------------- top */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface px-6 py-3">
        <h1 className="text-lg font-semibold tracking-tight">
          {STATION_LABEL[station] ?? station}
        </h1>
        <span className="text-sm text-muted">{branch?.name}</span>

        <span className="inline-flex items-center gap-2 text-sm text-muted">
          <span aria-hidden className="size-1.5 rounded-full bg-success" />
          Live
        </span>

        {station === "doctor" && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-[var(--color-primary)]"
              checked={mine}
              onChange={(event) => setMine(event.target.checked)}
            />
            Only mine
          </label>
        )}

        <div className="ml-auto flex items-center gap-4">
          <span className="text-lg font-medium tabular-nums text-muted">
            {clock}
          </span>
          <Link href="/station">
            <Button variant="quiet" size="sm">
              Change screen
            </Button>
          </Link>
          <Link href="/workspace">
            <Button variant="secondary" size="sm">
              Exit
            </Button>
          </Link>
        </div>
      </header>

      {error && (
        <div className="px-6 pt-4">
          <Alert title="Not done">{error}</Alert>
        </div>
      )}

      <div className="grid flex-1 gap-6 p-6 lg:grid-cols-[1fr_22rem]">
        {/* ------------------------------------------------------ the line */}
        <section className="flex flex-col gap-4">
          {/* The one button this screen exists for. */}
          {callable ? (
            <div className="flex flex-wrap items-center gap-6 rounded-2xl border border-line bg-surface px-6 py-5 shadow-e1">
              <Button
                size="lg"
                loading={busy}
                disabled={waiting.length === 0 || !can("encounter.transition")}
                onClick={() => void callNext()}
                className="h-16 px-8 text-lg"
              >
                Call next
              </Button>

              {next ? (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
                  <span className="font-mono text-5xl font-bold leading-none tabular-nums">
                    {next.queueNo}
                  </span>
                  <span>
                    <span className="block text-xl font-medium">
                      {next.patient.name}
                    </span>
                    <span className="flex items-center gap-2 text-sm text-muted">
                      waiting {next.waitingMinutes} min
                      {next.priority !== "NORMAL" && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${PRIORITY_TONE[next.priority]}`}
                        >
                          {next.priority === "EMERGENCY"
                            ? "Emergency"
                            : "Urgent"}
                        </span>
                      )}
                    </span>
                  </span>
                </div>
              ) : (
                <span className="text-xl text-muted">Nobody is waiting.</span>
              )}

              <span className="ml-auto text-sm text-muted">
                or press{" "}
                <kbd className="rounded border border-line-strong bg-surface-sunken px-2 py-1 font-sans text-xs shadow-e1">
                  Space
                </kbd>
              </span>
            </div>
          ) : (
            <div className="rounded-2xl border border-line bg-surface px-6 py-5 shadow-e1">
              <p className="text-3xl font-semibold tabular-nums">
                {waiting.length} open
              </p>
              <p className="mt-1 text-sm text-muted">
                Everybody in the building. Reception sees the whole floor
                rather than a line, so there is nobody to call from here.
              </p>
            </div>
          )}

          <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
            {callable ? "Waiting" : "In the building"} · {waiting.length}
          </h2>

          {waiting.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line px-6 py-10 text-center text-lg text-muted">
              The line is empty.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {waiting.map((row, index) => {
                const work = workLink(station, row);
                return (
                  <li
                    key={row.id}
                    className={`flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-5 py-4 ${
                      // Only marked at a station that calls: at reception
                      // the top row is simply the longest wait, not the
                      // next person through a door.
                      index === 0 && callable
                        ? "border-primary/40 bg-primary-soft"
                        : "border-line bg-surface"
                    }`}
                  >
                    <span className="font-mono text-3xl font-bold tabular-nums">
                      {row.queueNo}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-lg font-medium">
                        {row.patient.name}
                      </span>
                      <span className="text-sm text-muted">
                        {[row.patient.age, row.patient.gender]
                          .filter(Boolean)
                          .join(" · ")}
                        {row.callCount > 0 && ` · called ${row.callCount}×`}
                      </span>
                    </span>
                    {row.priority !== "NORMAL" && (
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${PRIORITY_TONE[row.priority]}`}
                      >
                        {row.priority === "EMERGENCY" ? "Emergency" : "Urgent"}
                      </span>
                    )}
                    <span
                      className={`text-lg font-medium tabular-nums ${WAIT_TONE[row.waitTone]}`}
                    >
                      {row.waitingMinutes} min
                    </span>
                    <Link href={work.href}>
                      <Button variant="secondary">{work.label}</Button>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ------------------------------------------------- with you now */}
        <aside className="flex flex-col gap-4">
          {callable && (
            <div className="rounded-2xl border border-line bg-surface p-5 shadow-e1">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                With you now
              </h2>
              {withYou.length === 0 ? (
                <p className="mt-3 text-muted">Nobody yet.</p>
              ) : (
                <ul className="mt-3 flex flex-col gap-3">
                  {withYou.map((row) => {
                    const work = workLink(station, row);
                    return (
                      <li key={row.id} className="flex flex-col gap-2">
                        <span className="flex items-baseline gap-3">
                          <span className="font-mono text-2xl font-bold tabular-nums">
                            {row.queueNo}
                          </span>
                          <span className="truncate font-medium">
                            {row.patient.name}
                          </span>
                        </span>
                        <span className="text-sm text-muted">
                          {STATUS_LABEL[row.status]} · {row.waitingMinutes} min
                        </span>
                        <Link href={work.href}>
                          <Button className="w-full">{work.label}</Button>
                        </Link>
                        {/* ENC-F-24 is on the visit, which is one press
                            away. It is not on this screen because a
                            station monitor is for calling people, and a
                            move backwards deserves the page that asks
                            why. */}
                        <Link href={`/encounters/${row.id}`}>
                          <Button variant="quiet" size="sm" className="w-full">
                            The visit
                          </Button>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {stats && (
            <div className="rounded-2xl border border-line bg-surface p-5 shadow-e1">
              <h2 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted">
                The clinic today
              </h2>
              <dl className="mt-3 flex flex-col gap-2.5 text-sm">
                {(
                  [
                    ["Waiting everywhere", String(stats.waiting)],
                    ["Longest wait", `${stats.longestWaitMinutes} min`],
                    ["Seen today", String(stats.seenToday)],
                    ["Did not answer", String(stats.noShows)],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label} className="flex justify-between gap-3">
                    <dt className="text-muted">{label}</dt>
                    <dd className="font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}

          {!can("encounter.transition") && (
            <Chip tone="neutral">
              You can watch this board but not call from it.
            </Chip>
          )}
        </aside>
      </div>
    </div>
  );
}
