"use client";

import Link from "next/link";
import { useState } from "react";
import {
  ALLERGY_BADGE,
  ID_TYPE_LABEL,
  SEX_LABEL,
  api,
  type ClinicalSummary,
  type PatientRecord,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, Chip } from "./ui";

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
  const state = clinical?.allergyState ?? "NOT_RECORDED";
  const badge = ALLERGY_BADGE[state];
  const allergyNames = (clinical?.allergies ?? [])
    .filter((a) => a.status !== "REFUTED")
    .map((a) => a.substance)
    .join(", ");

  const conditions = (clinical?.conditions ?? []).filter(
    (c) => c.status === "ACTIVE",
  );

  return (
    // Sticky *below* the application bar, not level with it. The doctor
    // scrolls a long consultation and the allergy state has to stay on
    // screen the whole way down (PAT-F-14).
    <div className="sticky top-[var(--app-bar-h)] z-20 -mx-4 mb-5 border-b border-line bg-surface/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <span
          aria-hidden
          className="hidden size-11 shrink-0 items-center justify-center rounded-full bg-surface-muted text-sm font-semibold text-muted sm:flex"
        >
          {patient.name.slice(0, 2).toUpperCase()}
        </span>

        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h1 className="truncate text-lg font-semibold tracking-tight">
              {patient.name}
            </h1>
            <span className="font-mono text-sm text-muted tabular">
              {patient.mrn}
            </span>
            {patient.status !== "ACTIVE" && (
              <Chip tone="neutral">
                {patient.status === "MERGED"
                  ? "Merged into another record"
                  : patient.status}
              </Chip>
            )}
          </div>
          <p className="mt-0.5 truncate text-[13px] text-muted">
            {[
              patient.age,
              SEX_LABEL[patient.gender],
              patient.dateOfBirth,
              patient.phoneDisplay,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted">{ID_TYPE_LABEL[patient.idType]}</span>
          <span className="font-mono tabular">{patient.idNumber ?? "—"}</span>
          {/* PAT-F-24: revealing the whole number is a deliberate act, and
              it is recorded against the person who did it. */}
          {!patient.unmasked &&
            patient.idNumber &&
            can("patient.unmask_id") &&
            onUnmask && (
              <Button
                variant="quiet"
                size="xs"
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

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* The allergy state keeps its own colour rather than becoming
              another grey chip: it is the one thing on this strip that
              changes what a clinician does next. */}
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${badge.tone}`}
            title={allergyNames || undefined}
          >
            {state === "SOME" || state === "SEVERE"
              ? `${badge.label}: ${allergyNames}`
              : badge.label}
          </span>
          {conditions.length > 0 && (
            <Chip tone="neutral">
              {conditions.length} condition{conditions.length === 1 ? "" : "s"}
            </Chip>
          )}
          {patient.notes && (
            <span
              className="cursor-help rounded-full bg-primary-soft px-2.5 py-1 text-xs font-medium text-primary-ink"
              title={patient.notes}
            >
              Note
            </span>
          )}
          {compact && (
            <Link
              href={`/patients/${patient.id}`}
              className="text-sm text-muted underline underline-offset-2 hover:text-foreground"
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
export async function loadClinicalSummary(
  patientId: string,
): Promise<ClinicalSummary | null> {
  try {
    return await api<ClinicalSummary>(
      `/patients/${patientId}/clinical-summary`,
    );
  } catch {
    // The front desk has no clinical permission, and the header still has to
    // render. The badge falls back to "not recorded", which is honest.
    return null;
  }
}
