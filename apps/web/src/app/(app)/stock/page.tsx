"use client";

import { useCallback, useState } from "react";
import {
  ApiError,
  api,
  expiryTone,
  type Product,
  type StockMovementRow,
  type StockOptions,
  type StockRow,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import {
  Alert,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Segmented,
  Select,
  Toolbar,
} from "@/components/ui";

/**
 * What is on the shelf (INV-F-18), and the two things people do to it:
 * record a delivery and correct a number.
 *
 * Expiry is coloured and nothing else is. A screen where every row is
 * tinted is a screen where the tint means nothing, and the only thing
 * here that needs catching from across the room is medicine going off.
 */
export default function StockPage() {
  const { me, can } = useSession();
  const branchId = me?.activeBranchId ?? null;

  const [rows, setRows] = useState<StockRow[]>([]);
  const [options, setOptions] = useState<StockOptions | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "low" | "expiring">("all");
  const [error, setError] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [adjusting, setAdjusting] = useState<{
    row: StockRow;
    batchId: string;
  } | null>(null);
  const [history, setHistory] = useState<{
    row: StockRow;
    items: StockMovementRow[];
  } | null>(null);

  const refresh = useCallback(async () => {
    if (!branchId) return;
    const params = new URLSearchParams();
    if (query.trim().length >= 2) params.set("q", query.trim());
    if (filter === "low") params.set("belowMin", "true");
    if (filter === "expiring") params.set("expiringDays", "90");
    const next = await api<{ items: StockRow[] }>(
      `/branches/${branchId}/stock?${params.toString()}`,
    );
    setRows(next.items);
  }, [branchId, query, filter]);

  useAsyncEffect(refresh, [refresh], { debounceMs: 200 });
  useAsyncEffect(async () => {
    setOptions(await api<StockOptions>("/stock/options"));
  }, []);

  async function openHistory(row: StockRow) {
    const items = await api<{ items: StockMovementRow[] }>(
      `/branches/${branchId}/movements?productId=${row.product.id}&limit=100`,
    );
    setHistory({ row, items: items.items });
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Stock"
        description="What is on the shelf at this branch, batch by batch. A batch is the unit that expires, so it is the unit that is counted."
        meta={
          <span className="text-muted">
            {rows.length} product{rows.length === 1 ? "" : "s"} with batches
            here
          </span>
        }
        actions={
          can("stock.receive") && (
            <Button onClick={() => setReceiving(true)}>
              Record a delivery
            </Button>
          )
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Toolbar>
        <div className="min-w-64 flex-1">
          <Field label="Find">
            <Input
              value={query}
              placeholder="amox, gauze…"
              onChange={(event) => setQuery(event.target.value)}
            />
          </Field>
        </div>
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          options={[
            ["all", "Everything"],
            ["low", "Running low"],
            ["expiring", "Expiring within 90 days"],
          ]}
        />
      </Toolbar>

      {rows.length === 0 ? (
        <EmptyState title="Nothing here">
          {filter === "all"
            ? "No stock has been recorded at this branch yet."
            : "Nothing matches that filter, which is the good outcome."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.product.id}>
              <Card
                title={`${row.product.name}${row.product.strengthText ? ` ${row.product.strengthText}` : ""}`}
                description={`${row.onHand} ${row.product.dispenseUnit} on hand · ${row.product.sku}`}
                actions={
                  <Button
                    variant="quiet"
                    size="sm"
                    onClick={() => void openHistory(row)}
                  >
                    History
                  </Button>
                }
              >
                {row.belowMin && (
                  <Alert tone="danger">
                    At or below the minimum of {row.minStock}{" "}
                    {row.product.dispenseUnit}.
                  </Alert>
                )}
                {!row.belowMin && row.belowReorder && (
                  <Alert tone="warning">
                    At or below the reorder level of {row.reorderLevel}{" "}
                    {row.product.dispenseUnit}.
                  </Alert>
                )}

                <table className="mt-3 w-full text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-[0.06em] text-muted">
                    <tr className="border-b border-line">
                      <th className="py-1.5 font-semibold">Batch</th>
                      <th className="py-1.5 font-semibold">Expires</th>
                      <th className="py-1.5 text-right font-semibold">
                        On hand
                      </th>
                      <th className="py-1.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {row.batches.map((batch) => {
                      const tone = expiryTone(batch.expiryDate, batch.status);
                      return (
                        <tr key={batch.id} className="border-t border-line">
                          <td className="py-2 font-mono text-xs">
                            {batch.batchNo}
                            {batch.status === "BLOCKED" && (
                              <span className="ml-2 text-xs font-medium text-danger">
                                Blocked
                              </span>
                            )}
                          </td>
                          <td
                            className={
                              tone === "danger"
                                ? "py-2 font-medium text-danger tabular-nums"
                                : tone === "warning"
                                  ? "py-2 font-medium text-warning tabular-nums"
                                  : "py-2 tabular-nums"
                            }
                          >
                            {batch.expiryDate?.slice(0, 10) ?? "—"}
                          </td>
                          <td className="py-2 text-right font-medium tabular-nums">
                            {batch.quantityOnHand}
                          </td>
                          <td className="py-2 text-right">
                            {can("stock.adjust") &&
                              batch.status !== "DEPLETED" && (
                                <Button
                                  variant="quiet"
                                  size="sm"
                                  onClick={() =>
                                    setAdjusting({ row, batchId: batch.id })
                                  }
                                >
                                  Correct
                                </Button>
                              )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {receiving && branchId && (
        <ReceiveModal
          branchId={branchId}
          onClose={() => setReceiving(false)}
          onDone={async () => {
            setReceiving(false);
            await refresh();
          }}
          onError={setError}
        />
      )}

      {adjusting && branchId && options && (
        <AdjustModal
          branchId={branchId}
          batchId={adjusting.batchId}
          productName={adjusting.row.product.name}
          reasonCodes={options.reasonCodes}
          onClose={() => setAdjusting(null)}
          onDone={async () => {
            setAdjusting(null);
            await refresh();
          }}
          onError={setError}
        />
      )}

      <Modal
        open={history !== null}
        title={`${history?.row.product.name ?? ""} — movements`}
        onClose={() => setHistory(null)}
      >
        {history?.items.length === 0 ? (
          <p className="text-sm text-muted">Nothing has moved yet.</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto text-sm">
            {history?.items.map((movement) => (
              <li
                key={movement.id}
                className="border-b border-line py-2 last:border-0"
              >
                <div className="flex justify-between gap-3">
                  <span>{movement.label}</span>
                  <span
                    className={
                      movement.quantity < 0 ? "text-danger" : "text-success"
                    }
                  >
                    {movement.quantity > 0 ? "+" : ""}
                    {movement.quantity}
                  </span>
                </div>
                <p className="text-xs text-muted">
                  {new Date(movement.occurredAt).toLocaleString()} · batch{" "}
                  {movement.batch?.batchNo ?? "—"} · left{" "}
                  {movement.balanceAfter}
                  {movement.performedByName && ` · ${movement.performedByName}`}
                </p>
                {(movement.reasonText || movement.reasonCode) && (
                  <p className="text-xs text-muted">
                    {movement.reasonCode}
                    {movement.reasonText ? `: ${movement.reasonText}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={() => setHistory(null)}>
            Close
          </Button>
        </div>
      </Modal>
    </div>
  );
}

/** INV-F-12: one delivery, one transaction. */
function ReceiveModal({
  branchId,
  onClose,
  onDone,
  onError,
}: {
  branchId: string;
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Product[]>([]);
  const [lines, setLines] = useState<
    Array<{
      product: Product;
      batchNo: string;
      expiry: string;
      quantity: string;
      costPrice: string;
    }>
  >([]);
  const [supplierNote, setSupplierNote] = useState("");
  const [busy, setBusy] = useState(false);

  useAsyncEffect(
    async () => {
      const text = query.trim();
      if (text.length < 2) return;
      const found = await api<{ items: Product[] }>(
        `/products?q=${encodeURIComponent(text)}`,
      );
      setHits(found.items);
    },
    [query],
    { debounceMs: 150 },
  );

  return (
    <Modal open title="Record a delivery" onClose={onClose}>
      <Field label="Add a product">
        <Input
          value={query}
          placeholder="amox, gauze…"
          onChange={(event) => {
            setQuery(event.target.value);
            if (event.target.value.trim().length < 2) setHits([]);
          }}
        />
      </Field>

      {hits.length > 0 && (
        <ul className="mt-1 max-h-40 overflow-y-auto rounded-md border border-line">
          {hits.slice(0, 8).map((product) => (
            <li key={product.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-surface-muted"
                onClick={() => {
                  setLines((current) => [
                    ...current,
                    {
                      product,
                      batchNo: "",
                      expiry: "",
                      quantity: "",
                      costPrice: "",
                    },
                  ]);
                  setQuery("");
                  setHits([]);
                }}
              >
                {product.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      <ul className="mt-3 flex flex-col gap-3">
        {lines.map((line, index) => (
          <li
            key={`${line.product.id}-${index}`}
            className="rounded-md border border-line p-2"
          >
            <div className="flex items-baseline justify-between">
              <p className="text-sm font-medium">{line.product.label}</p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  setLines((current) => current.filter((_, i) => i !== index))
                }
              >
                ×
              </Button>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <Field label="How many">
                <Input
                  type="number"
                  min="0"
                  value={line.quantity}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((l, i) =>
                        i === index
                          ? { ...l, quantity: event.target.value }
                          : l,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Cost each (RM)">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.costPrice}
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((l, i) =>
                        i === index
                          ? { ...l, costPrice: event.target.value }
                          : l,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Batch number">
                <Input
                  value={line.batchNo}
                  placeholder="Leave empty if it has none"
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((l, i) =>
                        i === index ? { ...l, batchNo: event.target.value } : l,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Expires" hint="YYYY-MM is fine">
                <Input
                  value={line.expiry}
                  placeholder="2027-03"
                  onChange={(event) =>
                    setLines((current) =>
                      current.map((l, i) =>
                        i === index ? { ...l, expiry: event.target.value } : l,
                      ),
                    )
                  }
                />
              </Field>
            </div>
          </li>
        ))}
      </ul>

      <div className="mt-3">
        <Field label="Delivery note or invoice number">
          <Input
            value={supplierNote}
            onChange={(event) => setSupplierNote(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          disabled={
            lines.length === 0 || lines.some((l) => !(Number(l.quantity) > 0))
          }
          onClick={async () => {
            setBusy(true);
            onError(null);
            try {
              await api(`/branches/${branchId}/stock-in`, {
                method: "POST",
                body: {
                  supplierNote: supplierNote.trim() || undefined,
                  lines: lines.map((line) => ({
                    productId: line.product.id,
                    quantity: Number(line.quantity),
                    ...(line.batchNo.trim()
                      ? { batchNo: line.batchNo.trim() }
                      : {}),
                    ...(line.expiry.trim()
                      ? { expiry: line.expiry.trim() }
                      : {}),
                    ...(line.costPrice
                      ? { costPrice: Number(line.costPrice) }
                      : {}),
                  })),
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
          Record it
        </Button>
      </div>
    </Modal>
  );
}

/** INV-F-13: a correction says which way and why. */
function AdjustModal({
  branchId,
  batchId,
  productName,
  reasonCodes,
  onClose,
  onDone,
  onError,
}: {
  branchId: string;
  batchId: string;
  productName: string;
  reasonCodes: string[];
  onClose: () => void;
  onDone: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [type, setType] = useState("ADJUST_OUT");
  const [quantity, setQuantity] = useState("");
  const [reasonCode, setReasonCode] = useState(reasonCodes[0] ?? "other");
  const [reasonText, setReasonText] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Modal open title={`Correct ${productName}`} onClose={onClose}>
      <p className="text-sm text-muted">
        This writes a movement rather than editing the number, so the history
        still explains how the shelf got to where it is.
      </p>
      <div className="mt-3 flex flex-col gap-2">
        <Field label="What happened">
          <Select
            value={type}
            onChange={(event) => setType(event.target.value)}
          >
            <option value="ADJUST_OUT">
              There is less than the system says
            </option>
            <option value="ADJUST_IN">
              There is more than the system says
            </option>
            <option value="DAMAGE">Damaged</option>
            <option value="EXPIRE">Expired</option>
            <option value="RETURN_TO_SUPPLIER">Returned to the supplier</option>
          </Select>
        </Field>
        <Field label="How many">
          <Input
            type="number"
            min="0"
            step="0.5"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </Field>
        <Field label="Reason">
          <Select
            value={reasonCode}
            onChange={(event) => setReasonCode(event.target.value)}
          >
            {reasonCodes.map((code) => (
              <option key={code} value={code}>
                {code.replaceAll("_", " ")}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Anything to add">
          <Input
            value={reasonText}
            onChange={(event) => setReasonText(event.target.value)}
          />
        </Field>
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          disabled={!(Number(quantity) > 0)}
          onClick={async () => {
            setBusy(true);
            onError(null);
            try {
              await api(`/branches/${branchId}/adjustments`, {
                method: "POST",
                body: {
                  batchId,
                  type,
                  quantity: Number(quantity),
                  reasonCode,
                  ...(reasonText.trim()
                    ? { reasonText: reasonText.trim() }
                    : {}),
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
          Record it
        </Button>
      </div>
    </Modal>
  );
}
