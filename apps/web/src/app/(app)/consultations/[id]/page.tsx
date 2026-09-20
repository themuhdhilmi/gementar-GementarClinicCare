'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  ApiError,
  CLINICAL_SECTIONS,
  api,
  type ClinicalSection,
  type ClinicalSummary,
  type ConsultationView,
  type PatientRecord,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { PatientHeader, loadClinicalSummary } from '@/components/patient-header';
import { SignedPrescription } from '@/components/prescription-signed';
import { Alert, Button, Card, Field, Modal, Select, TextField } from '@/components/ui';

/**
 * A signed consultation, read-only, with its amendments beside it.
 *
 * A correction is shown as the original struck through with the new text
 * under it, never as a silent replacement. Somebody reading this in two
 * years has to be able to see what was written at the time, what was
 * changed, by whom and why. That is the whole point of the amendment trail.
 */
export default function SignedConsultationPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const { can } = useSession();

  const [view, setView] = useState<ConsultationView | null>(null);
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [clinical, setClinical] = useState<ClinicalSummary | null>(null);
  const [amending, setAmending] = useState(false);
  const [type, setType] = useState<'ADDENDUM' | 'CORRECTION'>('ADDENDUM');
  const [field, setField] = useState<ClinicalSection>('hpi');
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const next = await api<ConsultationView>(`/consultations/${id}`);
    setView(next);
    const [record, summary] = await Promise.all([
      api<PatientRecord>(`/patients/${next.consultation.patientId}`),
      loadClinicalSummary(next.consultation.patientId),
    ]);
    setPatient(record);
    setClinical(summary);
  }, [id]);

  useAsyncEffect(() => load(), [load]);

  if (!view || !patient) return <p className="text-sm text-muted">Loading…</p>;
  const { consultation, diagnoses, amendments } = view;

  /** Corrections that supersede a given section, oldest first. */
  const correctionsFor = (key: ClinicalSection) =>
    amendments.filter((a) => a.type === 'CORRECTION' && a.field === key);

  return (
    <div>
      <PatientHeader patient={patient} clinical={clinical} compact />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Consultation</h1>
        {consultation.status === 'SIGNED' ? (
          <span className="rounded-full bg-success-soft px-2.5 py-1 text-xs font-medium text-success">
            Signed {consultation.signedAt ? new Date(consultation.signedAt).toLocaleString() : ''}
          </span>
        ) : (
          <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-muted">
            {consultation.status === 'DRAFT' ? 'Draft' : 'Abandoned'}
          </span>
        )}
        {amendments.length > 0 && (
          <span className="rounded-full bg-warning-soft px-2.5 py-1 text-xs font-medium text-warning">
            {amendments.length} amendment{amendments.length === 1 ? '' : 's'}
          </span>
        )}
      </div>

      {error && <Alert title="Not done">{error}</Alert>}

      {consultation.status === 'CANCELLED' && (
        <Alert tone="info" title="This draft was abandoned">
          {consultation.cancelReason}
        </Alert>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {CLINICAL_SECTIONS.map((section) => {
            const original = consultation[section.key];
            const corrections = correctionsFor(section.key);
            if (!original && corrections.length === 0) return null;
            return (
              <Card key={section.key} title={section.label}>
                <p
                  className={`whitespace-pre-wrap text-sm ${
                    corrections.length > 0 ? 'text-muted line-through' : ''
                  }`}
                >
                  {original || <span className="text-muted">Nothing recorded</span>}
                </p>
                {corrections.map((correction) => (
                  <div key={correction.id} className="mt-3 border-l-2 border-warning pl-3">
                    <p className="whitespace-pre-wrap text-sm">{correction.current.text}</p>
                    <p className="mt-1 text-xs text-muted">
                      Corrected {new Date(correction.amendedAt).toLocaleString()} —{' '}
                      {correction.reason}
                    </p>
                  </div>
                ))}
              </Card>
            );
          })}

          {amendments.filter((a) => a.type === 'ADDENDUM').length > 0 && (
            <Card title="Added afterwards">
              <ul className="flex flex-col gap-3">
                {amendments
                  .filter((a) => a.type === 'ADDENDUM')
                  .map((addendum) => (
                    <li key={addendum.id} className="border-l-2 border-primary pl-3">
                      <p className="whitespace-pre-wrap text-sm">{addendum.current.text}</p>
                      <p className="mt-1 text-xs text-muted">
                        {new Date(addendum.amendedAt).toLocaleString()} — {addendum.reason}
                      </p>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Diagnoses">
            {diagnoses.length === 0 ? (
              <p className="text-sm text-muted">None recorded.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {diagnoses.map((d) => (
                  <li key={d.id}>
                    <span className="font-medium">{d.description}</span>
                    <span className="block text-xs text-muted">
                      {d.rank === 'PRIMARY' ? 'Main' : 'Secondary'} ·{' '}
                      {d.certainty === 'CONFIRMED' ? 'Confirmed' : 'Provisional'}
                      {d.icd10Code && ` · ${d.icd10Code}`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* RX-F-06: what was prescribed, with each item's versions and
              the way to change one. */}
          <SignedPrescription
            consultationId={consultation.id}
            canAmend={consultation.status === 'SIGNED' && can('clinical.amend')}
          />

          {consultation.status === 'SIGNED' && can('clinical.amend') && (
            <Card title="Something to add or correct?">
              <p className="mb-3 text-sm text-muted">
                The record itself does not change. What you write is kept beside it, with your
                name and your reason.
              </p>
              <Button variant="secondary" size="sm" onClick={() => setAmending(true)}>
                Amend
              </Button>
            </Card>
          )}

          {consultation.contentHash && (
            <Card title="Integrity">
              <p className="text-xs text-muted">
                Checked nightly against a fingerprint taken when it was signed.
              </p>
              <p className="mt-1 break-all font-mono text-xs text-muted">
                {consultation.contentHash.slice(0, 32)}…
              </p>
            </Card>
          )}

          <Link
            href={`/encounters/${consultation.encounterId}`}
            className="text-sm text-muted underline hover:text-foreground"
          >
            Back to the visit
          </Link>
        </div>
      </div>

      <Modal open={amending} title="Amend this record" onClose={() => setAmending(false)}>
        <div className="flex flex-col gap-3">
          <Field
            label="What kind of change?"
            hint={
              type === 'ADDENDUM'
                ? 'Adds something that was left out. Nothing already written changes.'
                : 'Supersedes one section. The original stays, struck through.'
            }
          >
            <Select
              value={type}
              onChange={(event) => setType(event.target.value as 'ADDENDUM' | 'CORRECTION')}
            >
              <option value="ADDENDUM">Add something</option>
              <option value="CORRECTION">Correct a section</option>
            </Select>
          </Field>

          {type === 'CORRECTION' && (
            <Field label="Which section?">
              <Select
                value={field}
                onChange={(event) => setField(event.target.value as ClinicalSection)}
              >
                {CLINICAL_SECTIONS.map((section) => (
                  <option key={section.key} value={section.key}>
                    {section.label}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <Field label={type === 'CORRECTION' ? 'What it should say' : 'What to add'}>
            <textarea
              rows={4}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="w-full rounded-md border border-line bg-surface px-3 py-2 text-base"
            />
          </Field>

          <TextField
            label="Why?"
            hint="At least a sentence. Somebody else reads this later."
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAmending(false)}>
              Cancel
            </Button>
            <Button
              loading={busy}
              disabled={text.trim().length < 1 || reason.trim().length < 10}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api(`/consultations/${id}/amend`, {
                    method: 'POST',
                    body: {
                      type,
                      field: type === 'CORRECTION' ? field : undefined,
                      current: text,
                      reason,
                    },
                  });
                  await load();
                  setAmending(false);
                  setText('');
                  setReason('');
                } catch (caught) {
                  setError(caught instanceof ApiError ? caught.message : 'Could not amend.');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Record the amendment
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
