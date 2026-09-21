"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  CLINICAL_SECTIONS,
  STATUS_LABEL,
  api,
  expandPhrases,
  type ClinicalSection,
  type ClinicalSummary,
  type ClinicalTemplate,
  type Consultation,
  type ConsultationSummary,
  type ConsultationView,
  type Diagnosis,
  type EncounterChart,
  type PatientRecord,
  type PrescriptionView,
  type QuickPhrase,
  type TriageForm,
} from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import {
  PatientHeader,
  loadClinicalSummary,
} from "@/components/patient-header";
import {
  PrescriptionPanel,
  PrescriptionSignSummary,
} from "@/components/prescription-panel";
import { ProcedurePanel } from "@/components/procedure-panel";
import { DocumentsPanel } from "@/components/documents-panel";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  TextField,
  timeAgo,
} from "@/components/ui";

type Sections = Partial<Record<ClinicalSection, string>>;

/**
 * The screen a doctor lives in for six hours a day (CON §11).
 *
 * Three columns: what is known about the patient on the left, the note in
 * the middle, everything that happens next on the right. Nothing is behind
 * a tab, because a doctor scanning a note should not have to remember which
 * tab the examination was on.
 *
 * It autosaves. The draft has to survive a browser crash, a dead machine
 * and the doctor logging in somewhere else, because the alternative — a
 * doctor who has lost a note once — is a doctor who goes back to paper.
 */
