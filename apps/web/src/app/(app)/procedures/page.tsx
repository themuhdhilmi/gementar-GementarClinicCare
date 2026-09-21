"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  ApiError,
  PROCEDURE_CATEGORY_LABEL,
  api,
  siteRequired,
  type EncounterProcedure,
  type Laterality,
  type ProcedureQueueRow,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  TextField,
  timeAgo,
} from "@/components/ui";

/**
 * The nurse's board (PRC-F-12, PRC §11).
 *
 * One row per patient, with what is waiting listed under it, because a
 * nurse calls a person rather than a procedure. Opening one gives the
 * perform form with the consumables already filled in from the mapping —
 * the whole point of the module is that nobody has to remember the mask.
 */
export default function ProceduresPage() {
  const { me } = useSession();
  const branchId = me?.activeBranchId ?? null;

  const [rows, setRows] = useState<ProcedureQueueRow[]>([]);
  const [open, setOpen] = useState<EncounterProcedure | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!branchId) return;
    const next = await api<{ items: ProcedureQueueRow[] }>(
      `/branches/${branchId}/procedures/queue`,
    );
    setRows(next.items);
  }, [branchId]);

  useAsyncEffect(refresh, [refresh]);

  async function openOne(encounterId: string, id: string) {
    setError(null);
    const all = await api<{ items: EncounterProcedure[] }>(
      `/encounters/${encounterId}/procedures`,
    );
    const found = all.items.find((item) => item.id === id);
    if (found) setOpen(found);
  }

  const waiting = rows.reduce((sum, row) => sum + row.items.length, 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Procedures"
        description="Everything a doctor has ordered and nobody has done yet. Recording one takes the consumables off the shelf at the same time."
        meta={
          <span className="text-muted">
            {waiting === 0
              ? "Nobody is waiting."
              : `${waiting} ${waiting === 1 ? "procedure" : "procedures"} for ${rows.length} ${rows.length === 1 ? "patient" : "patients"}.`}
          </span>
        }
        actions={
          <Button variant="secondary" onClick={() => void refresh()}>
            Refresh
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {open ? (
        <PerformForm
          item={open}
          onCancel={() => setOpen(null)}
          onDone={async () => {
            setOpen(null);
            await refresh();
          }}
          onError={setError}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing waiting">
          Procedures ordered by a doctor appear here when the note is signed.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.encounterId}>
              <Card
                title={row.patient?.name ?? "Patient"}
                description={`${row.queueNo ?? ""} ${row.patient?.mrn ?? ""}`.trim()}
                actions={
                  <Link
                    href={`/encounters/${row.encounterId}`}
                    className="text-sm text-muted underline underline-offset-2 hover:text-foreground"
                  >
                    The visit
                  </Link>
                }
              >
                <ul className="flex flex-col divide-y divide-line">
                  {row.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                    >
                      <span className="min-w-0 text-sm">
                        <span className="font-medium">{item.name}</span>
                        <span className="mt-0.5 block text-xs text-muted">
                          {PROCEDURE_CATEGORY_LABEL[item.category]} · ordered{" "}
                          {timeAgo(item.orderedAt)}
                        </span>
                        {(item.requiresConsent || item.requiresDoctor) && (
                          <span className="mt-1 flex gap-1.5">
                            {item.requiresConsent && (
                              <Chip tone="warning">Consent needed</Chip>
                            )}
                            {item.requiresDoctor && (
                              <Chip tone="info">Doctor only</Chip>
                            )}
                          </span>
                        )}
                      </span>
                      <Button
                        size="sm"
                        onClick={() => void openOne(row.encounterId, item.id)}
                      >
                        Do it
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * PRC-F-07, PRC-N-02: thirty seconds for a standard nebuliser.
 *
 * Everything is prefilled and everything is editable. The consumables
 * come from the mapping with what is on the shelf beside them, so a
 * shortfall is visible before the nurse commits rather than after.
 */
function PerformForm({
  item,
  onCancel,
  onDone,
  onError,
}: {
  item: EncounterProcedure;
  onCancel: () => void;
  onDone: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [quantities, setQuantities] = useState<Record<string, number>>(
    Object.fromEntries(
      item.planned
        .filter((line) => !line.optional)
        .map((line) => [line.productId, line.quantity]),
    ),
  );
  const [site, setSite] = useState("");
  const [laterality, setLaterality] = useState<Laterality>("NA");
  const [consentGiven, setConsentGiven] = useState(false);
  const [consentBy, setConsentBy] = useState("");
  const [notes, setNotes] = useState("");
  const [complications, setComplications] = useState("");
  const [doseNumber, setDoseNumber] = useState("");
  const [allowShortfall, setAllowShortfall] = useState(false);
  const [busy, setBusy] = useState(false);

  const short = useMemo(
    () =>
      item.planned.filter(
        (line) => (quantities[line.productId] ?? 0) > line.onHand,
      ),
    [item.planned, quantities],
  );

  const needsSite = siteRequired(item.category);
  const blocked =
    (item.requiresConsent && !consentGiven) ||
    (needsSite && site.trim().length === 0) ||
    (short.length > 0 && !allowShortfall);

  return (
    <Card
      title={item.name}
      description={`${PROCEDURE_CATEGORY_LABEL[item.category]} · RM ${item.price}`}
    >
      {item.protocol && (
        <Alert tone="info" title="Protocol">
          {item.protocol}
        </Alert>
      )}

      <div className="mt-3 flex flex-col gap-4">
        <section>
          <h3 className="text-sm font-semibold">What is used</h3>
          {item.planned.length === 0 ? (
            <p className="mt-1 text-sm text-muted">
              Nothing is deducted for this one.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-2">
              {item.planned.map((line) => {
                const value = quantities[line.productId] ?? 0;
                const tooMany = value > line.onHand;
                return (
                  <li
                    key={line.productId}
                    className="flex items-center justify-between gap-3"
                  >
                    <span className="text-sm">
                      {line.product?.name ?? "Item"}
                      <span className="block text-xs text-muted">
                        {line.onHand} {line.product?.dispenseUnit ?? ""} on the
                        shelf
                        {line.optional && " · optional"}
                        {line.product?.isColdChain && " · cold chain"}
                      </span>
                    </span>
                    <input
                      type="number"
                      min="0"
                      step="0.5"
                      value={value}
                      aria-label={`Quantity of ${line.product?.name ?? "item"}`}
                      className={
                        tooMany
                          ? "w-24 rounded-md border border-danger bg-surface px-2 py-1 text-right text-sm"
                          : "w-24 rounded-md border border-line bg-surface px-2 py-1 text-right text-sm"
                      }
                      onChange={(event) =>
                        setQuantities((current) => ({
                          ...current,
                          [line.productId]: Number(event.target.value),
                        }))
                      }
                    />
                  </li>
                );
              })}
            </ul>
          )}

          {short.length > 0 && (
            <div className="mt-2">
              <Alert tone="warning" title="Not enough on the shelf">
                {short
                  .map(
                    (line) =>
                      `${line.product?.name ?? "item"} (${line.onHand} left)`,
                  )
                  .join(", ")}
                . If it was used from stock nobody had entered, say so and post
                an adjustment afterwards.
              </Alert>
              <label className="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowShortfall}
                  onChange={(event) => setAllowShortfall(event.target.checked)}
                />
                Record it anyway
              </label>
            </div>
          )}
        </section>

        {needsSite && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Where">
              <Input
                value={site}
                placeholder="Left deltoid"
                onChange={(event) => setSite(event.target.value)}
              />
            </Field>
            <Field label="Side">
              <Select
                value={laterality}
                onChange={(event) =>
                  setLaterality(event.target.value as Laterality)
                }
              >
                <option value="NA">Not applicable</option>
                <option value="LEFT">Left</option>
                <option value="RIGHT">Right</option>
                <option value="BILATERAL">Both</option>
              </Select>
            </Field>
          </div>
        )}

        {item.category === "VACCINATION" && (
          <Field label="Which dose (optional)">
            <Input
              type="number"
              min="1"
              value={doseNumber}
              onChange={(event) => setDoseNumber(event.target.value)}
            />
          </Field>
        )}

        {item.requiresConsent && (
          <div className="rounded-md border border-line bg-surface-muted p-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={consentGiven}
                onChange={(event) => setConsentGiven(event.target.checked)}
              />
              The procedure was explained and the patient agreed to it.
            </label>
            <div className="mt-2">
              <Field label="Who consented">
                <Input
                  value={consentBy}
                  placeholder="The patient, or the parent’s name"
                  onChange={(event) => setConsentBy(event.target.value)}
                />
              </Field>
            </div>
          </div>
        )}

        <TextField
          label="Notes"
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <TextField
          label="Anything go wrong?"
          value={complications}
          placeholder="Leave empty if not"
          onChange={(event) => setComplications(event.target.value)}
        />
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Back
        </Button>
        <Button
          loading={busy}
          disabled={blocked}
          onClick={async () => {
            setBusy(true);
            onError(null);
            try {
              await api(`/encounter-procedures/${item.id}/perform`, {
                method: "POST",
                body: {
                  consumables: Object.entries(quantities)
                    .filter(([, quantity]) => quantity > 0)
                    .map(([productId, quantity]) => ({ productId, quantity })),
                  ...(needsSite ? { site: site.trim(), laterality } : {}),
                  ...(item.requiresConsent
                    ? { consentGiven, consentBy: consentBy.trim() || undefined }
                    : {}),
                  ...(notes.trim() ? { notes: notes.trim() } : {}),
                  ...(complications.trim()
                    ? { complications: complications.trim() }
                    : {}),
                  ...(doseNumber ? { doseNumber: Number(doseNumber) } : {}),
                  ...(allowShortfall ? { allowShortfall: true } : {}),
                },
              });
              await onDone();
            } catch (caught) {
              onError(
                caught instanceof ApiError
                  ? caught.message
                  : "Could not record it.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          Done
        </Button>
      </div>
    </Card>
  );
}
