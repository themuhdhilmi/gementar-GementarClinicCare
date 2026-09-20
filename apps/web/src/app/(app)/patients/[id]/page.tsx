'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useState } from 'react';
import {
  ALLERGY_BADGE,
  ApiError,
  ID_TYPE_LABEL,
  api,
  postForm,
  type Allergy,
  type ClinicalSummary,
  type Condition,
  type PatientConsent,
  type PatientContact,
  type PatientDocument,
  type PatientRecord,
  type VaccinationRow,
} from '@/lib/api';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { PatientHeader, loadClinicalSummary } from '@/components/patient-header';
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  TextField,
  timeAgo,
} from '@/components/ui';

type Tab = 'summary' | 'visits' | 'clinical' | 'documents';

export default function PatientRecordPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const { me, can } = useSession();

  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [clinical, setClinical] = useState<ClinicalSummary | null>(null);
  const [contacts, setContacts] = useState<PatientContact[]>([]);
  const [consents, setConsents] = useState<PatientConsent[]>([]);
  const [documents, setDocuments] = useState<PatientDocument[]>([]);
  const [tab, setTab] = useState<Tab>('summary');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (unmask = false) => {
      const [record, summary, contactList, consentList, documentList] = await Promise.all([
        api<PatientRecord>(`/patients/${id}${unmask ? '?unmask=true' : ''}`),
        loadClinicalSummary(id),
        api<{ items: PatientContact[] }>(`/patients/${id}/contacts`),
        api<{ items: PatientConsent[] }>(`/patients/${id}/consents`),
        api<{ items: PatientDocument[] }>(`/patients/${id}/documents`),
      ]);
      setPatient(record);
      setClinical(summary);
      setContacts(contactList.items);
      setConsents(consentList.items);
      setDocuments(documentList.items);
    },
    [id],
  );

  useAsyncEffect(() => load(), [load]);

  const act = useCallback(
    async (what: string, run: () => Promise<unknown>) => {
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
      }
    },
    [load],
  );

  if (!patient) return <p className="text-sm text-muted">Loading…</p>;

  const tabs: Array<{ key: Tab; label: string; show: boolean }> = [
    { key: 'summary', label: 'Summary', show: true },
    { key: 'visits', label: 'Visits', show: true },
    // PAT-T-11: not rendered at all without the permission. The API refuses
    // it too, and nothing is recorded as viewed.
    { key: 'clinical', label: 'Clinical', show: can('clinical.read') },
    { key: 'documents', label: 'Documents', show: true },
  ];

  return (
    <div>
      <PatientHeader patient={patient} clinical={clinical} onUnmask={() => load(true)} />

      {/* ENC-F-01: one click from the record into the queue. The workflow
          the clinic runs two hundred times a day is search, open, check in,
          so it does not get buried behind a form. */}
      {can('encounter.create') && patient.status === 'ACTIVE' && (
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Button
            onClick={async () => {
              setError(null);
              try {
                const created = await api<{ encounter: { id: string; queueNo: string } }>(
                  `/branches/${me?.activeBranchId}/encounters`,
                  { method: 'POST', body: { patientId: id } },
                );
                router.push(`/encounters/${created.encounter.id}`);
              } catch (caught) {
                setError(caught instanceof ApiError ? caught.message : 'Could not check in.');
              }
            }}
          >
            Check in
          </Button>
          <span className="text-sm text-muted">Joins today&rsquo;s queue at this branch.</span>
        </div>
      )}

      {patient.status === 'MERGED' && patient.mergedIntoId && (
        <Alert tone="warning" title="This record was merged">
          Everything now lives on{' '}
          <Link className="underline" href={`/patients/${patient.mergedIntoId}`}>
            the surviving record
          </Link>
          .
        </Alert>
      )}
      {error && <Alert title="Not done">{error}</Alert>}
      {notice && <Alert tone="success">{notice}</Alert>}

      <nav className="mb-4 flex gap-1 border-b border-line" aria-label="Patient record">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-current={tab === t.key ? 'page' : undefined}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                tab === t.key
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
      </nav>

      {tab === 'summary' && (
        <SummaryTab
          patient={patient}
          contacts={contacts}
          consents={consents}
          onAct={act}
          canWrite={can('patient.write')}
          canDelete={can('patient.merge')}
        />
      )}
      {tab === 'visits' && (
        <EmptyState title="No visits yet">
          Visits appear here once the encounter module is in use.
        </EmptyState>
      )}
      {tab === 'clinical' && clinical && (
        <ClinicalTab
          patientId={id}
          clinical={clinical}
          onAct={act}
          canRecord={can('triage.write')}
          canVerify={can('clinical.write')}
        />
      )}
      {tab === 'documents' && (
        <DocumentsTab
          patientId={id}
          documents={documents}
          onAct={act}
          canWrite={can('patient.write')}
        />
      )}
    </div>
  );
}

