'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  ApiError,
  PRIORITY_TONE,
  STATUS_LABEL,
  api,
  type ClinicalSummary,
  type EncounterChart,
  type PatientRecord,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { useQueueStream } from '@/lib/use-queue-stream';
import { PatientHeader, loadClinicalSummary } from '@/components/patient-header';
import { Alert, Button, Card, Field, Modal, Select, TextField, timeAgo } from '@/components/ui';

/**
 * One visit, from the door to the door (ENC-F-11).
 *
 * The buttons on it come from the server: `allowedNext` is the transition
 * table's own answer to "what can happen next", so a screen can never offer
 * a move the state machine would refuse, and a new route in the table
 * appears here without anyone editing this file.
 */
export default function EncounterPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { me, can } = useSession();

  const [chart, setChart] = useState<EncounterChart | null>(null);
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [clinical, setClinical] = useState<ClinicalSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [priority, setPriority] = useState<string>('URGENT');
  const [changingPriority, setChangingPriority] = useState(false);

  const load = useCallback(async () => {
    const next = await api<EncounterChart>(`/encounters/${id}`);
    setChart(next);
    const [record, summary] = await Promise.all([
      api<PatientRecord>(`/patients/${next.encounter.patientId}`),
      loadClinicalSummary(next.encounter.patientId),
    ]);
    setPatient(record);
    setClinical(summary);
  }, [id]);

  useAsyncEffect(() => load(), [load]);
  useQueueStream(
    chart ? `/api/v1/branches/${chart.encounter.branchId}/queues-stream` : null,
    () => void load(),
  );

  const act = useCallback(
    async (what: string, run: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await run();
        await load();
        setNotice(what);
        return true;
      } catch (caught) {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
        return false;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (!chart || !patient || !me) return <p className="text-sm text-muted">Loading…</p>;
  const { encounter, timeline, completionBlockers } = chart;

  return (
    <div>
      <PatientHeader patient={patient} clinical={clinical} compact />

      <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono text-2xl font-semibold">{encounter.queueNo}</span>
        <span className="rounded-full bg-primary-soft px-3 py-1 text-sm font-medium text-primary-ink">
          {STATUS_LABEL[encounter.status]}
        </span>
        {encounter.priority !== 'NORMAL' && (
          <span
            className={`rounded-full px-3 py-1 text-sm font-medium ${PRIORITY_TONE[encounter.priority]}`}
          >
            {encounter.priority === 'EMERGENCY' ? 'Emergency' : 'Urgent'}
            {encounter.priorityReason && `: ${encounter.priorityReason}`}
          </span>
        )}
        <span className="text-sm text-muted">
          {encounter.encounterNo} · arrived {timeAgo(encounter.registeredAt)}
          {encounter.open && ` · ${encounter.waitingMinutes} min at this step`}
        </span>
      </div>

      {error && <Alert title="Not done">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      {completionBlockers.length > 0 && (
        <Alert tone="warning" title="This visit cannot be finished yet">
          <ul className="ml-4 list-disc">
            {completionBlockers.map((blocker) => (
              <li key={blocker.reason}>{blocker.detail}</li>
            ))}
          </ul>
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-5">
          {can('clinical.write') && encounter.status === 'IN_CONSULTATION' && (
            <Card title="Consultation">
              <p className="mb-3 text-sm text-muted">
                What the patient said, what you found, and what happens next.
              </p>
              <Link href={`/encounters/${id}/consultation`}>
                <Button>Write the note</Button>
              </Link>
            </Card>
          )}

          {can('triage.write') && encounter.open && (
            <Card title="Vitals">
              <p className="mb-3 text-sm text-muted">
                Blood pressure, temperature and the rest, taken at the nurse station.
              </p>
              <Link href={`/encounters/${id}/triage`}>
                <Button variant="secondary">Record vitals</Button>
              </Link>
            </Card>
          )}

          {encounter.open && can('encounter.transition') && (
            <Card title="What happens next">
              <div className="flex flex-wrap gap-2">
                {encounter.allowedNext.length === 0 && (
                  <p className="text-sm text-muted">
                    Nothing further from here. An administrator can reopen the visit if it was
                    closed in error.
                  </p>
                )}
                {encounter.allowedNext.map((option) => (
                  <Button
                    key={option.to}
                    variant={option.to === 'COMPLETED' ? 'primary' : 'secondary'}
                    loading={busy}
                    title={option.note ?? undefined}
                    onClick={() =>
                      void act(`Moved to ${STATUS_LABEL[option.to].toLowerCase()}.`, () =>
                        api(`/encounters/${id}/transition`, {
                          method: 'POST',
                          body: { to: option.to },
                        }),
                      )
                    }
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
            </Card>
          )}

          <Card title="What has happened">
            <ol className="flex flex-col gap-3">
              {timeline.map((event) => (
                <li key={event.id} className="flex gap-3 text-sm">
                  <span className="w-20 shrink-0 text-muted">
                    {new Date(event.occurredAt).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                  <span>
                    <span className="font-medium">
                      {event.action === 'call'
                        ? 'Called'
                        : event.action === 'skip'
                          ? 'Skipped'
                          : event.action === 'check_in'
                            ? 'Arrived'
                            : event.action === 'force'
                              ? 'Forced by an administrator'
                              : STATUS_LABEL[event.toStatus as keyof typeof STATUS_LABEL] ??
                                event.toStatus}
                    </span>
                    <span className="text-muted"> by {event.actorName}</span>
                    {event.note && <span className="block text-muted">{event.note}</span>}
                  </span>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="flex flex-col gap-5">
          <Card title="This visit">
            <dl className="flex flex-col gap-2 text-sm">
              <div>
                <dt className="text-muted">Doctor</dt>
                <dd>{encounter.attendingDoctorId ? 'Assigned' : 'Any available'}</dd>
              </div>
              <div>
                <dt className="text-muted">Called</dt>
                <dd>
                  {encounter.callCount} time{encounter.callCount === 1 ? '' : 's'}
                  {encounter.skipCount > 0 && `, skipped ${encounter.skipCount}`}
                </dd>
              </div>
            </dl>
          </Card>

          {encounter.open && (
            <Card title="Change something">
              <div className="flex flex-col gap-2">
                {can('encounter.priority') && (
                  <Button variant="secondary" size="sm" onClick={() => setChangingPriority(true)}>
                    Change priority
                  </Button>
                )}
                {can('encounter.cancel') && (
                  <Button variant="ghost" size="sm" onClick={() => setCancelling(true)}>
                    Cancel this visit
                  </Button>
                )}
              </div>
            </Card>
          )}

          {encounter.status === 'NO_SHOW' && can('encounter.cancel') && (
            <Card title="They came back">
              <p className="mb-3 text-sm text-muted">
                Puts them back in the queue for the doctor. Same day only.
              </p>
              <Button
                loading={busy}
                onClick={() =>
                  void act('Back in the queue.', () =>
                    api(`/encounters/${id}/revert-no-show`, { method: 'POST' }),
                  )
                }
              >
                Put back in the queue
              </Button>
            </Card>
          )}
        </div>
      </div>

      <Modal open={cancelling} title="Cancel this visit?" onClose={() => setCancelling(false)}>
        <p className="text-sm text-muted">
          The visit comes off the board. Everything recorded so far stays on the patient&rsquo;s
          record.
        </p>
        <div className="mt-3">
          <TextField
            label="Why?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setCancelling(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const ok = await act('Cancelled.', () =>
                api(`/encounters/${id}/cancel`, { method: 'POST', body: { reason } }),
              );
              if (ok) {
                setCancelling(false);
                setReason('');
              }
            }}
          >
            Cancel the visit
          </Button>
        </div>
      </Modal>

      <Modal
        open={changingPriority}
        title="Change priority"
        onClose={() => setChangingPriority(false)}
      >
        <p className="text-sm text-muted">
          Everyone moved down the queue is entitled to a reason having been recorded.
        </p>
        <div className="mt-3 flex flex-col gap-3">
          <Field label="Priority">
            <Select value={priority} onChange={(event) => setPriority(event.target.value)}>
              <option value="NORMAL">Normal</option>
              <option value="URGENT">Urgent</option>
              <option value="EMERGENCY">Emergency</option>
            </Select>
          </Field>
          <TextField
            label="Why?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Elderly, unsteady on her feet"
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setChangingPriority(false)}>
            Cancel
          </Button>
          <Button
            disabled={priority !== 'NORMAL' && reason.trim().length < 3}
            onClick={async () => {
              const ok = await act('Priority changed.', () =>
                api(`/encounters/${id}/priority`, {
                  method: 'PATCH',
                  body: { priority, reason },
                }),
              );
              if (ok) {
                setChangingPriority(false);
                setReason('');
              }
            }}
          >
            Change it
          </Button>
        </div>
      </Modal>

      <p className="mt-6 text-sm">
        <Link href="/queue" className="text-muted underline hover:text-foreground">
          Back to today
        </Link>
      </p>
    </div>
  );
}
