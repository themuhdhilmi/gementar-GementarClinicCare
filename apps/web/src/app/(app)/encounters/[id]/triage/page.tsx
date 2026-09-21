"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import {
  ApiError,
  FLAG_TONE,
  VITAL_FIELDS,
  api,
  levelFor,
  type ClinicalSummary,
  type EncounterChart,
  type PatientRecord,
  type TriageForm,
  type VitalFieldKey,
} from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import {
  PatientHeader,
  loadClinicalSummary,
} from "@/components/patient-header";
import {
  Alert,
  Button,
  Card,
  Chip,
  Field,
  Input,
  Modal,
  PageHeader,
  Skeleton,
  TextField,
} from "@/components/ui";

type Draft = Partial<Record<VitalFieldKey, string>> & {
  complaint?: string;
  notes?: string;
};

/**
 * The nurse station (TRI §11).
 *
 * Designed to be finished in under a minute with a patient standing there:
 * one column, in the order readings are actually taken, strict tab order,
 * fixed unit labels, and the last reading shown greyed beside each field so
 * a nurse can see at a glance what has changed.
 *
 * Values colour themselves as they are typed, against the same bands the
 * server will use. Advisory only — a nurse who cannot record what they
 * measured will write it on paper instead, and then it is not in the record
 * at all.
 */
