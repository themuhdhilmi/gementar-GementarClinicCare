'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
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
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { useQueueStream } from '@/lib/use-queue-stream';
import { Alert, Button, Card, EmptyState, Modal, TextField } from '@/components/ui';

const STATIONS: Station[] = ['reception', 'triage', 'doctor', 'pharmacy', 'cashier'];

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
  const [station, setStation] = useState<Station>('reception');
  const [mine, setMine] = useState(false);
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [stats, setStats] = useState<QueueStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [absent, setAbsent] = useState<QueueRow | null>(null);
  const [reason, setReason] = useState('');

  const branchId = me?.activeBranchId ?? null;

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      const [board, counts] = await Promise.all([
        api<{ items: QueueRow[] }>(
          `/branches/${branchId}/queues/${station}${mine ? '?mine=true' : ''}`,
        ),
        api<QueueStats>(`/branches/${branchId}/queues-stats`),
      ]);
      setRows(board.items);
      setStats(counts);
      setError(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Cannot reach the server.');
    }
  }, [branchId, station, mine]);

  useAsyncEffect(() => load(), [load]);
  useQueueStream(branchId ? `/api/v1/branches/${branchId}/queues-stream` : null, () => void load());

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
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
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
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(
        (event.target as HTMLElement)?.tagName ?? '',
      );
      if (typing || station === 'reception') return;
      if (event.code === 'Space') {
        event.preventDefault();
        void act('Called.', () =>
          api(`/branches/${branchId}/queues/${station}/call-next${mine ? '?mine=true' : ''}`, {
            method: 'POST',
          }),
        );
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, branchId, station, mine]);

  if (!me) return null;
  const callable = station !== 'reception';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Today</h1>
        {can('encounter.create') && (
          <Link href="/patients">
            <Button>Check a patient in</Button>
          </Link>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {(
            [
              ['Waiting', String(stats.waiting)],
              ['Longest wait', `${stats.longestWaitMinutes} min`],
              ['Seen today', String(stats.seenToday)],
              ['Average visit', `${stats.averageVisitMinutes} min`],
              ['Did not answer', String(stats.noShows)],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-surface px-3 py-2">
              <p className="text-xs text-muted">{label}</p>
              <p className="text-lg font-semibold">{value}</p>
            </div>
          ))}
        </div>
      )}

      <nav className="flex flex-wrap gap-1 border-b border-line" aria-label="Stations">
        {STATIONS.map((s) => (
          <button
            key={s}
            onClick={() => setStation(s)}
            aria-current={station === s ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              station === s
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted hover:text-foreground'
            }`}
          >
            {STATION_LABEL[s]}
          </button>
        ))}
      </nav>

      {error && <Alert title="Not done">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {callable && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="md"
            loading={busy}
            disabled={rows.length === 0}
            onClick={() =>
              void act('Called.', () =>
                api(`/branches/${branchId}/queues/${station}/call-next${mine ? '?mine=true' : ''}`, {
                  method: 'POST',
                }),
              )
            }
            className="h-12 px-6 text-base"
          >
            Call next {rows[0] ? `· ${rows[0].queueNo}` : ''}
          </Button>
          <span className="text-sm text-muted">
            or press <kbd className="rounded border border-line px-1">Space</kbd>
          </span>
          {station === 'doctor' && (
            <label className="ml-auto flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={mine}
                onChange={(event) => setMine(event.target.checked)}
              />
              Only patients assigned to me
            </label>
          )}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState title="Nobody is waiting here">
          {station === 'reception'
            ? 'Check a patient in to start the day.'
            : 'Patients appear as they are sent to this station.'}
        </EmptyState>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-muted">
                <tr className="border-b border-line">
                  <th className="pb-2 font-medium">Queue</th>
                  <th className="pb-2 font-medium">Patient</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium">Doctor</th>
                  <th className="pb-2 font-medium">Waiting</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={row.id}
                    className={`border-b border-line last:border-0 ${
                      index === 0 && callable ? 'bg-primary-soft' : ''
                    }`}
                  >
                    <td className="py-2.5">
                      <span className="font-mono text-base font-semibold">{row.queueNo}</span>
                      {row.priority !== 'NORMAL' && (
                        <span
                          className={`ml-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                            PRIORITY_TONE[row.priority]
                          }`}
                          title={row.priorityReason ?? undefined}
                        >
                          {row.priority === 'EMERGENCY' ? 'Emergency' : 'Urgent'}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5">
                      <Link href={`/patients/${row.patient.id}`} className="font-medium underline">
                        {row.patient.name}
                      </Link>
                      <span className="block text-xs text-muted">
                        {[row.patient.age, row.patient.gender].filter(Boolean).join(' · ')}
                      </span>
                    </td>
                    <td className="py-2.5 text-muted">{STATUS_LABEL[row.status]}</td>
                    <td className="py-2.5 text-muted">
                      {row.attendingDoctorName ?? 'Any available'}
                      {row.roomName && <span className="block text-xs">{row.roomName}</span>}
                    </td>
                    <td className={`py-2.5 ${WAIT_TONE[row.waitTone]}`}>
                      {row.waitingMinutes} min
                      {row.callCount > 0 && (
                        <span className="block text-xs text-muted">
                          called {row.callCount}×{row.skipCount > 0 && `, skipped ${row.skipCount}×`}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {/* Triage-in-progress goes straight to the form:
                          the nurse has the patient in front of them. */}
                      {row.status === 'TRIAGE_IN_PROGRESS' && can('triage.write') ? (
                        <Link href={`/encounters/${row.id}/triage`}>
                          <Button variant="secondary" size="sm">
                            Record vitals
                          </Button>
                        </Link>
                      ) : (
                        <Link href={`/encounters/${row.id}`}>
                          <Button variant="ghost" size="sm">
                            Open
                          </Button>
                        </Link>
                      )}
                      {callable && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              void act('Called again.', () =>
                                api(`/encounters/${row.id}/call`, { method: 'POST' }),
                              )
                            }
                          >
                            Call
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              void act('Moved to the back.', () =>
                                api(`/encounters/${row.id}/skip`, { method: 'POST' }),
                              )
                            }
                          >
                            Skip
                          </Button>
                        </>
                      )}
                      {can('encounter.cancel') && row.callCount >= 2 && (
                        <Button variant="ghost" size="sm" onClick={() => setAbsent(row)}>
                          Absent
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Modal
        open={absent !== null}
        title={`Mark ${absent?.queueNo ?? ''} as not answering?`}
        onClose={() => setAbsent(null)}
      >
        <p className="text-sm text-muted">
          They come off the board. If they turn up later today you can put them back in the
          queue from their visit.
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
              const done = await act('Marked as not answering.', () =>
                api(`/encounters/${absent!.id}/no-show`, { method: 'POST', body: { reason } }),
              );
              if (done !== null) {
                setAbsent(null);
                setReason('');
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
