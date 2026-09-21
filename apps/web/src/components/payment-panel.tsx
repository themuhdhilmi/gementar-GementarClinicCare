"use client";

import { useCallback, useState } from "react";
import {
  ApiError,
  METHOD_LABEL,
  api,
  senToRinggit,
  type MethodConfig,
  type PaymentMethod,
  type PaymentPreview,
  type PaymentRow,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import { Alert, Button, Card, Field, Input } from "@/components/ui";

/** A key per attempt, so a double-click or a retry cannot pay twice. */
function newKey(): string {
  return `pay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Taking the money (PAY §11).
 *
 * The whole screen is built around one number — what is left to pay —
 * and one decision: how. Everything else follows from those two, and
 * the rounding line appears by itself when cash makes it appear.
 *
 * The preview is fetched from the server rather than computed here.
 * Rounding is a rule with a table and a specification, and having the
 * browser's arithmetic disagree with the receipt's by a sen would be
 * the single most damaging bug this screen could have.
 */
export function PaymentPanel({
  invoiceId,
  branchId,
  onPaid,
}: {
  invoiceId: string;
  branchId: string;
  onPaid: () => void;
}) {
  const { can } = useSession();
  const [methods, setMethods] = useState<MethodConfig[]>([]);
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [preview, setPreview] = useState<PaymentPreview | null>(null);
  const [payments, setPayments] = useState<PaymentRow[]>([]);
  const [tendered, setTendered] = useState("");
  const [partial, setPartial] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [config, taken, drawer] = await Promise.all([
      api<{ items: MethodConfig[] }>(`/branches/${branchId}/payment-methods`),
      api<{ items: PaymentRow[] }>(`/invoices/${invoiceId}/payments`),
      api<{ session: unknown }>(`/branches/${branchId}/cash-sessions/current`),
    ]);
    setMethods(config.items.filter((row) => row.enabled));
    setPayments(taken.items);
    setDrawerOpen(drawer.session !== null);
  }, [branchId, invoiceId]);

  useAsyncEffect(() => load(), [load]);

  // The preview follows the method and the amount, so the cashier sees
  // the rounding before the patient hands anything over.
  useAsyncEffect(async () => {
    try {
      setPreview(
        await api<PaymentPreview>(`/invoices/${invoiceId}/payment-preview`, {
          query: { method, amount: partial || undefined },
        }),
      );
    } catch {
      setPreview(null);
    }
  }, [invoiceId, method, partial]);

  const config = methods.find((row) => row.method === method);
  const needsReference = config?.requiresReference ?? false;

  async function take() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const payment = await api<PaymentRow>(`/invoices/${invoiceId}/payments`, {
        method: "POST",
        body: {
          method,
          amount: partial ? Number(partial) : undefined,
          tendered:
            method === "CASH" && tendered ? Number(tendered) : undefined,
          reference: reference.trim() || undefined,
          idempotencyKey: newKey(),
        },
      });
      setTendered("");
      setPartial("");
      setReference("");
      await load();
      onPaid();
      // The receipt is made here rather than being waited for: a
      // printer that is out of paper must not undo a payment
      // (PAY-N-02).
      void openReceipt(payment.id);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "That payment was not taken.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (drawerOpen === false) {
    return (
      <Alert tone="warning" title="No drawer is open">
        Money cannot be taken until somebody opens the drawer with its float.{" "}
        {can("eod.close")
          ? "Open it from the Drawer screen."
          : "Ask the cashier to open it."}
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <Alert>{error}</Alert>}

      {payments.length > 0 && (
        <ul className="flex flex-col divide-y divide-line text-sm">
          {payments.map((row) => (
            <li
              key={row.id}
              className="flex items-center justify-between py-1.5"
            >
              <span
                className={
                  row.status === "VOIDED" ? "text-muted line-through" : ""
                }
              >
                {METHOD_LABEL[row.method]} · {row.receiptNo}
              </span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">RM {row.amount}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void openReceipt(row.id)}
                >
                  Receipt
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {preview && Number(preview.outstandingSen) > 0 && (
        <>
          <div className="flex flex-wrap gap-2">
            {methods.map((row) => (
              <Button
                key={row.method}
                size="sm"
                variant={row.method === method ? "primary" : "secondary"}
                onClick={() => setMethod(row.method)}
              >
                {row.displayName ?? METHOD_LABEL[row.method]}
              </Button>
            ))}
          </div>

          <Card>
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted">
                {preview.settles ? "To pay" : "This payment"}
              </span>
              <span className="text-3xl font-semibold tabular-nums">
                {senToRinggit(preview.dueSen)}
              </span>
            </div>
            {preview.roundingSen !== "0" && (
              <p className="mt-1 text-sm text-muted">
                Rounded {Number(preview.roundingSen) > 0 ? "up" : "down"} by{" "}
                {senToRinggit(preview.roundingSen.replace("-", ""))} — five-sen
                coins.
              </p>
            )}
            {!preview.settles && (
              <p className="mt-1 text-sm text-warning">
                {senToRinggit(preview.balanceAfterSen)} will still be owed.
              </p>
            )}
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Part payment"
              hint="Leave empty to settle the whole balance."
            >
              <Input
                type="number"
                step="0.01"
                placeholder={senToRinggit(preview.outstandingSen).replace(
                  "RM ",
                  "",
                )}
                value={partial}
                onChange={(event) => setPartial(event.target.value)}
              />
            </Field>
            {method === "CASH" ? (
              <Field label="Tendered">
                <Input
                  type="number"
                  step="0.01"
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                />
              </Field>
            ) : (
              <Field
                label="Reference"
                hint={
                  needsReference ? "Required for this method." : "Optional."
                }
              >
                <Input
                  value={reference}
                  placeholder="approval code, last 4, transaction id"
                  onChange={(event) => setReference(event.target.value)}
                />
              </Field>
            )}
          </div>

          {method === "CASH" && (
            <div className="flex flex-wrap gap-2">
              {preview.tenderSuggestions.map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant="secondary"
                  onClick={() => setTendered((Number(value) / 100).toFixed(2))}
                >
                  {senToRinggit(value)}
                </Button>
              ))}
            </div>
          )}

          {method === "CASH" && tendered && (
            <p className="text-sm">
              Change:{" "}
              <span className="font-semibold tabular-nums">
                {senToRinggit(
                  String(
                    Math.round(Number(tendered) * 100) - Number(preview.dueSen),
                  ),
                )}
              </span>
            </p>
          )}

          {config?.qrPayload && method === "DUITNOW_QR" && (
            <Alert tone="info">
              Show the DuitNow QR to the patient and enter the reference.
            </Alert>
          )}

          <Button
            loading={busy}
            disabled={
              (method === "CASH" &&
                tendered !== "" &&
                Math.round(Number(tendered) * 100) < Number(preview.dueSen)) ||
              (needsReference && !reference.trim())
            }
            onClick={() => void take()}
          >
            Take {senToRinggit(preview.dueSen)}
          </Button>
        </>
      )}

      {preview && Number(preview.outstandingSen) <= 0 && (
        <Alert tone="success" title="Settled">
          Nothing is outstanding on this bill.
        </Alert>
      )}
    </div>
  );
}

/**
 * The receipt, in a window the browser prints.
 *
 * Opened rather than awaited: PAY-N-02 says a printer failure must not
 * roll back the payment, and the payment is already committed by the
 * time this runs.
 */
async function openReceipt(paymentId: string): Promise<void> {
  const receipt = await api<{ document: { id: string } }>(
    `/payments/${paymentId}/receipt`,
  );
  const target = window.open(
    `/api/v1/documents/${receipt.document.id}/file`,
    "_blank",
    "noopener,width=420,height=800",
  );
  await api(`/payments/${paymentId}/receipt/reprint`, { method: "POST" });
  target?.addEventListener("load", () => target.print(), { once: true });
}