export default function TriagePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const encounterId = params.id;

  const [form, setForm] = useState<TriageForm | null>(null);
  const [chart, setChart] = useState<EncounterChart | null>(null);
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [clinical, setClinical] = useState<ClinicalSummary | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askingAllergies, setAskingAllergies] = useState(false);
  const [allergy, setAllergy] = useState("");

  const load = useCallback(async () => {
    const [next, encounter] = await Promise.all([
      api<TriageForm>(`/encounters/${encounterId}/triage`),
      api<EncounterChart>(`/encounters/${encounterId}`),
    ]);
    setForm(next);
    setChart(encounter);
    const [record, summary] = await Promise.all([
      api<PatientRecord>(`/patients/${encounter.encounter.patientId}`),
      loadClinicalSummary(encounter.encounter.patientId),
    ]);
    setPatient(record);
    setClinical(summary);
    // TRI-F-04: height is filled in, because an adult's does not change and
    // retyping it is a chance to get it wrong. Weight never is: it is the
    // thing being measured today.
    if (next.prefill.heightCm !== null) {
      setDraft((current) => ({
        ...current,
        heightCm: String(next.prefill.heightCm),
      }));
    }
    setAskingAllergies(next.allergyPromptNeeded);
  }, [encounterId]);

  useAsyncEffect(() => load(), [load]);

  if (!form || !chart || !patient)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-16" />
        <Skeleton className="h-64" />
      </div>
    );

  const numeric = (key: VitalFieldKey): number | null => {
    const raw = draft[key];
    if (raw === undefined || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  const worst = VITAL_FIELDS.reduce<"NONE" | "ABNORMAL" | "CRITICAL">(
    (level, field) => {
      const own = levelFor(
        numeric(field.key),
        form.thresholds[field.stored],
        field.scale,
      );
      if (own === "CRITICAL" || level === "CRITICAL") return "CRITICAL";
      if (own === "ABNORMAL" || level === "ABNORMAL") return "ABNORMAL";
      return "NONE";
    },
    "NONE",
  );

  const anything =
    VITAL_FIELDS.some((field) => numeric(field.key) !== null) ||
    Boolean(draft.complaint?.trim()) ||
    Boolean(draft.notes?.trim());

  async function save(advance: boolean, escalate = false) {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { advance, escalate };
      for (const field of VITAL_FIELDS) {
        const value = numeric(field.key);
        if (value !== null) body[field.key] = value;
      }
      if (draft.complaint?.trim()) body["complaint"] = draft.complaint.trim();
      if (draft.notes?.trim()) body["notes"] = draft.notes.trim();

      await api(`/encounters/${encounterId}/triage`, { method: "POST", body });
      router.push(advance ? "/queue" : `/encounters/${encounterId}`);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  }

  const last = form.prefill.lastReading;

  return (
    <div>
      <PatientHeader patient={patient} clinical={clinical} compact />

      <PageHeader
        title="Triage"
        description="Blood pressure, temperature and the rest. Leave anything not measured empty rather than guessing it."
        meta={
          <>
            <span className="font-mono text-base tabular">
              {chart.encounter.queueNo}
            </span>
            {form.isChild && (
              <Chip tone="info">
                Child — readings judged against paediatric ranges
              </Chip>
            )}
            {form.records.length > 0 && (
              <span className="text-muted">
                {form.records.length} set
                {form.records.length === 1 ? "" : "s"} already recorded
              </span>
            )}
          </>
        }
      />

      {/* TRI §11: full-width and red, because the point is that it is seen. */}
      {worst === "CRITICAL" && (
        <div className="mb-4 rounded-xl border-l-4 border-danger bg-danger-soft px-4 py-3 shadow-e1">
          <p className="font-semibold text-danger">
            A reading here is in the critical range.
          </p>
          <p className="mt-1 text-sm text-danger">
            Saving will offer to move this patient to the front of every queue.
          </p>
        </div>
      )}

      {error && <Alert title="Not saved">{error}</Alert>}

      <div className="grid gap-5 lg:grid-cols-[28rem_1fr]">
        <Card
          title="Readings"
          description="Tab through. Leave anything not measured empty."
        >
          <div className="flex flex-col gap-3">
            {VITAL_FIELDS.map((field) => {
              const value = numeric(field.key);
              const level = levelFor(
                value,
                form.thresholds[field.stored],
                field.scale,
              );
              const previous = last ? (last[field.key] as number | null) : null;
              return (
                <Field
                  key={field.key}
                  label={`${field.label} (${field.unit})`}
                  hint={
                    previous !== null ? `Last time: ${previous}` : undefined
                  }
                >
                  <Input
                    type="number"
                    step={field.step}
                    inputMode="decimal"
                    value={draft[field.key] ?? ""}
                    onChange={(event) =>
                      setDraft({ ...draft, [field.key]: event.target.value })
                    }
                    className={`max-w-40 ${FLAG_TONE[level]}`}
                    aria-invalid={level !== "NONE"}
                  />
                </Field>
              );
            })}
          </div>

          {numeric("weightKg") !== null && numeric("heightCm") !== null && (
            <p className="mt-3 text-sm text-muted">
              Body mass index{" "}
              <span className="font-medium text-foreground">
                {(
                  numeric("weightKg")! /
                  ((numeric("heightCm")! / 100) * (numeric("heightCm")! / 100))
                ).toFixed(1)}
              </span>
              , worked out on save.
            </p>
          )}
        </Card>

        <div className="flex flex-col gap-5">
          <Card title="What brought them in">
            <div className="flex flex-col gap-3">
              <TextField
                label="Presenting complaint"
                value={draft.complaint ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, complaint: event.target.value })
                }
                placeholder="Cough and fever for three days"
              />
              <TextField
                label="Nurse notes"
                value={draft.notes ?? ""}
                onChange={(event) =>
                  setDraft({ ...draft, notes: event.target.value })
                }
                placeholder="Anything the doctor should know before they walk in"
              />
            </div>
          </Card>

          {form.records.length > 0 && (
            <Card title="Already recorded this visit">
              <ul className="flex flex-col gap-2 text-sm">
                {form.records.map((record) => (
                  <li
                    key={record.id}
                    className="flex items-baseline justify-between gap-3"
                  >
                    <span>
                      <span className="font-medium">Set {record.sequence}</span>
                      <span className="text-muted">
                        {" "}
                        {[
                          record.systolic &&
                            `${record.systolic}/${record.diastolic}`,
                          record.heartRate && `${record.heartRate} bpm`,
                          record.temperature && `${record.temperature} °C`,
                          record.spo2 && `${record.spo2}%`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                    {record.maxFlagLevel !== "NONE" && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                          record.maxFlagLevel === "CRITICAL"
                            ? "bg-danger-soft text-danger"
                            : "bg-warning-soft text-warning"
                        }`}
                      >
                        {record.maxFlagLevel === "CRITICAL"
                          ? "Critical"
                          : "Abnormal"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              loading={busy}
              disabled={!anything}
              onClick={() => void save(true, worst === "CRITICAL")}
            >
              Save and send to the doctor
            </Button>
            <Button
              variant="secondary"
              loading={busy}
              disabled={!anything}
              onClick={() => void save(false)}
            >
              Save, keep here
            </Button>
            <Link
              href="/queue"
              className="text-sm text-muted underline hover:text-foreground"
            >
              Back to today
            </Link>
          </div>
          {!anything && (
            <p className="text-sm text-muted">
              Record at least one reading, or a note saying why there is none.
            </p>
          )}
        </div>
      </div>

      {/* TRI-F-05: asked once, when nobody has. */}
      <Modal
        open={askingAllergies}
        title="Has anyone asked about allergies?"
        onClose={() => setAskingAllergies(false)}
      >
        <p className="text-sm text-muted">
          Nothing is recorded for this patient yet, which is not the same as
          their having none. The doctor sees the difference.
        </p>
        <div className="mt-4 flex flex-col gap-3">
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/patients/${patient.id}/nkda`, {
                  method: "PUT",
                  body: { nkda: true },
                });
                await load();
                setAskingAllergies(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            No known allergies
          </Button>
          <div className="flex items-end gap-2">
            <TextField
              label="Or record one"
              value={allergy}
              onChange={(event) => setAllergy(event.target.value)}
              placeholder="Penicillin"
            />
            <Button
              variant="secondary"
              disabled={allergy.trim().length < 2}
              onClick={async () => {
                setBusy(true);
                try {
                  await api(`/patients/${patient.id}/allergies`, {
                    method: "POST",
                    body: {
                      type: "DRUG",
                      substance: allergy,
                      severity: "MODERATE",
                    },
                  });
                  await load();
                  setAllergy("");
                  setAskingAllergies(false);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Add
            </Button>
          </div>
          <Button variant="ghost" onClick={() => setAskingAllergies(false)}>
            Not now
          </Button>
        </div>
      </Modal>
    </div>
  );
}
