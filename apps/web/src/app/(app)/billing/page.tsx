'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  LINE_TYPE_LABEL,
  api,
  invoiceTone,
  type BillableItemRow,
  type QueueRow,
  type InvoiceLine,
  type InvoiceSummary,
  type InvoiceView,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { PaymentPanel } from '@/components/payment-panel';
import { Alert, Button, Card, EmptyState, Field, Input, Modal, Select } from '@/components/ui';

/**
 * The cashier's counter (BIL §11).
 *
 * Two screens: who is waiting to pay, and the bill you open by pressing
 * one of them. The totals are large and on the right because that is
 * the number the cashier reads aloud, and the number the patient looks
 * for.
 *
 * Automatic lines are visibly locked. A cashier who could edit the
 * price of a dispensed medicine could make the invoice disagree with
 * the stock ledger, and then neither can be trusted.
 */
export default function BillingPage() {
  const { me, can } = useSession();
  const branchId = me?.activeBranchId ?? null;

  const [waiting, setWaiting] = useState<QueueRow[]>([]);
  const [recent, setRecent] = useState<InvoiceSummary[]>([]);
  const [open, setOpen] = useState<InvoiceView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!branchId) return;
    const [queue, invoices] = await Promise.all([
      api<{ items: QueueRow[] }>(`/branches/${branchId}/queues/cashier`),
      api<{ items: InvoiceSummary[] }>(`/branches/${branchId}/invoices`),
    ]);
    setWaiting(queue.items);
    setRecent(invoices.items.slice(0, 15));
  }, [branchId]);

  useAsyncEffect(refresh, [refresh]);

  async function openFor(encounterId: string) {
    setError(null);
    try {
      setOpen(await api<InvoiceView>(`/encounters/${encounterId}/invoice`, { method: 'POST' }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open the bill.');
    }
  }

  async function openInvoice(id: string) {
    setError(null);
    setOpen(await api<InvoiceView>(`/invoices/${id}`));
  }

  if (open?.invoice) {
    return (
      <InvoiceScreen
        view={open}
        onReload={async () => setOpen(await api<InvoiceView>(`/invoices/${open.invoice!.id}`))}
        onClose={async () => {
          setOpen(null);
          await refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Billing</h1>
          <p className="text-sm text-muted">
            {waiting.length === 0
              ? 'Nobody is waiting to pay.'
              : `${waiting.length} ${waiting.length === 1 ? 'patient' : 'patients'} waiting.`}
          </p>
        </div>
        {can('invoice.issue') && <NewSaleButton branchId={branchId} onOpened={setOpen} />}
      </header>

      {error && <Alert tone="danger">{error}</Alert>}

      {waiting.length === 0 ? (
        <EmptyState title="Nobody waiting">
          Patients appear here when they reach the payment counter.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {waiting.map((row) => (
            <li key={row.id}>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-3">
                <div>
                  <p className="font-medium">
                    {row.queueNo && <span className="mr-2 font-mono text-muted">{row.queueNo}</span>}
                    {row.patient?.name ?? 'Patient'}
                  </p>
                  <p className="text-xs text-muted">
                    {[row.patient?.age, row.patient?.gender].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <Button onClick={() => void openFor(row.id)}>Open the bill</Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Card title="Recent invoices">
        {recent.length === 0 ? (
          <p className="text-sm text-muted">None yet today.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {recent.map((row) => (
              <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <button
                    type="button"
                    className="font-medium text-primary underline"
                    onClick={() => void openInvoice(row.id)}
                  >
                    {row.invoiceNo ?? 'Draft'}
                  </button>
                  <span className="block text-xs text-muted">
                    {row.patient?.name ?? row.walkupName ?? '—'}
                  </span>
                </span>
                <span className="text-right">
                  <span className="font-medium">RM {row.grandTotal}</span>
                  <span
                    className={
                      invoiceTone(row.status) === 'danger'
                        ? 'block text-xs text-danger'
                        : invoiceTone(row.status) === 'success'
                          ? 'block text-xs text-success'
                          : 'block text-xs text-muted'
                    }
                  >
                    {row.status.toLowerCase()}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function NewSaleButton({
  branchId,
  onOpened,
}: {
  branchId: string | null;
  onOpened: (view: InvoiceView) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <>
      <Button variant="secondary" onClick={() => setAsking(true)}>
        Counter sale
      </Button>
      <Modal open={asking} title="Sell something at the counter" onClose={() => setAsking(false)}>
        <p className="text-sm text-muted">
          For somebody with no visit — a box of plasters, a thermometer. A name is enough.
        </p>
        <div className="mt-3">
          <Field label="Who is buying">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAsking(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={name.trim().length < 2 || !branchId}
            onClick={async () => {
              setBusy(true);
              try {
                onOpened(
                  await api<InvoiceView>(`/branches/${branchId}/invoices/standalone`, {
                    method: 'POST',
                    body: { walkupName: name.trim() },
                  }),
                );
                setAsking(false);
                setName('');
              } finally {
                setBusy(false);
              }
            }}
          >
            Start
          </Button>
        </div>
      </Modal>
    </>
  );
}

function InvoiceScreen({
  view,
  onReload,
  onClose,
}: {
  view: InvoiceView;
  onReload: () => Promise<void>;
  onClose: () => Promise<void>;
}) {
  const { can } = useSession();
  const invoice = view.invoice!;
  const draft = invoice.status === 'DRAFT';

  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [discounting, setDiscounting] = useState(false);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await onReload();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">
            {invoice.invoiceNo ?? 'Draft invoice'}
          </h1>
          <p className="text-sm text-muted">
            {invoice.patientNameSnapshot ?? invoice.walkupName ?? '—'}
            {invoice.encounterId && (
              <>
                {' · '}
                <Link href={`/encounters/${invoice.encounterId}`} className="text-primary underline">
                  the visit
                </Link>
              </>
            )}
          </p>
        </div>
        <Button variant="secondary" onClick={() => void onClose()}>
          Back
        </Button>
      </header>

      {error && <Alert tone="danger">{error}</Alert>}
      {invoice.status === 'VOID' && (
        <Alert tone="danger" title="Void">
          {invoice.voidReason}
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <Card title="Lines">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr>
                <th className="py-1 font-medium">What</th>
                <th className="py-1 text-right font-medium">Qty</th>
                <th className="py-1 text-right font-medium">Price</th>
                <th className="py-1 text-right font-medium">Discount</th>
                <th className="py-1 text-right font-medium">Total</th>
                <th className="py-1" />
              </tr>
            </thead>
            <tbody>
              {view.lines.map((line) => (
                <LineRow
                  key={line.id}
                  invoiceId={invoice.id}
                  line={line}
                  editable={draft}
                  busy={busy}
                  onAct={act}
                />
              ))}
              {view.lines.length === 0 && (
                <tr>
                  <td colSpan={6} className="py-3 text-muted">
                    Nothing on this bill yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {draft && can('invoice.issue') && (
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
                Add an item
              </Button>
              {can('invoice.discount') && (
                <Button variant="secondary" size="sm" onClick={() => setDiscounting(true)}>
                  Discount the bill
                </Button>
              )}
            </div>
          )}
        </Card>

        {/* Big and right-aligned: this is the number read aloud. */}
        <Card title="Total">
          <dl className="flex flex-col gap-1 text-sm">
            <Row label="Subtotal" value={invoice.subtotal} />
            {invoice.discountTotal !== '0.00' && (
              <Row label="Discount" value={`−${invoice.discountTotal}`} tone="success" />
            )}
            {invoice.taxTotal !== '0.00' && <Row label="Tax" value={invoice.taxTotal} />}
            {invoice.roundingAdjustment !== '0.00' && (
              <Row label="Rounding" value={invoice.roundingAdjustment} />
            )}
          </dl>
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex items-baseline justify-between">
              <span className="text-sm text-muted">To pay</span>
              <span className="text-2xl font-semibold tabular-nums">RM {invoice.grandTotal}</span>
            </div>
            {invoice.amountPaid !== '0.00' && (
              <div className="mt-1 flex items-baseline justify-between text-sm">
                <span className="text-muted">Balance</span>
                <span className="font-medium tabular-nums">RM {invoice.balance}</span>
              </div>
            )}
          </div>

          {invoice.invoiceDiscountReason && (
            <p className="mt-2 text-xs text-muted">
              Discount: {invoice.invoiceDiscountReason}
            </p>
          )}

          <div className="mt-4 flex flex-col gap-2">
            {draft && can('invoice.issue') && (
              <Button
                loading={busy}
                disabled={view.lines.length === 0}
                onClick={() =>
                  void act(() =>
                    api(`/invoices/${invoice.id}/issue`, {
                      method: 'POST',
                      body: { idempotencyKey: `issue-${invoice.id}` },
                    }),
                  )
                }
              >
                Issue the invoice
              </Button>
            )}
            {invoice.status === 'ISSUED' && can('invoice.void') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  const why = window.prompt('Why is this being voided?');
                  if (!why || why.trim().length < 10) return;
                  void act(() =>
                    api(`/invoices/${invoice.id}/void`, {
                      method: 'POST',
                      body: { reason: why.trim() },
                    }),
                  );
                }}
              >
                Void
              </Button>
            )}
            {invoice.status === 'VOID' && !invoice.reissuedAsId && can('invoice.issue') && (
              <Button
                variant="secondary"
                onClick={() => void act(() => api(`/invoices/${invoice.id}/reissue`, { method: 'POST' }))}
              >
                Reissue
              </Button>
            )}
          </div>

          {/* PAY-F-07: the payment panel appears the moment there is a
              bill to pay, and stays until the balance is nothing. */}
          {(invoice.status === 'ISSUED' || invoice.status === 'PARTIAL') &&
            can('payment.take') && (
              <div className="mt-4 border-t border-line pt-4">
                <PaymentPanel
                  invoiceId={invoice.id}
                  branchId={invoice.branchId}
                  onPaid={() => void onReload()}
                />
              </div>
            )}
        </Card>
      </div>

      {adding && (
        <AddLineModal
          invoiceId={invoice.id}
          onClose={() => setAdding(false)}
          onDone={async () => {
            setAdding(false);
            await onReload();
          }}
        />
      )}

      {discounting && (
        <DiscountModal
          invoiceId={invoice.id}
          onClose={() => setDiscounting(false)}
          onDone={async () => {
            setDiscounting(false);
            await onReload();
          }}
        />
      )}
    </div>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'success' }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className={tone === 'success' ? 'tabular-nums text-success' : 'tabular-nums'}>{value}</dd>
    </div>
  );
}

function LineRow({
  invoiceId,
  line,
  editable,
  busy,
  onAct,
}: {
  invoiceId: string;
  line: InvoiceLine;
  editable: boolean;
  busy: boolean;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <tr className="border-t border-line align-top">
      <td className="py-2">
        {line.description}
        <span className="block text-xs text-muted">
          {LINE_TYPE_LABEL[line.lineType]}
          {line.isAuto && ' · from what was done'}
          {line.discountReason && ` · ${line.discountReason}`}
        </span>
      </td>
      <td className="py-2 text-right tabular-nums">
        {line.quantity}
        {line.quantityUnit ? ` ${line.quantityUnit}` : ''}
      </td>
      <td className="py-2 text-right tabular-nums">{line.unitPrice}</td>
      <td className="py-2 text-right tabular-nums">
        {line.discountAmount === '0.00' ? '—' : `−${line.discountAmount}`}
      </td>
      <td className="py-2 text-right font-medium tabular-nums">{line.lineTotal}</td>
      <td className="py-2 text-right">
        {editable && !line.isAuto && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() =>
              void onAct(() =>
                api(`/invoices/${invoiceId}/lines/${line.id}`, { method: 'DELETE' }),
              )
            }
          >
            ×
          </Button>
        )}
      </td>
    </tr>
  );
}

function AddLineModal({
  invoiceId,
  onClose,
  onDone,
}: {
  invoiceId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [items, setItems] = useState<BillableItemRow[]>([]);
  const [chosen, setChosen] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useAsyncEffect(async () => {
    setItems((await api<{ items: BillableItemRow[] }>('/billable-items')).items);
  }, []);

  return (
    <Modal open title="Add an item" onClose={onClose}>
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-col gap-2">
        <Field label="From the list">
          <Select
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
              const item = items.find((i) => i.id === event.target.value);
              if (item) {
                setDescription(item.name);
                setPrice(item.defaultPrice);
              }
            }}
          >
            <option value="">Type it out instead</option>
            {items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name} — RM {item.defaultPrice}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="What">
          <Input value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="How many">
            <Input
              type="number"
              min="0"
              step="1"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
          </Field>
          <Field label="Price each (RM)">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={price}
              onChange={(event) => setPrice(event.target.value)}
            />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          disabled={description.trim().length < 2 || !(Number(quantity) > 0) || price === ''}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(`/invoices/${invoiceId}/lines`, {
                method: 'POST',
                body: {
                  ...(chosen ? { billableItemId: chosen } : {}),
                  description: description.trim(),
                  quantity: Number(quantity),
                  unitPrice: Number(price),
                },
              });
              await onDone();
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not add it.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Add
        </Button>
      </div>
    </Modal>
  );
}

/**
 * BIL-F-09. Above the cap the server refuses and says so; the dialogue
 * relays that rather than hiding the control, because "why can't I?" is
 * a worse question than "who can approve this?".
 */
function DiscountModal({
  invoiceId,
  onClose,
  onDone,
}: {
  invoiceId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [pct, setPct] = useState('');
  const [source, setSource] = useState('GOODWILL');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);

  return (
    <Modal open title="Discount the bill" onClose={onClose}>
      {error && <Alert tone={needsApproval ? 'warning' : 'danger'}>{error}</Alert>}
      <div className="flex flex-col gap-2">
        <Field label="How much off (%)">
          <Input
            type="number"
            min="0"
            max="100"
            step="0.01"
            value={pct}
            onChange={(event) => setPct(event.target.value)}
          />
        </Field>
        <Field label="Why">
          <Select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="GOODWILL">Goodwill</option>
            <option value="SENIOR">Senior citizen</option>
            <option value="STAFF">Staff</option>
            <option value="MANUAL">Other</option>
          </Select>
        </Field>
        <Field label="Note" hint="Required once the discount is worth explaining">
          <Input value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          disabled={!(Number(pct) > 0)}
          onClick={async () => {
            setBusy(true);
            setError(null);
            setNeedsApproval(false);
            try {
              await api(`/invoices/${invoiceId}/discount`, {
                method: 'PUT',
                body: { pct: Number(pct), source, reason: reason.trim() || undefined },
              });
              await onDone();
            } catch (caught) {
              const problem = caught instanceof ApiError ? caught : null;
              setNeedsApproval(
                Boolean((problem?.problem?.errors as { elevationRequired?: boolean } | undefined)?.elevationRequired),
              );
              setError(problem?.message ?? 'Could not apply it.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Apply
        </Button>
      </div>
    </Modal>
  );
}
