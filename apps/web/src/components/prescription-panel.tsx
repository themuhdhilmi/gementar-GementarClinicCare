'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ApiError,
  api,
  needsOverride,
  needsSignConfirmation,
  warningTone,
  type Prescription,
  type PrescriptionItem,
  type PrescriptionItemInput,
  type PrescriptionView,
  type Product,
  type RxFavourite,
  type RxOptions,
  type RxWarning,
  expiryTone,
} from '@/lib/api';
import { useAsyncEffect } from '@/lib/use-async';
import { Alert, Button, Field, Input, Select } from './ui';

/**
 * The prescribing panel, inside the consultation workspace (RX §11).
 *
 * The shape of the interaction is: type three letters, press Enter, and
 * the line is there with the product's own defaults filled in. Everything
 * after that is correcting a number rather than filling in a form, because
 * a doctor with four minutes per patient will not fill in a form.
 *
 * Warnings appear under the line they belong to, not in a banner at the
 * top. A warning that is not next to the thing it is about is a warning
 * that gets read as decoration.
 */

type Props = {
  consultationId: string;
  editable: boolean;
  onChange?: (view: PrescriptionView) => void;
};

const BLANK: PrescriptionItemInput = {
  doseValue: 1,
  doseUnit: 'tab',
  route: 'PO',
  frequencyCode: 'TDS',
  durationDays: 5,
};

/** RX-Q-05 is open; these are the phrases the pilot clinic uses today. */
const INSTRUCTION_CHIPS = [
  'selepas makan',
  'sebelum makan',
  'habiskan ubat ini',
  'boleh menyebabkan mengantuk',
  'banyakkan minum air',
];