type Act = (what: string, run: () => Promise<unknown>) => Promise<boolean>;

function SummaryTab({
  patient,
  contacts,
  consents,
  onAct,
  canWrite,
  canDelete,
}: {
  patient: PatientRecord;
  contacts: PatientContact[];
  consents: PatientConsent[];
  onAct: Act;
  canWrite: boolean;
  canDelete: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [addingContact, setAddingContact] = useState(false);
  const [contact, setContact] = useState({ name: '', relationship: '', phone: '' });
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');

  function startEditing() {
    setDraft({
      name: patient.name,
      phone: patient.phone ?? '',
      email: patient.email ?? '',
      addressLine1: patient.addressLine1 ?? '',
      addressLine2: patient.addressLine2 ?? '',
      postcode: patient.postcode ?? '',
      city: patient.city ?? '',
      state: patient.state ?? '',
      occupation: patient.occupation ?? '',
      notes: patient.notes ?? '',
    });
    setEditing(true);
  }

  const consentOf = (channel: string, purpose: string) =>
    consents.find((c) => c.channel === channel && c.purpose === purpose)?.granted ?? false;

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="Details"
        actions={
          canWrite && !editing ? (
            <Button variant="secondary" size="sm" onClick={startEditing}>
              Edit
            </Button>
          ) : undefined
        }
      >
        {editing ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['name', 'Full name'],
                  ['phone', 'Telephone'],
                  ['email', 'Email'],
                  ['addressLine1', 'Address'],
                  ['addressLine2', 'Address line 2'],
                  ['postcode', 'Postcode'],
                  ['city', 'City'],
                  ['state', 'State'],
                  ['occupation', 'Occupation'],
                  ['notes', 'Note for the counter'],
                ] as const
              ).map(([key, label]) => (
                <TextField
                  key={key}
                  label={label}
                  value={draft[key] ?? ''}
                  onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
                />
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <Button
                onClick={async () => {
                  const ok = await onAct('Saved.', () =>
                    api(`/patients/${patient.id}`, { method: 'PATCH', body: draft }),
                  );
                  if (ok) setEditing(false);
                }}
              >
                Save
              </Button>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
            {(
              [
                ['Identity', `${ID_TYPE_LABEL[patient.idType]} ${patient.idNumber ?? '—'}`],
                ['Date of birth', patient.dateOfBirth ?? 'Not recorded'],
                ['Telephone', patient.phoneDisplay ?? '—'],
                ['Email', patient.email ?? '—'],
                [
                  'Address',
                  [patient.addressLine1, patient.addressLine2, patient.postcode, patient.city, patient.state]
                    .filter(Boolean)
                    .join(', ') || '—',
                ],
                ['Occupation', patient.occupation ?? '—'],
                ['Registered', timeAgo(patient.createdAt)],
                ['Note', patient.notes ?? '—'],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt className="text-sm text-muted">{label}</dt>
                <dd className="text-sm">{value}</dd>
              </div>
            ))}
          </dl>
        )}
      </Card>

      <Card
        title="Emergency contacts"
        actions={
          canWrite ? (
            <Button variant="secondary" size="sm" onClick={() => setAddingContact(true)}>
              Add
            </Button>
          ) : undefined
        }
      >
        {contacts.length === 0 ? (
          <EmptyState title="Nobody listed" />
        ) : (
          <ul className="flex flex-col gap-2">
            {contacts.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className="font-medium">{c.name}</span>
                  {c.relationship && <span className="text-muted"> · {c.relationship}</span>}
                  <span className="block text-muted">{c.phone}</span>
                </span>
                <span className="flex items-center gap-2">
                  {c.isPrimary && (
                    <span className="rounded-full bg-primary-soft px-2 py-0.5 text-xs text-primary-ink">
                      First call
                    </span>
                  )}
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void onAct('Contact removed.', () =>
                          api(`/patients/${patient.id}/contacts/${c.id}`, { method: 'DELETE' }),
                        )
                      }
                    >
                      Remove
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Reminders and messages" description="Each one is off until the patient agrees.">
        <div className="flex flex-col gap-2">
          {(['SMS', 'WHATSAPP', 'EMAIL'] as const).flatMap((channel) =>
            (['REMINDERS', 'MARKETING'] as const).map((purpose) => (
              <label key={`${channel}-${purpose}`} className="flex items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  disabled={!canWrite}
                  checked={consentOf(channel, purpose)}
                  onChange={(e) =>
                    void onAct('Saved.', () =>
                      api(`/patients/${patient.id}/consents`, {
                        method: 'PUT',
                        body: { consents: [{ channel, purpose, granted: e.target.checked }] },
                      }),
                    )
                  }
                />
                <span>
                  {channel === 'WHATSAPP' ? 'WhatsApp' : channel === 'SMS' ? 'SMS' : 'Email'}{' '}
                  <span className="text-muted">
                    {purpose === 'REMINDERS' ? 'appointment reminders' : 'offers and news'}
                  </span>
                </span>
              </label>
            )),
          )}
        </div>
      </Card>

      {canDelete && patient.status === 'ACTIVE' && (
        <Card title="Remove this record">
          <p className="text-sm text-muted">
            The record stops appearing in search. Nothing is deleted: the patient&rsquo;s name
            stays on every invoice and visit already recorded.
          </p>
          <div className="mt-3">
            <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
              Remove from search
            </Button>
          </div>
        </Card>
      )}

      <Modal open={addingContact} title="Add an emergency contact" onClose={() => setAddingContact(false)}>
        <div className="flex flex-col gap-3">
          <TextField
            label="Name"
            value={contact.name}
            onChange={(e) => setContact({ ...contact, name: e.target.value })}
          />
          <TextField
            label="Relationship"
            value={contact.relationship}
            onChange={(e) => setContact({ ...contact, relationship: e.target.value })}
          />
          <TextField
            label="Telephone"
            value={contact.phone}
            onChange={(e) => setContact({ ...contact, phone: e.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAddingContact(false)}>
              Cancel
            </Button>
            <Button
              onClick={async () => {
                const ok = await onAct('Contact added.', () =>
                  api(`/patients/${patient.id}/contacts`, { method: 'POST', body: contact }),
                );
                if (ok) {
                  setAddingContact(false);
                  setContact({ name: '', relationship: '', phone: '' });
                }
              }}
            >
              Add
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={deleting} title="Remove this record from search?" onClose={() => setDeleting(false)}>
        <TextField
          label="Why?"
          hint="Recorded against your name in the audit trail."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(false)}>
            Keep it
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const ok = await onAct('Removed from search.', () =>
                api(`/patients/${patient.id}/delete`, { method: 'POST', body: { reason } }),
              );
              if (ok) setDeleting(false);
            }}
          >
            Remove
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** PRC-F-11. Hidden entirely when the patient has had none. */
function VaccinationsCard({ patientId }: { patientId: string }) {
  const [items, setItems] = useState<VaccinationRow[]>([]);

  useAsyncEffect(async () => {
    const next = await api<{ items: VaccinationRow[] }>(`/patients/${patientId}/vaccinations`);
    setItems(next.items);
  }, [patientId]);

  if (items.length === 0) return null;

  return (
    <Card title="Vaccinations">
      <ul className="flex flex-col gap-2 text-sm">
        {items.map((row) => (
          <li key={row.id}>
            <span className={row.withdrawn ? 'text-muted line-through' : 'font-medium'}>
              {row.vaccineName}
              {row.doseNumber ? ` (dose ${row.doseNumber})` : ''}
            </span>
            <span className="block text-xs text-muted">
              {new Date(row.givenAt).toLocaleDateString()} · batch {row.batchNo}
              {row.expiry ? ` · expires ${row.expiry.slice(0, 10)}` : ''}
              {row.site ? ` · ${row.site}` : ''}
              {row.givenByName ? ` · ${row.givenByName}` : ''}
            </span>
            {row.withdrawn && (
              <span className="block text-xs text-danger">
                Withdrawn: {row.withdrawnReason}
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ClinicalTab({
  patientId,
  clinical,
  onAct,
  canRecord,
  canVerify,
}: {
  patientId: string;
  clinical: ClinicalSummary;
  onAct: Act;
  canRecord: boolean;
  canVerify: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [allergy, setAllergy] = useState({
    type: 'DRUG',
    substance: '',
    reaction: '',
    severity: 'MODERATE',
  });
  const [refuting, setRefuting] = useState<Allergy | null>(null);
  const [reason, setReason] = useState('');
  const [condition, setCondition] = useState('');

  const active = clinical.allergies.filter((a) => a.status !== 'REFUTED');
  const refuted = clinical.allergies.filter((a) => a.status === 'REFUTED');

  return (
    <div className="flex flex-col gap-5">
      <Card
        title="Allergies"
        actions={
          canRecord ? (
            <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
              Record an allergy
            </Button>
          ) : undefined
        }
      >
        <div
          className={`mb-4 rounded-md px-3 py-2 text-sm font-medium ${
            ALLERGY_BADGE[clinical.allergyState].tone
          }`}
        >
          {ALLERGY_BADGE[clinical.allergyState].label}
          {clinical.allergyState === 'NOT_RECORDED' && canRecord && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-3"
              onClick={() =>
                void onAct('Recorded as no known allergies.', () =>
                  api(`/patients/${patientId}/nkda`, { method: 'PUT', body: { nkda: true } }),
                )
              }
            >
              Record &ldquo;no known allergies&rdquo;
            </Button>
          )}
        </div>

        {active.length === 0 ? (
          <p className="text-sm text-muted">None recorded.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {active.map((a) => (
              <li key={a.id} className="rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{a.substance}</span>
                  <span className="flex items-center gap-2 text-xs">
                    <span className="rounded-full bg-surface-muted px-2 py-0.5">{a.type}</span>
                    {a.severity && (
                      <span
                        className={`rounded-full px-2 py-0.5 ${
                          a.severity === 'SEVERE' || a.severity === 'LIFE_THREATENING'
                            ? 'bg-danger-soft text-danger'
                            : 'bg-warning-soft text-warning'
                        }`}
                      >
                        {a.severity.replace('_', ' ').toLowerCase()}
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2 py-0.5 ${
                        a.status === 'VERIFIED'
                          ? 'bg-success-soft text-success'
                          : 'bg-warning-soft text-warning'
                      }`}
                    >
                      {a.status === 'VERIFIED' ? 'Verified' : 'Not yet verified'}
                    </span>
                  </span>
                </div>
                {a.reaction && <p className="mt-1 text-sm text-muted">{a.reaction}</p>}
                {canVerify && (
                  <div className="mt-2 flex gap-2">
                    {a.status === 'UNVERIFIED' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void onAct('Verified.', () =>
                            api(`/patients/${patientId}/allergies/${a.id}/verify`, {
                              method: 'POST',
                            }),
                          )
                        }
                      >
                        Verify
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setRefuting(a)}>
                      Not an allergy
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        {refuted.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-muted">
              {refuted.length} previously recorded and since ruled out
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {refuted.map((a) => (
                <li key={a.id} className="text-sm text-muted">
                  <span className="line-through">{a.substance}</span>
                  {a.refutedReason && <span> — {a.refutedReason}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>

      {/* PRC-F-11: the basis for an immunisation certificate in V1, and
          the thing a recall searches today. */}
      <VaccinationsCard patientId={patientId} />

      <Card title="Long-term conditions">
        {clinical.conditions.length === 0 ? (
          <p className="text-sm text-muted">None recorded.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {clinical.conditions.map((c: Condition) => (
              <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                <span>
                  <span className={c.status === 'RESOLVED' ? 'text-muted line-through' : ''}>
                    {c.condition}
                  </span>
                  {c.icd10Code && <span className="ml-2 font-mono text-xs text-muted">{c.icd10Code}</span>}
                  {c.onsetDate && <span className="block text-muted">since {c.onsetDate}</span>}
                </span>
                {canRecord && c.status === 'ACTIVE' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void onAct('Marked resolved.', () =>
                        api(`/patients/${patientId}/conditions/${c.id}`, {
                          method: 'PATCH',
                          body: { condition: c.condition, status: 'RESOLVED' },
                        }),
                      )
                    }
                  >
                    Resolved
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {canRecord && (
          <div className="mt-4 flex items-end gap-2">
            <TextField
              label="Add a condition"
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
            />
            <Button
              variant="secondary"
              disabled={condition.trim().length < 2}
              onClick={async () => {
                const ok = await onAct('Condition recorded.', () =>
                  api(`/patients/${patientId}/conditions`, {
                    method: 'POST',
                    body: { condition },
                  }),
                );
                if (ok) setCondition('');
              }}
            >
              Add
            </Button>
          </div>
        )}
      </Card>

      <Modal open={adding} title="Record an allergy" onClose={() => setAdding(false)}>
        <div className="flex flex-col gap-3">
          <Field label="Kind">
            <Select
              value={allergy.type}
              onChange={(e) => setAllergy({ ...allergy, type: e.target.value })}
            >
              <option value="DRUG">Medicine</option>
              <option value="FOOD">Food</option>
              <option value="ENVIRONMENT">Environment</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
          <TextField
            label="Substance"
            value={allergy.substance}
            onChange={(e) => setAllergy({ ...allergy, substance: e.target.value })}
          />
          <TextField
            label="What happens"
            value={allergy.reaction}
            onChange={(e) => setAllergy({ ...allergy, reaction: e.target.value })}
          />
          <Field
            label="How bad"
            hint="Required for a medicine. It decides whether a prescription is blocked or only flagged."
          >
            <Select
              value={allergy.severity}
              onChange={(e) => setAllergy({ ...allergy, severity: e.target.value })}
            >
              <option value="MILD">Mild</option>
              <option value="MODERATE">Moderate</option>
              <option value="SEVERE">Severe</option>
              <option value="LIFE_THREATENING">Life threatening</option>
            </Select>
          </Field>
          {!canVerify && (
            <Alert tone="info">
              This will be recorded as not yet verified. A doctor confirms it.
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAdding(false)}>
              Cancel
            </Button>
            <Button
              disabled={allergy.substance.trim().length < 2}
              onClick={async () => {
                const ok = await onAct('Allergy recorded.', () =>
                  api(`/patients/${patientId}/allergies`, { method: 'POST', body: allergy }),
                );
                if (ok) {
                  setAdding(false);
                  setAllergy({ type: 'DRUG', substance: '', reaction: '', severity: 'MODERATE' });
                }
              }}
            >
              Record
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={refuting !== null}
        title={`Rule out ${refuting?.substance ?? ''}?`}
        onClose={() => setRefuting(null)}
      >
        <p className="text-sm text-muted">
          The entry stays in the record with your name and this reason, so the next prescriber
          can see the question was asked and answered.
        </p>
        <div className="mt-3">
          <TextField
            label="Why is this not an allergy?"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRefuting(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 3}
            onClick={async () => {
              const ok = await onAct('Ruled out.', () =>
                api(`/patients/${patientId}/allergies/${refuting!.id}/refute`, {
                  method: 'POST',
                  body: { reason },
                }),
              );
              if (ok) {
                setRefuting(null);
                setReason('');
              }
            }}
          >
            Rule out
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function DocumentsTab({
  patientId,
  documents,
  onAct,
  canWrite,
}: {
  patientId: string;
  documents: PatientDocument[];
  onAct: Act;
  canWrite: boolean;
}) {
  const [type, setType] = useState('ID_COPY');
  const [busy, setBusy] = useState(false);

  async function open(document: PatientDocument) {
    const link = await api<{ url: string }>(`/patients/${patientId}/documents/${document.id}`);
    window.open(link.url, '_blank', 'noopener');
  }

  return (
    <Card title="Attachments" description="Scans and letters. PDF, JPEG or PNG, up to 20 MB.">
      {canWrite && (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <Field label="What is it?">
            <Select value={type} onChange={(e) => setType(e.target.value)} className="w-56">
              <option value="ID_COPY">Copy of identity document</option>
              <option value="REFERRAL_IN">Referral letter</option>
              <option value="LAB_RESULT">Laboratory result</option>
              <option value="CONSENT">Signed consent</option>
              <option value="OTHER">Something else</option>
            </Select>
          </Field>
          <label className="inline-flex">
            <Input
              type="file"
              accept="application/pdf,image/jpeg,image/png"
              className="hidden"
              disabled={busy}
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                setBusy(true);
                const form = new FormData();
                form.append('type', type);
                form.append('file', file);
                await onAct('Attached.', () => postForm(`/patients/${patientId}/documents`, form));
                setBusy(false);
              }}
            />
            <Button
              variant="secondary"
              loading={busy}
              onClick={(event) =>
                (event.currentTarget.previousElementSibling as HTMLInputElement)?.click()
              }
            >
              Choose a file
            </Button>
          </label>
        </div>
      )}

      {documents.length === 0 ? (
        <EmptyState title="Nothing attached yet" />
      ) : (
        <ul className="flex flex-col gap-2">
          {documents.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                <button className="font-medium underline" onClick={() => void open(d)}>
                  {d.filename}
                </button>
                <span className="block text-muted">
                  {d.type.replace('_', ' ').toLowerCase()} · {Math.round(d.sizeBytes / 1024)} KB ·{' '}
                  {timeAgo(d.uploadedAt)}
                </span>
              </span>
              {canWrite && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    void onAct('Removed.', () =>
                      api(`/patients/${patientId}/documents/${d.id}`, { method: 'DELETE' }),
                    )
                  }
                >
                  Remove
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
