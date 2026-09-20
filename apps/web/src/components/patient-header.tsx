'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  ALLERGY_BADGE,
  ID_TYPE_LABEL,
  SEX_LABEL,
  api,
  type ClinicalSummary,
  type PatientRecord,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button } from './ui';

/**
 * The strip that sits above every screen showing one patient (PAT-F-14).
 *
 * Triage, consultation, prescribing and dispensing all reuse this rather than
 * building their own, which is the point: a doctor must see the same allergy
 * state in the same place whatever screen they are on, and four
 * implementations would eventually disagree about which one is amber.
 *
 * It takes the clinical summary as a prop rather than fetching it, so that
 * the allergy badge costs no extra round trip (PAT-N-03).
 */
export function PatientHeader({
  patient,
  clinical,
  onUnmask,
  compact = false,
}: {
  patient: PatientRecord;
  clinical?: ClinicalSummary | null;
  onUnmask?: () => Promise<void>;
  compact?: boolean;
}) {
  const { can } = useSession();
  const [unmasking, setUnmasking] = useState(false);

  // Without the clinical summary the badge cannot be trusted, so it says so
  // rather than guessing green.
  const state = clinical?.allergyState ?? 'NOT_RECORDED';
  const badge = ALLERGY_BADGE[state];
  const allergyNames = (clinical?.allergies ?? [])
    .filter((a) => a.status !== 'REFUTED')
    .map((a) => a.substance)
    .join(', ');

  return (
    <div className="sticky top-0 z-30 -mx-4 mb-5 border-b border-line bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h1 className="truncate text-lg font-semibold">{patient.name}</h1>
            <span className="font-mono text-sm text-muted">{patient.mrn}</span>
            {patient.status !== 'ACTIVE' && (
              <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-muted">
                {patient.status === 'MERGED' ? 'Merged into another record' : patient.status}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-sm text-muted">
            {[
              patient.age,
              SEX_LABEL[patient.gender],
              patient.dateOfBirth,
              patient.phoneDisplay,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">{ID_TYPE_LABEL[patient.idType]}</span>
          <span className="font-mono">{patient.idNumber ?? '—'}</span>
          {/* PAT-F-24: revealing the whole number is a deliberate act, and
              it is recorded against the person who did it. */}
          {!patient.unmasked && patient.idNumber && can('patient.unmask_id') && onUnmask && (
            <Button
              variant="ghost"
              size="sm"
              loading={unmasking}
              onClick={async () => {
                setUnmasking(true);
                try {
                  await onUnmask();
                } finally {
                  setUnmasking(false);
                }
              }}
            >
              Show
            </Button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${badge.tone}`}
            title={allergyNames || undefined}
          >
            {state === 'SOME' || state === 'SEVERE'
              ? `${badge.label}: ${allergyNames}`
              : badge.label}
          </span>
          {(clinical?.conditions ?? []).some((c) => c.status === 'ACTIVE') && (
            <span className="rounded-full bg-surface-muted px-2.5 py-1 text-xs text-foreground">
              {clinical!.conditions.filter((c) => c.status === 'ACTIVE').length} condition
              {clinical!.conditions.filter((c) => c.status === 'ACTIVE').length === 1 ? '' : 's'}
            </span>
          )}
          {patient.notes && (
            <span
              className="cursor-help rounded-full bg-primary-soft px-2.5 py-1 text-xs text-primary-ink"
              title={patient.notes}
            >
              Note
            </span>
          )}
          {compact && (
            <Link
              href={`/patients/${patient.id}`}
              className="text-sm text-muted underline hover:text-foreground"
            >
              Open record
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

/** Fetches the summary for a screen that does not already hold one. */
export async function loadClinicalSummary(patientId: string): Promise<ClinicalSummary | null> {
  try {
    return await api<ClinicalSummary>(`/patients/${patientId}/clinical-summary`);
  } catch {
    // The front desk has no clinical permission, and the header still has to
    // render. The badge falls back to "not recorded", which is honest.
    return null;
  }
}
