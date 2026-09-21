"use client";

import { useMemo, useState } from "react";
import {
  ApiError,
  PROCEDURE_CATEGORY_LABEL,
  api,
  type EncounterProcedure,
  type ProcedureCatalogItem,
  type ProcedureCategory,
} from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import { Alert, Button, Field, Input } from "./ui";

/**
 * Ordering procedures from the plan (PRC-F-05, PRC §11).
 *
 * Search, category chips, price on every row. A doctor ordering a
 * nebuliser wants two keystrokes, not a form; what the nurse then needs
 * to record is the nurse's screen, not this one.
 */
export function ProcedurePanel({
  encounterId,
  consultationId,
  editable,
  onChange,
}: {
  encounterId: string;
  consultationId?: string;
  editable: boolean;
  onChange?: (items: EncounterProcedure[]) => void;
}) {
  const [items, setItems] = useState<EncounterProcedure[]>([]);
  const [catalogue, setCatalogue] = useState<ProcedureCatalogItem[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<ProcedureCategory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useMemo(
    () => async () => {
      const next = await api<{ items: EncounterProcedure[] }>(
        `/encounters/${encounterId}/procedures`,
      );
      setItems(next.items);
      onChange?.(next.items);
    },
    [encounterId, onChange],
  );

  useAsyncEffect(async () => {
    await Promise.all([
      refresh(),
      api<{ items: ProcedureCatalogItem[] }>("/procedure-catalog").then((r) =>
        setCatalogue(r.items),
      ),
    ]);
  }, [refresh]);

  const text = query.trim().toLowerCase();
  const matches = catalogue
    .filter((row) => (category ? row.category === category : true))
    .filter((row) => (text ? row.name.toLowerCase().includes(text) : true))
    .slice(0, 12);

  const categories = [...new Set(catalogue.map((row) => row.category))];
  const live = items.filter(
    (item) => item.status !== "CANCELLED" && item.status !== "VOIDED",
  );

  async function add(procedure: ProcedureCatalogItem) {
    setBusy(true);
    setError(null);
    try {
      await api(`/encounters/${encounterId}/procedures`, {
        method: "POST",
        body: {
          procedureId: procedure.id,
          ...(consultationId ? { consultationId } : {}),
        },
      });
      setQuery("");
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not order that.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <Alert tone="danger">{error}</Alert>}

      {live.length === 0 && (
        <p className="text-sm text-muted">Nothing ordered.</p>
      )}

      <ul className="flex flex-col gap-2">
        {live.map((item) => (
          <li key={item.id} className="rounded-md border border-line px-3 py-2">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-medium">{item.name}</p>
                <p className="text-xs text-muted">
                  {PROCEDURE_CATEGORY_LABEL[item.category]} · RM {item.price} ·{" "}
                  {item.status === "ORDERED" ? "waiting" : "done"}
                  {item.requiresConsent && " · consent needed"}
                  {item.requiresDoctor && " · doctor only"}
                </p>
                {item.site && (
                  <p className="text-xs text-muted">
                    {item.site}
                    {item.laterality &&
                      item.laterality !== "NA" &&
                      ` (${item.laterality.toLowerCase()})`}
                  </p>
                )}
                {item.complications && (
                  <p className="mt-1 text-xs text-danger">
                    {item.complications}
                  </p>
                )}
              </div>
              {editable && item.status === "ORDERED" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    const reason = window.prompt("Why is this not being done?");
                    if (!reason || reason.trim().length < 3) return;
                    await api(`/encounter-procedures/${item.id}/cancel`, {
                      method: "POST",
                      body: { reason: reason.trim() },
                    });
                    await refresh();
                  }}
                >
                  ×
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editable && (
        <div className="flex flex-col gap-2">
          <Field label="Order a procedure">
            <Input
              value={query}
              placeholder="nebuliser, dressing, vaccination…"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && matches[0]) {
                  event.preventDefault();
                  void add(matches[0]);
                }
              }}
            />
          </Field>

          <div className="flex flex-wrap gap-1.5">
            {categories.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={category === value}
                className={
                  category === value
                    ? "rounded-full border border-primary bg-primary-soft px-2.5 py-1 text-xs text-primary-ink"
                    : "rounded-full border border-line px-2.5 py-1 text-xs hover:bg-surface-muted"
                }
                onClick={() => setCategory(category === value ? null : value)}
              >
                {PROCEDURE_CATEGORY_LABEL[value]}
              </button>
            ))}
          </div>

          {(text.length > 0 || category !== null) && (
            <ul className="rounded-md border border-line">
              {matches.length === 0 && (
                <li className="px-3 py-2 text-sm text-muted">
                  Nothing matches.
                </li>
              )}
              {matches.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    disabled={busy}
                    className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-muted disabled:opacity-60"
                    onClick={() => void add(row)}
                  >
                    <span>
                      <span className="font-medium">{row.name}</span>
                      <span className="block text-xs text-muted">
                        {PROCEDURE_CATEGORY_LABEL[row.category]}
                        {row.requiresConsent && " · consent"}
                        {row.requiresDoctor && " · doctor only"}
                      </span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      RM {row.price}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