export default function ConsultationPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const encounterId = params.id;

  const [view, setView] = useState<ConsultationView | null>(null);
  const [chart, setChart] = useState<EncounterChart | null>(null);
  const [patient, setPatient] = useState<PatientRecord | null>(null);
  const [clinical, setClinical] = useState<ClinicalSummary | null>(null);
  const [vitals, setVitals] = useState<TriageForm | null>(null);
  const [previous, setPrevious] = useState<ConsultationSummary[]>([]);
  const [templates, setTemplates] = useState<ClinicalTemplate[]>([]);
  const [phrases, setPhrases] = useState<QuickPhrase[]>([]);

  const [sections, setSections] = useState<Sections>({});
  const [diagnoses, setDiagnoses] = useState<Diagnosis[]>([]);
  const [newDiagnosis, setNewDiagnosis] = useState("");
  const [saving, setSaving] = useState<
    "saved" | "saving" | "unsaved" | "failed"
  >("saved");
  const [lastSaved, setLastSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [rx, setRx] = useState<PrescriptionView | null>(null);
  /** RX-R-04: per item, and cleared whenever the sign dialog opens. */
  const [confirmed, setConfirmed] = useState<string[]>([]);
  /**
   * DOC-R-01: a certificate can only be made from a signed record, so
   * the doctor says here that one is wanted and issues it on the next
   * screen. Ticking it keeps them on this page after signing instead of
   * sending them back to the queue with the patient still waiting.
   */
  const [wantsPaperwork, setWantsPaperwork] = useState(false);

  const dirty = useRef(false);
  const consultationId = view?.consultation.id ?? null;

  const load = useCallback(async () => {
    const encounter = await api<EncounterChart>(`/encounters/${encounterId}`);
    setChart(encounter);

    // One draft per doctor per visit: reuse it, or start one.
    let current: Consultation;
    try {
      current = await api<Consultation>(
        `/encounters/${encounterId}/consultations`,
        {
          method: "POST",
          body: {},
        },
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "draft_exists") {
        const existing = (caught.problem.errors as { consultationId: string })
          .consultationId;
        current = (await api<ConsultationView>(`/consultations/${existing}`))
          .consultation;
      } else {
        throw caught;
      }
    }

    const [full, record, summary, triage, history, templateList, phraseList] =
      await Promise.all([
        api<ConsultationView>(`/consultations/${current.id}`),
        api<PatientRecord>(`/patients/${encounter.encounter.patientId}`),
        loadClinicalSummary(encounter.encounter.patientId),
        api<TriageForm>(`/encounters/${encounterId}/triage`).catch(() => null),
        api<{ items: ConsultationSummary[] }>(
          `/patients/${encounter.encounter.patientId}/consultations`,
        ).catch(() => ({ items: [] })),
        api<{ items: ClinicalTemplate[] }>("/clinical-templates").catch(() => ({
          items: [],
        })),
        api<{ items: QuickPhrase[] }>("/me/quick-phrases").catch(() => ({
          items: [],
        })),
      ]);

    setView(full);
    setPatient(record);
    setClinical(summary);
    setVitals(triage);
    setPrevious(history.items);
    setTemplates(templateList.items);
    setPhrases(phraseList.items);
    setDiagnoses(full.diagnoses);
    setSections({
      chiefComplaint: full.consultation.chiefComplaint ?? "",
      hpi: full.consultation.hpi ?? "",
      history: full.consultation.history ?? "",
      examination: full.consultation.examination ?? "",
      planText: full.consultation.planText ?? "",
    });
    setLastSaved(full.consultation.lastAutosaveAt);
  }, [encounterId]);

  useAsyncEffect(() => load(), [load]);

  /**
   * CON-F-12: every few seconds while there is something unsaved.
   *
   * A failure is shown prominently and the text stays in the box, because
   * the worst outcome here is a doctor believing something was saved when
   * it was not.
   */
  const save = useCallback(async () => {
    if (!consultationId || !dirty.current) return;
    dirty.current = false;
    setSaving("saving");
    try {
      const saved = await api<Consultation>(
        `/consultations/${consultationId}`,
        {
          method: "PATCH",
          body: sections,
        },
      );
      setLastSaved(saved.lastAutosaveAt);
      setSaving("saved");
    } catch {
      dirty.current = true;
      setSaving("failed");
    }
  }, [consultationId, sections]);

  useEffect(() => {
    const timer = setInterval(() => void save(), 5000);
    return () => clearInterval(timer);
  }, [save]);

  // And on the way out, so a doctor who closes the tab loses nothing.
  useEffect(() => {
    const onHide = () => {
      if (dirty.current) void save();
    };
    window.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
  }, [save]);

  const edit = (key: ClinicalSection, value: string) => {
    dirty.current = true;
    setSaving("unsaved");
    setSections((current) => ({ ...current, [key]: value }));
  };

  // CON-F-20: the whole workspace without a mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key === "Enter") {
        event.preventDefault();
        setSigning(true);
        return;
      }
      const typing = ["INPUT", "TEXTAREA"].includes(
        (event.target as HTMLElement)?.tagName ?? "",
      );
      if (typing || event.ctrlKey || event.metaKey || event.altKey === false) {
        if (!event.altKey) return;
      }
      if (event.altKey && /^[1-5]$/.test(event.key)) {
        event.preventDefault();
        const section = CLINICAL_SECTIONS[Number(event.key) - 1];
        if (section) document.getElementById(`section-${section.key}`)?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!view || !patient || !chart)
    return <p className="text-sm text-muted">Loading…</p>;
  const { consultation } = view;

  async function saveDiagnoses(next: Diagnosis[]) {
    setBusy(true);
    try {
      const result = await api<{ items: Diagnosis[] }>(
        `/consultations/${consultationId}/diagnoses`,
        {
          method: "PUT",
          body: {
            diagnoses: next.map((d) => ({
              rank: d.rank,
              description: d.description,
              icd10Code: d.icd10Code,
              certainty: d.certainty,
              isChronic: d.isChronic,
            })),
          },
        },
      );
      setDiagnoses(result.items);
      setError(null);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not save the diagnoses.",
      );
    } finally {
      setBusy(false);
    }
  }

  const latestVitals = vitals?.records.at(-1) ?? null;

  return (
    <div>
      <PatientHeader patient={patient} clinical={clinical} compact />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">Consultation</h1>
        <span className="font-mono text-sm">{chart.encounter.queueNo}</span>
        {/* CON-F-23: always visible, because "did that save?" is the
            question a doctor should never have to ask. */}
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            saving === "failed"
              ? "bg-danger-soft text-danger"
              : saving === "saved"
                ? "bg-success-soft text-success"
                : "bg-warning-soft text-warning"
          }`}
        >
          {saving === "failed"
            ? "Not saved — still trying"
            : saving === "saved"
              ? lastSaved
                ? `Saved ${timeAgo(lastSaved)}`
                : "Draft"
              : "Saving…"}
        </span>
        {consultation.copiedFromId && (
          <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs text-primary-ink">
            History copied from an earlier visit
          </span>
        )}
      </div>

      {error && <Alert title="Not done">{error}</Alert>}
      {saving === "failed" && (
        <Alert tone="danger" title="This is not saved">
          The clinic system cannot be reached. Leave this window open: it keeps
          trying, and what you have typed is still here.
        </Alert>
      )}

      <div className="grid gap-5 xl:grid-cols-[18rem_1fr_18rem]">
        {/* ---------------------------------------------- what is known */}
        <div className="flex flex-col gap-4">
          <Card title="Vitals">
            {latestVitals ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                {(
                  [
                    [
                      "BP",
                      latestVitals.systolic &&
                        `${latestVitals.systolic}/${latestVitals.diastolic}`,
                    ],
                    ["Pulse", latestVitals.heartRate],
                    [
                      "Temp",
                      latestVitals.temperature &&
                        `${latestVitals.temperature} °C`,
                    ],
                    ["SpO₂", latestVitals.spo2 && `${latestVitals.spo2}%`],
                    [
                      "Weight",
                      latestVitals.weightKg && `${latestVitals.weightKg} kg`,
                    ],
                    ["BMI", latestVitals.bmi],
                  ] as const
                )
                  .filter(([, value]) => value)
                  .map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted">{label}</dt>
                      <dd>{value}</dd>
                    </div>
                  ))}
                {latestVitals.flags.length > 0 && (
                  <div className="col-span-2 mt-1">
                    {latestVitals.flags.map((flag) => (
                      <p
                        key={flag.param}
                        className={`text-xs ${
                          flag.level === "CRITICAL"
                            ? "text-danger"
                            : "text-warning"
                        }`}
                      >
                        {flag.label} {flag.threshold}
                      </p>
                    ))}
                  </div>
                )}
              </dl>
            ) : (
              <p className="text-sm text-muted">Nothing recorded at triage.</p>
            )}
            <Link
              href={`/encounters/${encounterId}/triage`}
              className="mt-2 inline-block text-sm text-muted underline hover:text-foreground"
            >
              Take vitals
            </Link>
          </Card>

          <Card title="Previous visits">
            {previous.length === 0 ? (
              <p className="text-sm text-muted">First visit on record.</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {previous.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <span className="font-medium">
                      {item.primaryDiagnosis ?? item.chiefComplaint ?? "Seen"}
                    </span>
                    <span className="block text-xs text-muted">
                      {item.signedAt
                        ? new Date(item.signedAt).toLocaleDateString()
                        : ""}
                      {item.planSummary ? ` · ${item.planSummary}` : ""}
                    </span>
                    {consultation.editable && (
                      <button
                        className="text-xs text-muted underline hover:text-foreground"
                        onClick={async () => {
                          setBusy(true);
                          try {
                            await api(
                              `/consultations/${consultationId}/cancel`,
                              {
                                method: "POST",
                                body: {
                                  reason:
                                    "Restarting with history copied forward",
                                },
                              },
                            );
                            await api(
                              `/encounters/${encounterId}/consultations`,
                              {
                                method: "POST",
                                body: { copyFromId: item.id },
                              },
                            );
                            await load();
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        Copy history forward
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        {/* ------------------------------------------------------- the note */}
        <div className="flex flex-col gap-4">
          {consultation.editable && templates.length > 0 && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowTemplates(true)}
              >
                Use a template
              </Button>
            </div>
          )}

          {CLINICAL_SECTIONS.map((section, index) => (
            <Field
              key={section.key}
              label={`${section.label}`}
              hint={`Alt+${index + 1}`}
              htmlFor={`section-${section.key}`}
            >
              <textarea
                id={`section-${section.key}`}
                rows={section.rows}
                disabled={!consultation.editable}
                value={sections[section.key] ?? ""}
                onChange={(event) => edit(section.key, event.target.value)}
                // Quick phrases expand when the doctor leaves the field,
                // rather than mid-word, so nothing detonates while typing.
                onBlur={(event) => {
                  const expanded = expandPhrases(event.target.value, phrases);
                  if (expanded !== event.target.value)
                    edit(section.key, expanded);
                  void save();
                }}
                className="w-full rounded-md border border-line bg-surface px-3 py-2 text-base disabled:bg-surface-muted"
              />
            </Field>
          ))}
        </div>

        {/* ------------------------------------------------ what happens next */}
        <div className="flex flex-col gap-4">
          <Card title="Diagnoses">
            {diagnoses.length === 0 ? (
              <p className="text-sm text-muted">
                None yet. One is needed to sign.
              </p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {diagnoses.map((d) => (
                  <li
                    key={d.id}
                    className="flex items-start justify-between gap-2"
                  >
                    <span>
                      <span className="font-medium">{d.description}</span>
                      <span className="block text-xs text-muted">
                        {d.rank === "PRIMARY" ? "Main" : "Secondary"} ·{" "}
                        {d.certainty === "CONFIRMED"
                          ? "Confirmed"
                          : "Provisional"}
                        {d.isChronic && " · long-term"}
                      </span>
                    </span>
                    {consultation.editable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          void saveDiagnoses(
                            diagnoses.filter((x) => x.id !== d.id),
                          )
                        }
                      >
                        ×
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {consultation.editable && (
              <div className="mt-3 flex items-end gap-2">
                <TextField
                  label="Add a diagnosis"
                  value={newDiagnosis}
                  onChange={(event) => setNewDiagnosis(event.target.value)}
                  onKeyDown={(event) => {
                    if (
                      event.key === "Enter" &&
                      newDiagnosis.trim().length >= 2
                    ) {
                      event.preventDefault();
                      void saveDiagnoses([
                        ...diagnoses,
                        {
                          id: `new-${Date.now()}`,
                          rank:
                            diagnoses.length === 0 ? "PRIMARY" : "SECONDARY",
                          description: newDiagnosis.trim(),
                          icd10Code: null,
                          icd10Label: null,
                          certainty: "PROVISIONAL",
                          isChronic: false,
                        },
                      ]);
                      setNewDiagnosis("");
                    }
                  }}
                />
              </div>
            )}
          </Card>

          <Card title="Follow-up">
            <div className="flex flex-col gap-2">
              <Input
                type="date"
                disabled={!consultation.editable}
                defaultValue={consultation.followUpDue ?? ""}
                onChange={(event) => {
                  dirty.current = true;
                  setSaving("unsaved");
                  void api(`/consultations/${consultationId}`, {
                    method: "PATCH",
                    body: { followUpDue: event.target.value || null },
                  }).then(() => setSaving("saved"));
                }}
              />
            </div>
          </Card>

          {/* PRC-F-05: ordered from the plan, the same way medicines are. */}
          <Card title="Procedures">
            <ProcedurePanel
              encounterId={encounterId}
              consultationId={consultation.id}
              editable={consultation.editable}
            />
          </Card>

          {/* RX-F-01: prescribing happens here, beside the plan, not on a
              separate screen — what is prescribed is part of the plan. */}
          <Card title="Prescription">
            <PrescriptionPanel
              consultationId={consultation.id}
              editable={consultation.editable}
              onChange={setRx}
            />
          </Card>

          {/* DOC-R-01: nothing to issue from until the record is signed. */}
          {!consultation.editable && (
            <Card
              title="Documents"
              description="Printed from this visit and kept on the patient’s record."
            >
              <DocumentsPanel
                scope={{ kind: "encounter", encounterId }}
                consultationId={consultation.id}
                canIssue
              />
            </Card>
          )}

          {consultation.editable ? (
            <div className="flex flex-col gap-2">
              <Button
                loading={busy}
                onClick={async () => {
                  await save();
                  setConfirmed([]);
                  setSigning(true);
                }}
              >
                Sign and finish
              </Button>
              <p className="text-xs text-muted">
                or <kbd className="rounded border border-line px-1">Ctrl</kbd>+
                <kbd className="rounded border border-line px-1">Enter</kbd>
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  const reason = window.prompt(
                    "Why is this draft being abandoned?",
                  );
                  if (!reason) return;
                  await api(`/consultations/${consultationId}/cancel`, {
                    method: "POST",
                    body: { reason },
                  });
                  router.push("/queue");
                }}
              >
                Abandon this draft
              </Button>
            </div>
          ) : (
            <Alert tone="success" title="Signed">
              This record is part of the patient&rsquo;s file and can only be
              amended.
            </Alert>
          )}
        </div>
      </div>

      {/* CON-F-14: a deliberate act, with a summary of what is being signed. */}
      <Modal
        open={signing}
        title="Sign this consultation?"
        onClose={() => setSigning(false)}
      >
        <p className="text-sm text-muted">
          Once signed it becomes part of the patient&rsquo;s permanent record.
          Anything found afterwards is recorded as an amendment, with your name
          and a reason.
        </p>
        <dl className="mt-3 flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-muted">What brought them in</dt>
            <dd>
              {sections.chiefComplaint || (
                <span className="text-danger">Missing</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Diagnoses</dt>
            <dd>
              {diagnoses.length === 0 ? (
                <span className="text-danger">At least one is needed</span>
              ) : (
                diagnoses.map((d) => d.description).join(", ")
              )}
            </dd>
          </div>
        </dl>

        <PrescriptionSignSummary
          prescription={rx?.prescription ?? null}
          items={rx?.items ?? []}
          confirmed={confirmed}
          onConfirmedChange={setConfirmed}
        />

        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={wantsPaperwork}
            onChange={(event) => setWantsPaperwork(event.target.checked)}
          />
          They need a certificate, referral or letter
        </label>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setSigning(false)}>
            Keep writing
          </Button>
          <Button
            loading={busy}
            disabled={
              !sections.chiefComplaint?.trim() || diagnoses.length === 0
            }
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const signed = await api<Consultation>(
                  `/consultations/${consultationId}/sign`,
                  {
                    method: "POST",
                    body: { confirm: confirmed },
                  },
                );
                if (wantsPaperwork) {
                  // Stay here: the record is signed, the visit has moved
                  // on, and the Documents card below can now issue.
                  setSigning(false);
                  await load();
                  return;
                }
                router.push(
                  `/queue?signed=${encodeURIComponent(
                    STATUS_LABEL[
                      (signed.routedTo ??
                        "PAYMENT_WAITING") as keyof typeof STATUS_LABEL
                    ] ?? "",
                  )}`,
                );
              } catch (caught) {
                setError(
                  caught instanceof ApiError
                    ? caught.message
                    : "Could not sign.",
                );
                setSigning(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign and route
          </Button>
        </div>
      </Modal>

      <Modal
        open={showTemplates}
        title="Use a template"
        onClose={() => setShowTemplates(false)}
      >
        <p className="text-sm text-muted">
          Fills in the sections you have left empty. Anything you have already
          written is kept.
        </p>
        {templates.length === 0 ? (
          <EmptyState title="No templates yet" />
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {templates.map((template) => (
              <li key={template.id}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(
                        `/consultations/${consultationId}/apply-template/${template.id}`,
                        { method: "POST" },
                      );
                      await load();
                      setShowTemplates(false);
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {template.name}
                  {template.scope === "TENANT" && (
                    <span className="ml-2 text-xs text-muted">clinic</span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}
