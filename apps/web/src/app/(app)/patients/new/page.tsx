'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import {
  ApiError,
  ID_TYPE_LABEL,
  api,
  type DuplicateCandidate,
  type IdType,
  type PatientRecord,
} from '@/lib/api';
import { Alert, Button, Card, Field, Select, TextField } from '@/components/ui';

const ID_TYPES: IdType[] = ['MYKAD', 'MYKID', 'PASSPORT', 'ARMY', 'POLICE', 'OTHER', 'NONE'];

type Draft = Record<string, string>;

/**
 * Reads a MyKad the way the server does, so the form can fill the date of
 * birth and sex in as it is typed rather than after a round trip.
 *
 * The server does this again and is the authority. This copy exists only so
 * the fields appear while the receptionist is still looking at the card, and
 * it deliberately fails silently: a half-typed number is not an error.
 */
function readMyKad(raw: string): { dateOfBirth: string; gender: string } | null {
  const digits = raw.replaceAll(/\D/g, '');
  if (digits.length !== 12) return null;
  const yy = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const dd = Number(digits.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const thisCentury = new Date(Date.UTC(2000 + yy, mm - 1, dd));
  const date = thisCentury.getTime() <= Date.now() ? thisCentury : new Date(Date.UTC(1900 + yy, mm - 1, dd));
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;

  return {
    dateOfBirth: date.toISOString().slice(0, 10),
    gender: Number(digits.slice(-1)) % 2 === 1 ? 'MALE' : 'FEMALE',
  };
}

/** If what they typed into the search box looks like a card or a phone. */
function seedFrom(query: string): Draft {
  const digits = query.replaceAll(/\D/g, '');
  if (digits.length === 12) return { idNumber: query };
  if (digits.length >= 9 && digits.startsWith('0')) return { phone: query };
  return { name: query };
}

export default function RegisterPatientPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [draft, setDraft] = useState<Draft>({
    idType: 'MYKAD',
    gender: 'UNKNOWN',
    nationality: 'MY',
    ...seedFrom(params.get('q') ?? ''),
  });
  const [derived, setDerived] = useState<string | null>(null);
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (key: string, value: string) => setDraft((d) => ({ ...d, [key]: value }));

  function onIdNumber(value: string) {
    set('idNumber', value);
    if (draft['idType'] === 'MYKAD' || draft['idType'] === 'MYKID') {
      const read = readMyKad(value);
      if (read) {
        setDraft((d) => ({ ...d, idNumber: value, ...read }));
        setDerived('Date of birth and sex read from the card. Change them if the card disagrees.');
      } else {
        setDerived(null);
      }
    }
  }

  const needsNote = draft['idType'] === 'NONE';
  const isMyKad = draft['idType'] === 'MYKAD' || draft['idType'] === 'MYKID';

  function body() {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(draft)) {
      if (value !== undefined && value !== '') out[key] = value;
    }
    if (draft['idType'] === 'NONE') delete out['idNumber'];
    return out;
  }

  async function save(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ patient: PatientRecord; warnings: string[] }>(
        `/patients${force ? '?force=true' : ''}`,
        { method: 'POST', body: body() },
      );
      router.push(`/patients/${created.patient.id}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        const found = (caught.problem.errors as { duplicates?: DuplicateCandidate[] })?.duplicates;
        setDuplicates(found ?? []);
        setError(caught.message);
      } else {
        setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      }
    } finally {
      setBusy(false);
    }
  }

  const blocked = (duplicates ?? []).some((d) => d.certain);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Register a patient</h1>
        <Link href="/patients" className="text-sm text-muted underline hover:text-foreground">
          Back to search
        </Link>
      </div>

      {error && (
        <Alert tone={blocked ? 'danger' : 'warning'} title={blocked ? 'Already registered' : 'Check this first'}>
          {error}
        </Alert>
      )}

      {duplicates && duplicates.length > 0 && (
        <Card title="Records that look like the same person">
          <ul className="flex flex-col gap-3">
            {duplicates.map((candidate) => (
              <li
                key={candidate.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-3 py-2"
              >
                <span>
                  <span className="font-medium">{candidate.name}</span>
                  <span className="block text-sm text-muted">
                    {[candidate.mrn, candidate.idNumberMasked, candidate.dateOfBirth, candidate.phone]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="block text-sm text-muted">{candidate.reason}</span>
                </span>
                <Link href={`/patients/${candidate.id}`}>
                  <Button variant="secondary" size="sm">
                    Open this one
                  </Button>
                </Link>
              </li>
            ))}
          </ul>
          {!blocked && (
            <p className="mt-3 text-sm text-muted">
              If none of these is the person in front of you, register them anyway.
            </p>
          )}
        </Card>
      )}

      <Card title="Identity" description="Everything else can be added later.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Identity document">
            <Select value={draft['idType']} onChange={(e) => set('idType', e.target.value)}>
              {ID_TYPES.map((type) => (
                <option key={type} value={type}>
                  {ID_TYPE_LABEL[type]}
                </option>
              ))}
            </Select>
          </Field>

          {draft['idType'] !== 'NONE' && (
            <TextField
              label="Number"
              hint={isMyKad ? 'Twelve digits. The date of birth and sex come from it.' : undefined}
              value={draft['idNumber'] ?? ''}
              onChange={(e) => onIdNumber(e.target.value)}
              placeholder={isMyKad ? '900101-14-5678' : 'A1234567'}
              autoFocus
            />
          )}

          {draft['idType'] === 'PASSPORT' && (
            <TextField
              label="Issuing country"
              hint="Two letters, such as ID or BD. Two countries use the same numbers."
              value={draft['passportCountry'] ?? ''}
              maxLength={2}
              onChange={(e) => set('passportCountry', e.target.value.toUpperCase())}
            />
          )}
        </div>

        {derived && <Alert tone="info">{derived}</Alert>}

        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TextField
            label="Full name"
            hint="As it appears on the document."
            value={draft['name'] ?? ''}
            onChange={(e) => set('name', e.target.value)}
            autoFocus={draft['idType'] === 'NONE'}
          />
          <TextField
            label="Date of birth"
            type="date"
            value={draft['dateOfBirth'] ?? ''}
            onChange={(e) => set('dateOfBirth', e.target.value)}
          />
          <Field label="Sex">
            <Select value={draft['gender']} onChange={(e) => set('gender', e.target.value)}>
              <option value="MALE">Male</option>
              <option value="FEMALE">Female</option>
              <option value="OTHER">Other</option>
              <option value="UNKNOWN">Not stated</option>
            </Select>
          </Field>
          <TextField
            label="Telephone"
            hint="Any format. It is stored one way so search always finds it."
            value={draft['phone'] ?? ''}
            onChange={(e) => set('phone', e.target.value)}
            placeholder="012-345 6789"
          />
        </div>

        {needsNote && (
          <div className="mt-4">
            <TextField
              label="Who is this?"
              hint="Required with no identity document. For a newborn, the mother's name and telephone number."
              value={draft['notes'] ?? ''}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        )}
      </Card>

      <Card title="Contact" description="Optional now, and useful later.">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Address"
            value={draft['addressLine1'] ?? ''}
            onChange={(e) => set('addressLine1', e.target.value)}
          />
          <TextField
            label="Address line 2"
            value={draft['addressLine2'] ?? ''}
            onChange={(e) => set('addressLine2', e.target.value)}
          />
          <TextField
            label="Postcode"
            value={draft['postcode'] ?? ''}
            maxLength={5}
            inputMode="numeric"
            onChange={(e) => set('postcode', e.target.value)}
          />
          <TextField
            label="City"
            value={draft['city'] ?? ''}
            onChange={(e) => set('city', e.target.value)}
          />
          <TextField
            label="State"
            value={draft['state'] ?? ''}
            onChange={(e) => set('state', e.target.value)}
          />
          <TextField
            label="Email"
            type="email"
            value={draft['email'] ?? ''}
            onChange={(e) => set('email', e.target.value)}
          />
        </div>
        {!needsNote && (
          <div className="mt-4">
            <TextField
              label="Note for the counter"
              hint="Not clinical. Shown on the header, for example &ldquo;prefers Mandarin&rdquo;."
              value={draft['notes'] ?? ''}
              onChange={(e) => set('notes', e.target.value)}
            />
          </div>
        )}
      </Card>

      <div className="flex items-center gap-3">
        <Button loading={busy} onClick={() => void save(false)}>
          Register
        </Button>
        {duplicates && duplicates.length > 0 && !blocked && (
          <Button variant="secondary" loading={busy} onClick={() => void save(true)}>
            Not the same person, register anyway
          </Button>
        )}
        <Link href="/patients">
          <Button variant="ghost">Cancel</Button>
        </Link>
      </div>
    </div>
  );
}
