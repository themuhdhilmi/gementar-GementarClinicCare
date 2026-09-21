"use client";

import { useCallback, useState } from "react";
import {
  ALERT_LABEL,
  ApiError,
  alertTone,
  api,
  postForm,
  type ReorderRow,
  type StockAlertRow,
  type StockCountRow,
  type StockCountType,
  type StockCountView,
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
  Modal,
  PageHeader,
  Select,
  Stat,
} from "@/components/ui";

/**
 * Counting the shelves, and the two lists that tell you to (INV §11).
 *
 * A count is the one place where a person contradicts the system and
 * the system accepts it. The screen is built around that: the expected
 * figure is on the left, what was found goes on the right, and the
 * difference is shown as it is typed so a mis-key is caught before it
 * becomes an adjustment.
 */
export default function CountsPage() {
  const { me, can } = useSession();
  const branchId = me?.activeBranchId ?? null;

  const [counts, setCounts] = useState<StockCountRow[]>([]);
  const [alerts, setAlerts] = useState<StockAlertRow[]>([]);
  const [reorder, setReorder] = useState<ReorderRow[]>([]);
  const [open, setOpen] = useState<StockCountView | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!branchId) return;
    const [list, alertList, suggestions] = await Promise.all([
      api<{ items: StockCountRow[] }>(`/branches/${branchId}/counts`),
      api<{ items: StockAlertRow[] }>(`/branches/${branchId}/alerts`),
      api<{ items: ReorderRow[] }>(`/branches/${branchId}/reorder-suggestions`),
    ]);
    setCounts(list.items);
    setAlerts(alertList.items);
    setReorder(suggestions.items);
  }, [branchId]);

  useAsyncEffect(refresh, [refresh]);

  if (open) {
    return (
      <CountSheet
        view={open}
        onReload={async () =>
          setOpen(await api<StockCountView>(`/counts/${open.count.id}`))
        }
        onClose={async () => {
          setOpen(null);
          await refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Counts and alerts"
        description="What the shelves say, and what the system would like you to look at. A count corrects the record; it never quietly rewrites it."
        meta={
          alerts.length > 0 && (
            <Chip tone="warning">{alerts.length} needing attention</Chip>
          )
        }
        actions={
          can("stock.count") && (
            <Button onClick={() => setStarting(true)}>Start a count</Button>
          )
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      <Card
        title="Needs attention"
        description="Each one appears once, when it starts being true."
      >
        {alerts.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing. Every shelf is above its level and in date.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {alerts.map((row) => (
              <li
                key={`${row.productId}-${row.kind}`}
                className="flex items-center justify-between gap-3"
              >
                <span className="text-sm">
                  <span className="font-medium">
                    {row.product?.name ?? "Product"}
                  </span>
                  <span
                    className={
                      alertTone(row.kind) === "danger"
                        ? "block text-xs text-danger"
                        : "block text-xs text-warning"
                    }
                  >
                    {ALERT_LABEL[row.kind]}
                    {row.observed !== null &&
                      (row.kind === "LOW" || row.kind === "CRITICAL"
                        ? ` · ${row.observed} ${row.product?.dispenseUnit ?? ""} left`
                        : ` · ${row.observed} ${row.observed === 1 ? "batch" : "batches"}`)}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    await api(`/branches/${branchId}/alerts/acknowledge`, {
                      method: "POST",
                      body: { productId: row.productId, kind: row.kind },
                    });
                    await refresh();
                  }}
                >
                  Seen
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Worth ordering"
        description="Days of cover from what actually left the shelf in the last 90 days."
      >
        {reorder.length === 0 ? (
          <p className="text-sm text-muted">Nothing is running short.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-[0.06em] text-muted">
              <tr className="border-b border-line">
                <th className="py-1.5 font-semibold">Product</th>
                <th className="py-1.5 text-right font-semibold">On hand</th>
                <th className="py-1.5 text-right font-semibold">Used / day</th>
                <th className="py-1.5 text-right font-semibold">Days left</th>
                <th className="py-1.5 text-right font-semibold">Suggested</th>
              </tr>
            </thead>
            <tbody>
              {reorder.map((row) => (
                <tr key={row.product.id} className="border-t border-line">
                  <td className="py-1.5">{row.product.name}</td>
                  <td className="py-1.5 text-right tabular-nums">
                    {row.onHand}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {row.perDay || "—"}
                  </td>
                  <td
                    className={
                      row.daysOfCover !== null && row.daysOfCover <= 14
                        ? "py-1.5 text-right font-medium tabular-nums text-danger"
                        : "py-1.5 text-right tabular-nums"
                    }
                  >
                    {/* "Nothing has moved" is not "it will last forever". */}
                    {row.daysOfCover ?? "not used"}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">
                    {row.suggestedQty ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Counts">
        {counts.length === 0 ? (
          <EmptyState title="No counts yet">
            The first one should be an opening count, on a day the clinic is
            closed.
          </EmptyState>
        ) : (
          <ul className="flex flex-col divide-y divide-line text-sm">
            {counts.map((row) => (
              <li
                key={row.id}
                className="flex items-center justify-between gap-3 py-2"
              >
                <span>
                  <button
                    type="button"
                    className="font-medium text-primary underline"
                    onClick={async () =>
                      setOpen(await api<StockCountView>(`/counts/${row.id}`))
                    }
                  >
                    {row.type.toLowerCase()} count
                  </button>
                  <span className="block text-xs text-muted">
                    {row.status.toLowerCase()}
                    {row.blind && " · blind"}
                    {row.frozenAt &&
                      ` · frozen ${new Date(row.frozenAt).toLocaleString()}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {starting && branchId && (
        <StartCountModal
          branchId={branchId}
          onClose={() => setStarting(false)}
          onOpened={async (view) => {
            setStarting(false);
            setOpen(view);
            await refresh();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function StartCountModal({
  branchId,
  onClose,
  onOpened,
  onError,
}: {
  branchId: string;
  onClose: () => void;
  onOpened: (view: StockCountView) => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const [type, setType] = useState<StockCountType>("CYCLE");
  const [blind, setBlind] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Modal open title="Start a count" onClose={onClose}>
      <div className="flex flex-col gap-2">
        <Field label="What kind">
          <Select
            value={type}
            onChange={(event) => setType(event.target.value as StockCountType)}
          >
            <option value="OPENING">Opening — the very first count</option>
            <option value="FULL">Full — every shelf</option>
            <option value="CYCLE">Cycle — a regular partial count</option>
            <option value="ADHOC">Ad hoc — something specific</option>
          </Select>
        </Field>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={blind}
            onChange={(event) => setBlind(event.target.checked)}
          />
          <span>
            Blind
            <span className="block text-xs text-muted">
              The counter does not see what the system expects. A number on the
              sheet is a number people count towards.
            </span>
          </span>
        </label>

        {type === "OPENING" && (
          <div className="rounded-md border border-line bg-surface-muted p-2">
            <Field
              label="Or import a spreadsheet"
              hint="Columns: sku, batch_no, expiry, quantity, cost"
            >
              <input
                type="file"
                accept=".csv,text/csv"
                className="text-sm"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </Field>
            <p className="mt-1 text-xs text-muted">
              Nothing is written until you approve the count it creates.
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            onError(null);
            try {
              if (file) {
                const form = new FormData();
                form.append("file", file);
                await onOpened(
                  await postForm<StockCountView>(
                    `/branches/${branchId}/counts/import?dryRun=false`,
                    form,
                  ),
                );
                return;
              }
              await onOpened(
                await api<StockCountView>(`/branches/${branchId}/counts`, {
                  method: "POST",
                  body: { type, blind },
                }),
              );
            } catch (caught) {
              onError(
                caught instanceof ApiError
                  ? caught.message
                  : "Could not start it.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          {file ? "Import" : "Start"}
        </Button>
      </div>
    </Modal>
  );
}

function CountSheet({
  view,
  onReload,
  onClose,
}: {
  view: StockCountView;
  onReload: () => Promise<void>;
  onClose: () => Promise<void>;
}) {
  const { can } = useSession();
  const [entries, setEntries] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const open = view.count.status === "OPEN";
  const counted = view.lines.filter((line) => line.counted !== null).length;

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await onReload();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "That did not work.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={`${view.count.type.charAt(0)}${view.count.type.slice(1).toLowerCase()} count`}
        meta={
          <>
            <Chip tone={view.count.status}>{view.count.status}</Chip>
            {view.count.blind && (
              <Chip tone="info" dot>
                blind — the expected figure is hidden
              </Chip>
            )}
            <span className="text-muted tabular-nums">
              {counted} of {view.lines.length} counted
            </span>
          </>
        }
        actions={
          <Button variant="secondary" onClick={() => void onClose()}>
            Back
          </Button>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}

      {view.summary && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Agreed" value={view.summary.agreed} />
          <Stat
            label="More than expected"
            value={view.summary.over}
            tone={view.summary.over > 0 ? "success" : undefined}
          />
          <Stat
            label="Less than expected"
            value={view.summary.under}
            tone={view.summary.under > 0 ? "danger" : undefined}
          />
          <Stat label="Net units" value={view.summary.netUnits} />
        </div>
      )}

      <Card title="The sheet">
        {view.lines.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing on the sheet yet. An opening count starts empty — add what
            is on the shelf.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-[0.06em] text-muted">
              <tr className="border-b border-line">
                <th className="py-1.5 font-semibold">Product</th>
                <th className="py-1.5 font-semibold">Batch</th>
                {!view.count.blind && (
                  <th className="py-1.5 text-right font-semibold">Expected</th>
                )}
                <th className="py-1.5 text-right font-semibold">Counted</th>
                <th className="py-1.5 text-right font-semibold">Difference</th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((line) => {
                const typed = entries[line.id];
                const value =
                  typed ?? (line.counted === null ? "" : String(line.counted));
                const difference =
                  line.expected !== null && value !== ""
                    ? Number(value) - line.expected
                    : line.variance;
                return (
                  <tr key={line.id} className="border-t border-line">
                    <td className="py-1.5">
                      {line.product?.name ?? "—"}
                      {line.product?.strengthText && (
                        <span className="text-muted">
                          {" "}
                          {line.product.strengthText}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-muted">
                      {line.batch?.batchNo ?? line.newBatchNo ?? "—"}
                    </td>
                    {!view.count.blind && (
                      <td className="py-1.5 text-right tabular-nums">
                        {line.expected ?? "—"}
                      </td>
                    )}
                    <td className="py-1.5 text-right">
                      {open ? (
                        <input
                          type="number"
                          min="0"
                          step="0.5"
                          value={value}
                          aria-label={`Counted, ${line.product?.name ?? "product"}`}
                          className="w-24 rounded-md border border-line bg-surface px-2 py-1 text-right text-sm"
                          onChange={(event) =>
                            setEntries((current) => ({
                              ...current,
                              [line.id]: event.target.value,
                            }))
                          }
                        />
                      ) : (
                        <span className="tabular-nums">
                          {line.counted ?? "—"}
                        </span>
                      )}
                    </td>
                    <td
                      className={
                        difference === null || difference === 0
                          ? "py-1.5 text-right tabular-nums text-muted"
                          : difference > 0
                            ? "py-1.5 text-right font-medium tabular-nums text-success"
                            : "py-1.5 text-right font-medium tabular-nums text-danger"
                      }
                    >
                      {view.count.blind && open
                        ? "—"
                        : difference === null
                          ? "—"
                          : difference > 0
                            ? `+${difference}`
                            : difference}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex justify-end gap-2">
        {open && (
          <>
            <Button
              variant="secondary"
              loading={busy}
              disabled={Object.keys(entries).length === 0}
              onClick={() =>
                void act(async () => {
                  await api(`/counts/${view.count.id}/lines`, {
                    method: "PUT",
                    body: {
                      lines: Object.entries(entries)
                        .filter(([, v]) => v !== "")
                        .map(([id, v]) => ({
                          batchId: view.lines.find((l) => l.id === id)?.batchId,
                          counted: Number(v),
                        })),
                    },
                  });
                  setEntries({});
                })
              }
            >
              Save what is counted
            </Button>
            <Button
              loading={busy}
              onClick={() =>
                void act(() =>
                  api(`/counts/${view.count.id}/submit`, { method: "POST" }),
                )
              }
            >
              Done counting
            </Button>
          </>
        )}

        {view.count.status === "SUBMITTED" && can("stock.adjust") && (
          <Button
            loading={busy}
            onClick={() =>
              void act(() =>
                api(`/counts/${view.count.id}/approve`, { method: "POST" }),
              )
            }
          >
            Approve and adjust the stock
          </Button>
        )}

        {view.count.status === "APPROVED" && (
          <p className="self-center text-sm text-muted">
            Approved. The adjustments are in the ledger.
          </p>
        )}
      </div>
    </div>
  );
}