export function PrescriptionPanel({ consultationId, editable, onChange }: Props) {
  const [view, setView] = useState<PrescriptionView | null>(null);
  const [options, setOptions] = useState<RxOptions | null>(null);
  const [favourites, setFavourites] = useState<RxFavourite[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Product[]>([]);
  /** Null until a search has run; false when stock is not tracked at all. */
  const [stockKnown, setStockKnown] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<(PrescriptionItemInput & { label: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const searchBox = useRef<HTMLInputElement>(null);

  const refresh = useMemo(
    () => async () => {
      const next = await api<PrescriptionView>(`/consultations/${consultationId}/prescription`);
      setView(next);
      onChange?.(next);
    },
    [consultationId, onChange],
  );

  useAsyncEffect(async () => {
    await Promise.all([
      refresh(),
      api<RxOptions>('/prescriptions/options').then(setOptions),
      api<{ items: RxFavourite[] }>('/me/rx-favourites').then((r) => setFavourites(r.items)),
    ]);
  }, [refresh]);

  // Type-ahead over the catalogue. Debounced, because a doctor types
  // faster than a round trip and every keystroke would otherwise queue
  // its own query. Too short a query clears the list where it is typed,
  // not here, so this effect only ever fetches.
  useAsyncEffect(
    async () => {
      const text = query.trim();
      if (text.length < 2) return;
      const found = await api<{ items: Product[]; stockKnown: boolean }>(
        `/products?type=MEDICINE&q=${encodeURIComponent(text)}`,
      );
      setHits(found.items);
      setStockKnown(found.stockKnown);
    },
    [query],
    { debounceMs: 150 },
  );

  function startFrom(product: Product) {
    setQuery('');
    setHits([]);
    setDraft({
      label: product.label,
      productId: product.id,
      doseValue: product.defaultDose ?? product.strengthValue ?? 1,
      doseUnit: product.defaultDoseUnit ?? product.strengthUnit ?? product.dispenseUnit,
      route: product.defaultRoute ?? 'PO',
      frequencyCode: product.defaultFrequency ?? 'TDS',
      durationDays: 5,
    });
  }

  async function add(input: PrescriptionItemInput) {
    setBusy(true);
    setError(null);
    try {
      await api(`/consultations/${consultationId}/prescription/items`, {
        method: 'POST',
        body: input,
      });
      setDraft(null);
      await refresh();
      searchBox.current?.focus();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not add that.');
    } finally {
      setBusy(false);
    }
  }

  const items = (view?.items ?? []).filter((item) => item.isCurrent);
  const unknownAllergies = view?.patient.allergiesUnknown ?? false;

  return (
    <div className="flex flex-col gap-3">
      {/* RX-F-14. At the top, because it is about the patient rather than
          about any one drug, and because it is the cheapest thing to fix. */}
      {unknownAllergies && (
        <Alert tone="warning" title="Allergies not recorded">
          Nobody has asked this patient about allergies. Record them, or record &ldquo;no known
          drug allergies&rdquo;, in the patient&rsquo;s file.
        </Alert>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      {items.length === 0 && !draft && (
        <p className="text-sm text-muted">Nothing prescribed yet.</p>
      )}

      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <ItemRow
            key={item.id}
            item={item}
            editable={editable && item.status === 'DRAFT'}
            options={options}
            onChanged={refresh}
          />
        ))}
      </ul>

      {!editable ? null : draft ? (
        <ItemEditor
          title={draft.label}
          value={draft}
          options={options}
          busy={busy}
          onCancel={() => setDraft(null)}
          onSave={(input) => void add(input)}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Field label="Add a medicine">
            <Input
              ref={searchBox}
              value={query}
              placeholder="amox, panadol, 500…"
              onChange={(event) => {
                setQuery(event.target.value);
                if (event.target.value.trim().length < 2) setHits([]);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && hits[0]) {
                  event.preventDefault();
                  startFrom(hits[0]);
                }
                if (event.key === 'Escape') {
                  setQuery('');
                  setHits([]);
                }
              }}
            />
          </Field>

          {hits.length > 0 && (
            <ul className="rounded-md border border-line">
              {hits.slice(0, 8).map((product) => (
                <li key={product.id}>
                  <button
                    type="button"
                    className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-muted"
                    onClick={() => startFrom(product)}
                  >
                    <span>
                      <span className="font-medium">{product.label}</span>
                      {product.genericName && (
                        <span className="block text-xs text-muted">{product.genericName}</span>
                      )}
                    </span>
                    <span className="shrink-0 text-right text-xs">
                      {product.isControlled && (
                        <span className="block font-medium text-danger">Controlled</span>
                      )}
                      {/* RX-F-04. "Not known" and "none" are different
                          answers, and a prescriber told "0 on hand" who
                          then finds a full box learns not to believe the
                          number. */}
                      {stockKnown === false ? (
                        <span className="block text-muted">stock not known</span>
                      ) : product.onHand === 0 ? (
                        <span className="block font-medium text-warning">none in stock</span>
                      ) : (
                        <span className="block text-muted">
                          {product.onHand} {product.dispenseUnit} on hand
                        </span>
                      )}
                      {product.nearestExpiry && (
                        <span
                          className={
                            expiryTone(product.nearestExpiry) === 'warning'
                              ? 'block text-warning'
                              : 'block text-muted'
                          }
                        >
                          exp {product.nearestExpiry.slice(0, 7)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-1.5">
            {/* RX-F-10: what this doctor prescribes most, one click away. */}
            {favourites.slice(0, 6).map((favourite) => (
              <button
                key={favourite.id}
                type="button"
                className="rounded-full border border-line px-2.5 py-1 text-xs hover:bg-surface-muted"
                onClick={() =>
                  setDraft({
                    label: [favourite.product.name, favourite.product.strengthText]
                      .filter(Boolean)
                      .join(' '),
                    productId: favourite.productId,
                    ...BLANK,
                    ...(favourite.defaults ?? {}),
                  })
                }
              >
                {favourite.product.name}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await api(`/consultations/${consultationId}/prescription/repeat-last`, {
                    method: 'POST',
                  });
                  await refresh();
                } catch (caught) {
                  setError(
                    caught instanceof ApiError ? caught.message : 'Could not repeat the last one.',
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              Repeat last prescription
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDraft({ label: 'Written by hand', ...BLANK, externalName: '' })}
            >
              Write one by hand
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function ItemRow({
  item,
  editable,
  options,
  onChanged,
}: {
  item: PrescriptionItem;
  editable: boolean;
  options: RxOptions | null;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  if (editing) {
    return (
      <li>
        <ItemEditor
          title={item.displayName}
          value={{
            productId: item.productId ?? undefined,
            externalName: item.externalName ?? undefined,
            doseValue: item.doseValue,
            doseUnit: item.doseUnit,
            route: item.route,
            frequencyCode: item.frequencyCode,
            frequencyPerDay: item.frequencyPerDay ?? undefined,
            isPrn: item.isPrn,
            prnIndication: item.prnIndication ?? undefined,
            durationDays: item.durationDays ?? undefined,
            untilFinished: item.untilFinished,
            quantity: item.quantityAuto ? undefined : item.quantity,
            instructions: item.instructions ?? undefined,
          }}
          options={options}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (input) => {
            setBusy(true);
            await api(`/prescription-items/${item.id}`, { method: 'PUT', body: input });
            await onChanged();
            setBusy(false);
            setEditing(false);
          }}
        />
      </li>
    );
  }

  return (
    <li className="rounded-md border border-line px-3 py-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">
            {item.displayName}
            {item.isControlled && (
              <span className="ml-2 align-middle text-xs font-medium text-danger">Controlled</span>
            )}
            {item.version > 1 && (
              <span className="ml-2 align-middle text-xs text-muted">v{item.version}</span>
            )}
          </p>
          <p className="text-xs text-muted">
            {item.doseValue} {item.doseUnit} · {item.route} · {item.frequencyCode}
            {item.untilFinished ? ' · until finished' : ` · ${item.durationDays} d`} ·{' '}
            {item.quantity} {item.quantityUnit}
            {item.quantityAuto && <span className="ml-1 text-primary">auto</span>}
          </p>
          <p className="mt-1 text-xs italic text-muted">{item.labelText}</p>
        </div>
        {editable && (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await api(`/prescription-items/${item.id}`, { method: 'DELETE' });
                await onChanged();
              }}
            >
              ×
            </Button>
          </div>
        )}
      </div>

      {item.warnings.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {item.warnings.map((warning, index) => (
            <li key={index}>
              <Alert tone={warningTone(warning)}>{warning.message}</Alert>
            </li>
          ))}
        </ul>
      )}

      {needsOverride(item) &&
        (item.overrideReason ? (
          <p className="mt-2 text-xs text-muted">
            Prescribed anyway: &ldquo;{item.overrideReason}&rdquo;
          </p>
        ) : (
          editable && <OverrideForm item={item} onDone={onChanged} />
        ))}

      {item.cancelledReason && (
        <p className="mt-2 text-xs text-muted">
          {item.status === 'DECLINED' ? 'Declined' : 'Cancelled'}: {item.cancelledReason}
        </p>
      )}
    </li>
  );
}

/** RX-F-15. Five characters is not much to ask for a decision like this. */
function OverrideForm({ item, onDone }: { item: PrescriptionItem; onDone: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [refute, setRefute] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const allergy = item.warnings.find(
    (w): w is Extract<RxWarning, { type: 'ALLERGY' }> => w.type === 'ALLERGY',
  );

  return (
    <div className="mt-2 flex flex-col gap-2 rounded-md bg-surface-muted p-2">
      <div className="flex flex-wrap gap-1.5">
        {['Tolerated previously', 'Benefit outweighs risk'].map((preset) => (
          <button
            key={preset}
            type="button"
            className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs"
            onClick={() => setReason(preset)}
          >
            {preset}
          </button>
        ))}
        {allergy && allergy.level !== 'UNLINKED' && (
          <button
            type="button"
            className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs"
            onClick={() => {
              setReason(`The allergy record for ${allergy.substance} is wrong`);
              setRefute(allergy.allergyId);
            }}
          >
            The allergy record is wrong
          </button>
        )}
      </div>
      <Input
        value={reason}
        placeholder="Why prescribe this anyway?"
        onChange={(event) => setReason(event.target.value)}
      />
      <Button
        size="sm"
        loading={busy}
        disabled={reason.trim().length < 5}
        onClick={async () => {
          setBusy(true);
          await api(`/prescription-items/${item.id}/override`, {
            method: 'POST',
            body: { reason: reason.trim(), ...(refute ? { refuteAllergyId: refute } : {}) },
          });
          await onDone();
          setBusy(false);
        }}
      >
        Prescribe anyway
      </Button>
    </div>
  );
}

function ItemEditor({
  title,
  value,
  options,
  busy,
  onCancel,
  onSave,
}: {
  title: string;
  value: PrescriptionItemInput;
  options: RxOptions | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: PrescriptionItemInput) => void | Promise<void>;
}) {
  const [form, setForm] = useState<PrescriptionItemInput>(value);

  function set<K extends keyof PrescriptionItemInput>(key: K, next: PrescriptionItemInput[K]) {
    setForm((current) => ({ ...current, [key]: next }));
  }

  const isExternal = form.productId === undefined;

  return (
    <div className="flex flex-col gap-2 rounded-md border border-primary/40 bg-primary-soft/30 p-3">
      <p className="text-sm font-medium">{title}</p>

      {isExternal && (
        <Field label="Name it for the pharmacy">
          <Input
            value={form.externalName ?? ''}
            onChange={(event) => set('externalName', event.target.value)}
          />
        </Field>
      )}

      <div className="grid grid-cols-2 gap-2">
        <Field label="Dose">
          <Input
            type="number"
            step="0.25"
            min="0"
            value={form.doseValue}
            onChange={(event) => set('doseValue', Number(event.target.value))}
          />
        </Field>
        <Field label="Unit">
          <Select value={form.doseUnit} onChange={(event) => set('doseUnit', event.target.value)}>
            {(options?.doseUnits ?? [form.doseUnit]).map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Route">
          <Select value={form.route} onChange={(event) => set('route', event.target.value)}>
            {(options?.routes ?? [form.route]).map((route) => (
              <option key={route} value={route}>
                {route}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="How often">
          <Select
            value={form.frequencyCode}
            onChange={(event) => {
              const code = event.target.value;
              set('frequencyCode', code);
              // PRN has no rate, so it cannot have a calculated quantity
              // and it must say what it is for.
              if (code === 'PRN') set('isPrn', true);
            }}
          >
            {(options?.frequencies ?? [{ code: form.frequencyCode, ms: '', en: '', perDay: null }]).map(
              (frequency) => (
                <option key={frequency.code} value={frequency.code}>
                  {frequency.code}
                  {frequency.en ? ` — ${frequency.en}` : ''}
                </option>
              ),
            )}
            <option value="CUSTOM">CUSTOM</option>
          </Select>
        </Field>

        {form.frequencyCode === 'CUSTOM' && (
          <Field label="Times a day">
            <Input
              type="number"
              min="1"
              value={form.frequencyPerDay ?? ''}
              onChange={(event) => set('frequencyPerDay', Number(event.target.value))}
            />
          </Field>
        )}

        {!form.untilFinished && (
          <Field label="For how many days">
            <Input
              type="number"
              min="1"
              max="365"
              value={form.durationDays ?? ''}
              onChange={(event) => set('durationDays', Number(event.target.value))}
            />
          </Field>
        )}

        <Field label="Quantity">
          <Input
            type="number"
            step="0.5"
            min="0"
            placeholder="worked out"
            value={form.quantity ?? ''}
            onChange={(event) =>
              set('quantity', event.target.value === '' ? undefined : Number(event.target.value))
            }
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.untilFinished ?? false}
          onChange={(event) => {
            set('untilFinished', event.target.checked);
            if (event.target.checked) set('durationDays', undefined);
          }}
        />
        Until finished
      </label>

      {(form.isPrn || form.frequencyCode === 'PRN') && (
        <Field label="When required for">
          <Input
            value={form.prnIndication ?? ''}
            placeholder="demam, sakit kepala…"
            onChange={(event) => set('prnIndication', event.target.value)}
          />
        </Field>
      )}

      <Field label="Instructions on the label">
        <Input
          value={form.instructions ?? ''}
          onChange={(event) => set('instructions', event.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-1.5">
        {INSTRUCTION_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="rounded-full border border-line bg-surface px-2.5 py-1 text-xs"
            onClick={() =>
              set('instructions', form.instructions ? `${form.instructions}, ${chip}` : chip)
            }
          >
            {chip}
          </button>
        ))}
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="sm"
          loading={busy}
          onClick={() => {
            const clean: PrescriptionItemInput = { ...form };
            if (clean.externalName === '') delete clean.externalName;
            if (!clean.isPrn) delete clean.prnIndication;
            void onSave(clean);
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * The list the doctor reads before signing (RX §11, RX-R-04).
 *
 * The confirmation tick is per item and deliberately unticked each time
 * the modal opens. A box that remembers being ticked is a box nobody
 * reads.
 */
export function PrescriptionSignSummary({
  prescription,
  items,
  confirmed,
  onConfirmedChange,
}: {
  prescription: Prescription | null;
  items: PrescriptionItem[];
  confirmed: string[];
  onConfirmedChange: (next: string[]) => void;
}) {
  const current = items.filter((item) => item.isCurrent && item.status === 'DRAFT');
  if (!prescription || current.length === 0) return null;

  return (
    <div className="mt-3">
      <p className="text-muted text-sm">Prescription</p>
      <ul className="mt-1 flex flex-col gap-1.5 text-sm">
        {current.map((item) => {
          const blocked = needsOverride(item) && !item.overrideReason;
          const mustConfirm = needsSignConfirmation(item);
          return (
            <li key={item.id}>
              <div className="flex items-baseline justify-between gap-2">
                <span>{item.displayName}</span>
                <span className="text-xs text-muted">
                  {item.quantity} {item.quantityUnit}
                </span>
              </div>
              {blocked && (
                <p className="text-xs text-danger">
                  Needs a reason before this can be signed.
                </p>
              )}
              {mustConfirm && !blocked && (
                <label className="mt-1 flex items-start gap-2 text-xs text-danger">
                  <input
                    type="checkbox"
                    checked={confirmed.includes(item.id)}
                    onChange={(event) =>
                      onConfirmedChange(
                        event.target.checked
                          ? [...confirmed, item.id]
                          : confirmed.filter((id) => id !== item.id),
                      )
                    }
                  />
                  I confirm this patient has a severe allergy to this substance and I am
                  prescribing it anyway.
                </label>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
