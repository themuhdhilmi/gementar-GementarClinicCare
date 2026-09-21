"use client";

import { useMemo, useState } from "react";
import {
  ApiError,
  api,
  type PrescriptionItem,
  type PrescriptionView,
} from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import { Alert, Button, Card, Field, Input, Modal } from "./ui";

/**
 * What was prescribed, on the signed record (RX §11).
 *
 * Superseded versions are shown under the current one rather than hidden,
 * because the question somebody asks two years later is "what did they
 * actually get?", and the answer is often "the first version, before it
 * was corrected".
 */
export function SignedPrescription({
  consultationId,
  canAmend,
}: {
  consultationId: string;
  canAmend: boolean;
}) {
  const [view, setView] = useState<PrescriptionView | null>(null);
  const [amending, setAmending] = useState<PrescriptionItem | null>(null);
  const [reason, setReason] = useState("");
  const [dose, setDose] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useMemo(
    () => async () => {
      setView(
        await api<PrescriptionView>(
          `/consultations/${consultationId}/prescription`,
        ),
      );
    },
    [consultationId],
  );

  useAsyncEffect(load, [load]);

  if (!view?.prescription) return null;

  const current = view.items.filter((item) => item.isCurrent);
  /** Earlier versions, keyed by the version that replaced them. */
  const previousOf = new Map<string, PrescriptionItem>();
  for (const item of view.items) {
    if (item.supersedesId) {
      const older = view.items.find(
        (candidate) => candidate.id === item.supersedesId,
      );
      if (older) previousOf.set(item.id, older);
    }
  }

  return (
    <Card title="Prescription" description={statusLine(view)}>
      {error && <Alert tone="danger">{error}</Alert>}

      <ul className="flex flex-col gap-3 text-sm">
        {current.map((item) => {
          const older = previousOf.get(item.id);
          return (
            <li key={item.id}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">
                    {item.displayName}
                    {item.isControlled && (
                      <span className="ml-2 text-xs font-medium text-danger">
                        Controlled
                      </span>
                    )}
                    {item.version > 1 && (
                      <span className="ml-2 text-xs text-muted">
                        version {item.version}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-muted">
                    {item.doseValue} {item.doseUnit} · {item.route} ·{" "}
                    {item.frequencyCode} · {item.quantity} {item.quantityUnit} ·{" "}
                    {statusWord(item)}
                  </p>
                  <p className="mt-0.5 text-xs italic text-muted">
                    {item.labelText}
                  </p>
                  {item.overrideReason && (
                    <p className="mt-0.5 text-xs text-warning">
                      Prescribed over a warning: &ldquo;{item.overrideReason}
                      &rdquo;
                    </p>
                  )}
                  {item.cancelledReason && (
                    <p className="mt-0.5 text-xs text-muted">
                      {item.cancelledReason}
                    </p>
                  )}
                  {older && (
                    <p className="mt-0.5 text-xs text-muted line-through">
                      was {older.doseValue} {older.doseUnit} ·{" "}
                      {older.frequencyCode} · {older.quantity}{" "}
                      {older.quantityUnit}
                    </p>
                  )}
                </div>
                {canAmend &&
                  item.status !== "CANCELLED" &&
                  item.status !== "SUPERSEDED" && (
                    <div className="flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setAmending(item);
                          setDose(String(item.doseValue));
                          setReason("");
                        }}
                      >
                        Amend
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={async () => {
                          const why = window.prompt(
                            "Why is this being cancelled?",
                          );
                          if (!why || why.trim().length < 5) return;
                          setError(null);
                          try {
                            await api(`/prescription-items/${item.id}/cancel`, {
                              method: "POST",
                              body: { reason: why.trim() },
                            });
                            await load();
                          } catch (caught) {
                            setError(
                              caught instanceof ApiError
                                ? caught.message
                                : "Could not cancel it.",
                            );
                          }
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
              </div>
            </li>
          );
        })}
      </ul>

      {view.prescription.notesToDispenser && (
        <p className="mt-3 text-xs text-muted">
          For the pharmacy: {view.prescription.notesToDispenser}
        </p>
      )}

      <Modal
        open={amending !== null}
        title={`Change the dose of ${amending?.displayName ?? ""}`}
        onClose={() => setAmending(null)}
      >
        <p className="text-sm text-muted">
          The original stays exactly as it was. This creates a new version of
          the item, and the pharmacy sees that it changed.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <Field label={`Dose (${amending?.doseUnit ?? ""})`}>
            <Input
              type="number"
              step="0.25"
              value={dose}
              onChange={(event) => setDose(event.target.value)}
            />
          </Field>
          <Field label="Why">
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAmending(null)}>
            Keep it as it is
          </Button>
          <Button
            loading={busy}
            disabled={reason.trim().length < 5 || !(Number(dose) > 0)}
            onClick={async () => {
              if (!amending) return;
              setBusy(true);
              setError(null);
              try {
                await api(`/prescription-items/${amending.id}/amend`, {
                  method: "POST",
                  body: {
                    reason: reason.trim(),
                    item: {
                      productId: amending.productId ?? undefined,
                      externalName: amending.externalName ?? undefined,
                      doseValue: Number(dose),
                      doseUnit: amending.doseUnit,
                      route: amending.route,
                      frequencyCode: amending.frequencyCode,
                      frequencyPerDay: amending.frequencyPerDay ?? undefined,
                      isPrn: amending.isPrn,
                      prnIndication: amending.prnIndication ?? undefined,
                      durationDays: amending.durationDays ?? undefined,
                      untilFinished: amending.untilFinished,
                      instructions: amending.instructions ?? undefined,
                    },
                  },
                });
                setAmending(null);
                await load();
              } catch (caught) {
                setError(
                  caught instanceof ApiError
                    ? caught.message
                    : "Could not amend it.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            Record the change
          </Button>
        </div>
      </Modal>
    </Card>
  );
}

function statusLine(view: PrescriptionView): string {
  const { prescription } = view;
  if (!prescription) return "";
  switch (prescription.status) {
    case "DRAFT":
      return "Not yet prescribed";
    case "ACTIVE":
      return "With the pharmacy";
    case "COMPLETED":
      return "Finished";
    case "CANCELLED":
      return "Cancelled";
  }
}

function statusWord(item: PrescriptionItem): string {
  switch (item.status) {
    case "DRAFT":
      return "not yet prescribed";
    case "ACTIVE":
      return "waiting at the pharmacy";
    case "PARTIAL":
      return "part dispensed";
    case "DISPENSED":
      return "dispensed";
    case "DECLINED":
      return "declined by the patient";
    case "CANCELLED":
      return "cancelled";
    case "SUPERSEDED":
      return "replaced";
  }
}
