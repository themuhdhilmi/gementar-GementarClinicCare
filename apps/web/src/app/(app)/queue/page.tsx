"use client";

import Link from "next/link";
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
import { Column, DataTable } from "@/components/data-table";
import {
  Alert,
  Button,
  Card,
  Modal,
  PageHeader,
  Stat,
  Tabs,
  TextField,
} from "@/components/ui";

/**
 * Until the server says otherwise. It decides the real shape from the
 * clinic's settings (ENC-F-15) — no triage tab where there is no triage,
 * one counter where one person does both dispensing and payment.
 */
const DEFAULT_STATIONS: Station[] = [
  "reception",
  "triage",
  "doctor",
  "pharmacy",
  "cashier",
];

/**
 * The board the clinic runs its day on.
 *
 * Reception sees every open visit; every other station sees its own line
 * with one large button at the top of it. The board updates itself: a
 * transition anywhere in the clinic arrives as an event and the board
 * refetches, so nobody has to remember to press refresh (ENC-F-19).
 */
export default function QueuePage() {
  const { me, can } = useSession();
  const [picked, setPicked] = useState<Station>("reception");
  const [mine, setMine] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [absent, setAbsent] = useState<QueueRow | null>(null);
  const [reason, setReason] = useState("");

  const branchId = me?.activeBranchId ?? null;

  /**
   * The board's shape comes from the server, because it follows from
   * settings a dispenser is not allowed to read (ENC-F-15).
   *
   * The shown station is **derived** from what the user picked rather
   * than corrected afterwards: a clinic that switches to one counter
   * mid-morning would otherwise leave somebody looking at a pharmacy tab
   * that is no longer on the board, and putting that right in an effect
   * means a render where it is still wrong.
   */
  const stations = stats?.stations ?? DEFAULT_STATIONS;
  const station: Station = stations.includes(picked)
    ? picked
    : (stations[0] ?? "reception");

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
          : "Cannot reach the server.",
      );
    }
  }, [branchId, station, mine]);

  useAsyncEffect(() => load(), [load]);
  useQueueStream(
    branchId ? `/api/v1/branches/${branchId}/queues-stream` : null,
    () => void load(),
  );

  const act = useCallback(
    async (what: string, run: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        const result = await run();
        await load();
        setNotice(what);
        return result;
      } catch (caught) {
        setError(
          caught instanceof ApiError ? caught.message : "Something went wrong.",
        );
        return null;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  // `Space` calls the next patient from anywhere on the page, because a
  // nurse with a patient in front of them should not have to find a button.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(
        (event.target as HTMLElement)?.tagName ?? "",
      );
      if (typing || station === "reception") return;
      if (event.code === "Space") {
        event.preventDefault();
        void act("Called.", () =>
          api(
            `/branches/${branchId}/queues/${station}/call-next${mine ? "?mine=true" : ""}`,
            {
              method: "POST",
            },
          ),
        );
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [act, branchId, station, mine]);

  if (!me) return null;
  const callable = station !== "reception";
  // The head of the *line*, not of the board: the board also shows the
  // patient already with this station, and they are not callable.
  const next = rows.find((row) => row.callable);

  const columns: Array<Column<QueueRow>> = [
    {
      key: "queue",
      header: "Queue",
      width: "w-28",
      cell: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-mono text-base font-semibold tabular">
            {row.queueNo}
          </span>
          {row.priority !== "NORMAL" && (
            <span
              className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                PRIORITY_TONE[row.priority]
              }`}
              title={row.priorityReason ?? undefined}
            >
              {row.priority === "EMERGENCY" ? "Emergency" : "Urgent"}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "patient",
      header: "Patient",
      cell: (row) => (
        <>
          <Link
            href={`/patients/${row.patient.id}`}
            className="font-medium hover:underline"
          >
            {row.patient.name}
          </Link>
          <span className="block text-[13px] text-muted">
            {[row.patient.age, row.patient.gender].filter(Boolean).join(" · ")}
          </span>
        </>
      ),
    },
    {
      key: "status",
      header: "Status",
      hideBelow: "md",
      cell: (row) => (
        <span className="text-muted">{STATUS_LABEL[row.status]}</span>
      ),
    },
    {
      key: "doctor",
      header: "Doctor",
      hideBelow: "lg",
      cell: (row) => (
        <>
          <span className="text-muted">
            {row.attendingDoctorName ?? "Any available"}
          </span>
          {row.roomName && (
            <span className="block text-xs text-muted">{row.roomName}</span>
          )}
        </>
      ),
    },
    {
      key: "waiting",
      header: "Waiting",
      numeric: true,
      width: "w-28",
      cell: (row) => (
        <>
          <span className={`font-medium ${WAIT_TONE[row.waitTone]}`}>
            {row.waitingMinutes} min
          </span>
          {row.callCount > 0 && (
            <span className="block text-xs text-muted">
              called {row.callCount}&times;
              {row.skipCount > 0 && `, skipped ${row.skipCount}×`}
            </span>
          )}
        </>
      ),
    },
    {
      key: "actions",
      header: "",
      numeric: true,
      cell: (row) => (
        <div className="flex items-center justify-end gap-1 whitespace-nowrap">
          {/* One button says what to do next with this patient; the rest
              of the row's moves are quiet, so the board reads as a list
              of people rather than a wall of controls. */}
          {row.status === "IN_CONSULTATION" && can("clinical.write") ? (
            <Link href={`/encounters/${row.id}/consultation`}>
              <Button variant="secondary" size="sm">
                Write the note
              </Button>
            </Link>
          ) : row.status === "TRIAGE_IN_PROGRESS" && can("triage.write") ? (
            <Link href={`/encounters/${row.id}/triage`}>
              <Button variant="secondary" size="sm">
                Record vitals
              </Button>
            </Link>
          ) : (
            <Link href={`/encounters/${row.id}`}>
              <Button variant="secondary" size="sm">
                Open
              </Button>
            </Link>
          )}
          {callable && (
            <>
              <Button
                variant="quiet"
                size="sm"
                onClick={() =>
                  void act("Called again.", () =>
                    api(`/encounters/${row.id}/call`, { method: "POST" }),
                  )
                }
              >
                Call
              </Button>
              <Button
                variant="quiet"
                size="sm"
                onClick={() =>
                  void act("Moved to the back.", () =>
                    api(`/encounters/${row.id}/skip`, { method: "POST" }),
                  )
                }
              >
                Skip
              </Button>
            </>
          )}
          {can("encounter.cancel") && row.callCount >= 2 && (
            <Button variant="quiet" size="sm" onClick={() => setAbsent(row)}>
              Absent
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Today"
        description="Every visit open at this branch. The board updates itself as people are moved through the clinic."
        meta={
          <span className="inline-flex items-center gap-2 text-[13px] text-muted">
            <span aria-hidden className="size-1.5 rounded-full bg-success" />
            Live
          </span>
        }
        actions={
          can("encounter.create") && (
            <Link href="/patients">
              <Button>Check a patient in</Button>
            </Link>
          )
        }
      />

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="Waiting" value={stats.waiting} />
          <Stat
            label="Longest wait"
            value={`${stats.longestWaitMinutes} min`}
            tone={
              stats.longestWaitMinutes >= 45
                ? "danger"
                : stats.longestWaitMinutes >= 30
                  ? "warning"
                  : undefined
            }
          />
          <Stat label="Seen today" value={stats.seenToday} />
          <Stat
            label="Average visit"
            value={`${stats.averageVisitMinutes} min`}
            hint="Door to door"
          />
          <Stat label="Did not answer" value={stats.noShows} />
        </div>
      )}

      <Tabs
        label="Stations"
        value={station}
        onChange={setPicked}
        tabs={stations.map((s) => ({ key: s, label: STATION_LABEL[s] }))}
      />

      {error && <Alert title="Not done">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {callable && (
        <Card padding="tight" className="bg-surface-sunken">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
            <Button
              size="lg"
              loading={busy}
              disabled={!next}
              onClick={() =>
                void act("Called.", () =>
                  api(
                    `/branches/${branchId}/queues/${station}/call-next${mine ? "?mine=true" : ""}`,
                    { method: "POST" },
                  ),
                )
              }
            >
              Call next{next ? ` · ${next.queueNo}` : ""}
            </Button>

            {next ? (
              <span className="text-sm">
                <span className="font-medium">{next.patient.name}</span>
                <span className="text-muted">
                  {" "}
                  has waited {next.waitingMinutes} min
                </span>
              </span>
            ) : (
              <span className="text-sm text-muted">
                Nobody is in this line.
              </span>
            )}

            <span className="text-[13px] text-muted">
              or press{" "}
              <kbd className="rounded border border-line-strong bg-surface px-1.5 py-0.5 font-sans text-[11px] shadow-e1">
                Space
              </kbd>
            </span>

            {station === "doctor" && (
              <label className="ml-auto flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-[var(--color-primary)]"
                  checked={mine}
                  onChange={(event) => setMine(event.target.checked)}
                />
                Only patients assigned to me
              </label>
            )}
          </div>
        </Card>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        rowKey={(row) => row.id}
        rowTone={(row) =>
          callable && row.id === next?.id ? "primary" : undefined
        }
        caption={`${STATION_LABEL[station]} queue`}
        empty="Nobody is waiting here"
        emptyHint={
          station === "reception"
            ? "Check a patient in to start the day."
            : "Patients appear as they are sent to this station."
        }
      />

      <Modal
        open={absent !== null}
        title={`Mark ${absent?.queueNo ?? ""} as not answering?`}
        onClose={() => setAbsent(null)}
      >
        <p className="text-sm text-muted">
          They come off the board. If they turn up later today you can put them
          back in the queue from their visit.
        </p>
        <div className="mt-3">
          <TextField
            label="What happened?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Called three times, not in the waiting room"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAbsent(null)}>
            Keep waiting
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const done = await act("Marked as not answering.", () =>
                api(`/encounters/${absent!.id}/no-show`, {
                  method: "POST",
                  body: { reason },
                }),
              );
              if (done !== null) {
                setAbsent(null);
                setReason("");
              }
            }}
          >
            Mark absent
          </Button>
        </div>
      </Modal>
    </div>
  );
}
