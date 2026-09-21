'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import {
  ApiError,
  api,
  idempotencyKey,
  type DispenseLabel,
  type DispenseSession,
  type DispenseSessionItem,
  type PharmacyQueueRow,
  type Product,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { Alert, Button, EmptyState, Field, Input, Modal } from '@/components/ui';

/**
 * The pharmacy counter (DSP §11).
 *
 * Two screens in one: a queue of people waiting, and the session you
 * open by pressing one of them. The session is deliberately dense —
 * every item, its batch, what is on the shelf and what it costs, all
 * visible without scrolling on a counter monitor, because the dispenser
 * is standing up with a patient in front of them.
 */
export default function PharmacyPage() {
  const { me } = useSession();
  const branchId = me?.activeBranchId ?? null;

  const [rows, setRows] = useState<PharmacyQueueRow[]>([]);
  const [session, setSession] = useState<DispenseSession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!branchId) return;
    const next = await api<{ items: PharmacyQueueRow[] }>(
      `/branches/${branchId}/pharmacy/queue`,
    );
    setRows(next.items);
  }, [branchId]);

  useAsyncEffect(refresh, [refresh]);

  async function openFor(encounterId: string) {
    setError(null);
    try {
      setSession(await api<DispenseSession>(`/encounters/${encounterId}/dispense`, { method: 'POST' }));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not open it.');
    }
  }

  if (session) {
    return (
      <DispenseSessionView
        session={session}
        onReload={async () => setSession(await api<DispenseSession>(`/dispenses/${session.id}`))}
        onClose={async () => {
          setSession(null);
          await refresh();
        }}
      />
    );
  }

  const waiting = rows.reduce((sum, row) => sum + row.items, 0);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Pharmacy</h1>
          <p className="text-sm text-muted">
            {rows.length === 0
              ? 'Nobody is waiting.'
              : `${rows.length} ${rows.length === 1 ? 'patient' : 'patients'}, ${waiting} ${waiting === 1 ? 'item' : 'items'}.`}
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => void refresh()}>
          Refresh
        </Button>
      </header>

      {error && <Alert tone="danger">{error}</Alert>}

      {rows.length === 0 ? (
        <EmptyState title="Nothing waiting">
          Prescriptions appear here when a doctor signs the note.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li key={row.encounterId}>
              <div className="flex items-center justify-between gap-4 rounded-lg border border-line bg-surface px-4 py-3">
                <div className="min-w-0">
                  <p className="font-medium">
                    {row.queueNo && <span className="mr-2 font-mono text-muted">{row.queueNo}</span>}
                    {row.patient?.name ?? 'Patient'}
                  </p>
                  <p className="text-xs text-muted">
                    {row.patient?.mrn} · {row.items} {row.items === 1 ? 'item' : 'items'} ·
                    waiting {row.waitingMinutes} min
                  </p>
                  <div className="mt-1 flex gap-2 text-xs">
                    {row.hasControlled && (
                      <span className="rounded-full bg-danger-soft px-2 py-0.5 font-medium text-danger">
                        Controlled
                      </span>
                    )}
                    {row.amended && (
                      <span className="rounded-full bg-warning-soft px-2 py-0.5 font-medium text-warning">
                        Changed by the doctor
                      </span>
                    )}
                    {row.status === 'DISPENSING' && (
                      <span className="rounded-full bg-primary-soft px-2 py-0.5 font-medium text-primary-ink">
                        In progress
                      </span>
                    )}
                  </div>
                </div>
                <Button onClick={() => void openFor(row.encounterId)}>Open</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DispenseSessionView({
  session,
  onReload,
  onClose,
}: {
  session: DispenseSession;
  onReload: () => Promise<void>;
  onClose: () => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState<DispenseLabel | null>(null);

  const outstanding = session.items.filter(
    (item) => item.status === 'ACTIVE' || item.status === 'PARTIAL',
  );
  const severe = session.allergies.filter(
    (a) => a.severity === 'SEVERE' || a.severity === 'LIFE_THREATENING',
  );

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
          <h1 className="text-xl font-semibold">{session.patient?.name}</h1>
          <p className="text-sm text-muted">
            {session.patient?.mrn} ·{' '}
            <Link href={`/encounters/${session.encounterId}`} className="text-primary underline">
              the visit
            </Link>
          </p>
        </div>
        <Button variant="secondary" onClick={() => void onClose()}>
          Back to the queue
        </Button>
      </header>

      {error && <Alert tone="danger">{error}</Alert>}

      {/* The allergies come from the patient's own record, not from a
          note somebody typed on the prescription. */}
      {severe.length > 0 && (
        <Alert tone="danger" title="Allergies">
          {severe
            .map((a) => `${a.substance} (${a.severity?.toLowerCase().replace('_', ' ')})`)
            .join(', ')}
        </Alert>
      )}
      {severe.length === 0 && session.allergies.length > 0 && (
        <Alert tone="warning" title="Allergies">
          {session.allergies.map((a) => a.substance).join(', ')}
        </Alert>
      )}

      {session.notesToDispenser && (
        <Alert tone="info" title="From the doctor">
          {session.notesToDispenser}
        </Alert>
      )}

      <ul className="flex flex-col gap-3">
        {session.items.map((item) => (
          <ItemCard
            key={item.prescriptionItemId}
            session={session}
            item={item}
            busy={busy}
            onAct={act}
            onLabel={setLabel}
          />
        ))}
      </ul>

      <div className="flex justify-end gap-2">
        {outstanding.length === 0 ? (
          <Button
            loading={busy}
            onClick={() =>
              void act(async () => {
                await api(`/dispenses/${session.id}/complete`, {
                  method: 'POST',
                  body: { counselled: true },
                });
                await onClose();
              })
            }
          >
            Finish
          </Button>
        ) : (
          <p className="self-center text-sm text-muted">
            {outstanding.length} {outstanding.length === 1 ? 'item' : 'items'} still to deal with.
          </p>
        )}
      </div>

      <Modal open={label !== null} title="Label" onClose={() => setLabel(null)}>
        {label && (
          <div className="rounded-md border border-line p-3 text-sm">
            <p className="font-semibold">{label.clinic}</p>
            <p className="text-xs text-muted">
              {label.branch}
              {label.phone ? ` · ${label.phone}` : ''}
            </p>
            <hr className="my-2 border-line" />
            <p className="font-medium">{label.patientName}</p>
            <p className="text-xs text-muted">
              {label.patientMrn} · {new Date(label.dispensedAt).toLocaleDateString()}
            </p>
            <p className="mt-2 font-medium">
              {label.product} {label.strength}
            </p>
            <p>
              {label.quantity} {label.quantityUnit}
            </p>
            <p className="mt-1">{label.instructions}</p>
            <p className="mt-2 text-xs text-muted">
              {label.batches.map((b) => `Lot ${b.batchNo}${b.expiry ? ` exp ${b.expiry.slice(0, 7)}` : ''}`).join(' · ')}
            </p>
            <ul className="mt-2 text-xs">
              {label.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Print {label.printCount}</p>
          </div>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={() => setLabel(null)}>
            Close
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function ItemCard({
  session,
  item,
  busy,
  onAct,
  onLabel,
}: {
  session: DispenseSession;
  item: DispenseSessionItem;
  busy: boolean;
  onAct: (run: () => Promise<unknown>) => Promise<void>;
  onLabel: (label: DispenseLabel) => void;
}) {
  const [quantity, setQuantity] = useState(String(item.prescribedQuantity));
  const [reason, setReason] = useState('');
  const [substituting, setSubstituting] = useState(false);

  const done = item.dispensed;
  const settled = item.status !== 'ACTIVE' && item.status !== 'PARTIAL';
  const partial = Number(quantity) < item.prescribedQuantity;

  return (
    <li className="rounded-lg border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">
            {item.displayName}
            {item.isControlled && (
              <span className="ml-2 align-middle text-xs font-medium text-danger">Controlled</span>
            )}
            {item.amendedSinceOpen && (
              <span className="ml-2 align-middle text-xs font-medium text-warning">Changed</span>
            )}
            {item.newSinceOpen && (
              <span className="ml-2 align-middle text-xs font-medium text-warning">New</span>
            )}
          </p>
          <p className="text-xs text-muted">
            {item.prescribedQuantity} {item.quantityUnit} prescribed
            {item.unitPrice && ` · RM ${item.unitPrice} each`}
          </p>
          <p className="mt-1 text-xs italic text-muted">{item.labelText}</p>
        </div>
        {done && (
          <span className="shrink-0 rounded-full bg-success-soft px-2 py-0.5 text-xs font-medium text-success">
            {done.outcome === 'PARTIAL' ? 'Part given' : 'Given'}
          </span>
        )}
      </div>

      {item.isExternal && (
        <Alert tone="info">
          Written for the patient to have filled elsewhere. Nothing here to hand over.
        </Alert>
      )}

      {!done && !settled && !item.isExternal && (
        <>
          {item.suggestion.length > 0 ? (
            <div className="mt-3 rounded-md bg-surface-muted p-2 text-sm">
              <p className="text-xs font-medium text-muted">Take from</p>
              <ul className="mt-1">
                {item.suggestion.map((pick) => (
                  <li key={pick.batchId} className="flex justify-between">
                    <span>
                      Lot {pick.batchNo}
                      {pick.expiryDate && (
                        <span className="text-muted"> · exp {pick.expiryDate.slice(0, 7)}</span>
                      )}
                    </span>
                    <span>
                      {pick.quantity} {item.quantityUnit}
                      <span className="text-muted"> of {pick.available}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <Alert tone="warning">
              Nothing usable on the shelf. Substitute it, or mark it for the patient to obtain
              elsewhere.
            </Alert>
          )}

          {item.shortfall > 0 && item.suggestion.length > 0 && (
            <Alert tone="warning">
              Short by {item.shortfall} {item.quantityUnit}.
            </Alert>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="w-28">
              <Field label="How many">
                <Input
                  type="number"
                  min="0"
                  step="0.5"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                />
              </Field>
            </div>
            {partial && (
              <div className="min-w-56 flex-1">
                <Field label="Why less">
                  <Input value={reason} onChange={(event) => setReason(event.target.value)} />
                </Field>
              </div>
            )}
            <Button
              loading={busy}
              disabled={item.suggestion.length === 0 || (partial && reason.trim().length === 0)}
              onClick={() =>
                void onAct(() =>
                  api(
                    `/dispenses/${session.id}/items/${item.prescriptionItemId}/dispense`,
                    {
                      method: 'POST',
                      body: {
                        quantity: Number(quantity),
                        ...(partial ? { reason: reason.trim() } : {}),
                        // Armed here, so a double click replays rather
                        // than hands over twice.
                        idempotencyKey: idempotencyKey(),
                      },
                    },
                  ),
                )
              }
            >
              Hand over
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setSubstituting(true)}>
              Substitute
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const why = window.prompt('Why is the patient not taking this?');
                if (!why || why.trim().length < 3) return;
                void onAct(() =>
                  api(`/dispenses/${session.id}/items/${item.prescriptionItemId}/dispense`, {
                    method: 'POST',
                    body: { outcome: 'DECLINED', reason: why.trim() },
                  }),
                );
              }}
            >
              Not taken
            </Button>
          </div>
        </>
      )}

      {done && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">
            {done.quantity} {item.quantityUnit} · RM {done.lineTotal}
            {done.packRounded && ' · rounded to a whole pack'}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void onAct(async () => {
                onLabel(
                  await api<DispenseLabel>(`/dispense-items/${done.id}/label`, { method: 'POST' }),
                );
              })
            }
          >
            {done.labelPrints > 0 ? 'Print again' : 'Print the label'}
          </Button>
          {done.canUndo && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                const why = window.prompt('What went wrong?');
                if (!why || why.trim().length < 3) return;
                void onAct(() =>
                  api(`/dispense-items/${done.id}/undo`, {
                    method: 'POST',
                    body: { reason: why.trim() },
                  }),
                );
              }}
            >
              Undo
            </Button>
          )}
          {done.outcomeReason && (
            <span className="w-full text-xs text-muted">{done.outcomeReason}</span>
          )}
        </div>
      )}

      {settled && !done && (
        <p className="mt-2 text-sm text-muted">{item.status.toLowerCase()}</p>
      )}

      {substituting && (
        <SubstituteModal
          session={session}
          item={item}
          onClose={() => setSubstituting(false)}
          onDone={async () => {
            setSubstituting(false);
            await onAct(async () => undefined);
          }}
        />
      )}
    </li>
  );
}

/** DSP-F-07. Same generic first, because that is the usual answer. */
function SubstituteModal({
  session,
  item,
  onClose,
  onDone,
}: {
  session: DispenseSession;
  item: DispenseSessionItem;
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [query, setQuery] = useState(item.genericName);
  const [hits, setHits] = useState<Product[]>([]);
  const [chosen, setChosen] = useState<Product | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useAsyncEffect(
    async () => {
      const text = query.trim();
      if (text.length < 2) return;
      const found = await api<{ items: Product[] }>(
        `/products?type=MEDICINE&q=${encodeURIComponent(text)}`,
      );
      setHits(found.items.filter((product) => product.id !== item.productId));
    },
    [query, item.productId],
    { debounceMs: 150 },
  );

  return (
    <Modal open title={`Instead of ${item.displayName}`} onClose={onClose}>
      {error && <Alert tone="danger">{error}</Alert>}
      <p className="text-sm text-muted">
        Another brand of {item.genericName} is routine. A different medicine is a prescribing
        decision, and will be refused unless you are allowed to make it.
      </p>

      <div className="mt-3">
        <Field label="Find a product">
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setChosen(null);
            }}
          />
        </Field>
      </div>

      {!chosen && hits.length > 0 && (
        <ul className="mt-1 max-h-48 overflow-y-auto rounded-md border border-line">
          {hits.slice(0, 10).map((product) => (
            <li key={product.id}>
              <button
                type="button"
                className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-muted"
                onClick={() => setChosen(product)}
              >
                <span>
                  {product.label}
                  <span className="block text-xs text-muted">{product.genericName}</span>
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {product.onHand ?? '—'} on hand
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen && (
        <div className="mt-2 rounded-md border border-primary/40 bg-primary-soft/30 p-2 text-sm">
          <p className="font-medium">{chosen.label}</p>
          <p className="text-xs text-muted">
            {chosen.genericName === item.genericName
              ? 'Same generic — another brand.'
              : 'A different medicine.'}
          </p>
        </div>
      )}

      <div className="mt-3">
        <Field label="Why">
          <Input value={reason} onChange={(event) => setReason(event.target.value)} />
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          disabled={!chosen || reason.trim().length < 3}
          onClick={async () => {
            if (!chosen) return;
            setBusy(true);
            setError(null);
            try {
              await api(
                `/dispenses/${session.id}/items/${item.prescriptionItemId}/substitute`,
                { method: 'POST', body: { productId: chosen.id, reason: reason.trim() } },
              );
              await onDone();
            } catch (caught) {
              setError(caught instanceof ApiError ? caught.message : 'Could not substitute.');
            } finally {
              setBusy(false);
            }
          }}
        >
          Use this instead
        </Button>
      </div>
    </Modal>
  );
}
