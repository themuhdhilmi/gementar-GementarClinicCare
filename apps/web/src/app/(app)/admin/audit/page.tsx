"use client";

import { useCallback, useState } from "react";
import {
  AUDIT_GROUP_LABEL,
  ApiError,
  api,
  type AuditDashboard,
  type AuditEntry,
  type AuditRow,
  type AuditTile,
  type Page,
} from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import {
  Alert,
  Button,
  Card,
  Chip,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  timeAgo,
} from "@/components/ui";

type Tile = {
  key: keyof AuditDashboard;
  title: string;
  hint: string;
  group?: string;
  action?: string;
};

/**
 * AUD-F-12. Six numbers, and each one is a question rather than a
 * statistic: a tile links straight to the entries behind it, because a
 * count nobody can drill into is a count nobody acts on.
 */
const TILES: Tile[] = [
  {
    key: "breakGlass",
    title: "Break-glass access",
    hint: "An administrator reading clinical records.",
    action: "audit.break_glass",
  },
  {
    key: "failedLogins",
    title: "Failed sign-ins",
    hint: "Wrong passwords, locked or unknown accounts.",
    action: "auth.login_failed",
  },
  {
    key: "voids",
    title: "Voided and undone",
    hint: "Invoices, procedures, dispensing.",
    group: "money",
  },
  {
    key: "adjustments",
    title: "Stock adjustments",
    hint: "Counts approved and quantities corrected.",
    group: "stock",
  },
  {
    key: "discounts",
    title: "Discounts with a reason",
    hint: "The ones above the threshold.",
    action: "invoice.discounted",
  },
  {
    key: "unmasks",
    title: "Identity numbers revealed",
    hint: "Somebody asked to see a full IC.",
    action: "patient.id_unmasked",
  },
];

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export default function AuditPage() {
  const [dashboard, setDashboard] = useState<AuditDashboard | null>(null);
  const [events, setEvents] = useState<Page<AuditRow> | null>(null);
  const [action, setAction] = useState("");
  const [group, setGroup] = useState("");
  const [patientId, setPatientId] = useState("");
  const [days, setDays] = useState("7");
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextDashboard, nextEvents] = await Promise.all([
        api<AuditDashboard>("/audit/dashboard"),
        api<Page<AuditRow>>("/audit", {
          query: {
            action: action || undefined,
            actionGroup: group || undefined,
            patientId: patientId.trim() || undefined,
            from: isoDaysAgo(Number(days)),
            page,
            pageSize: 50,
          },
        }),
      ]);
      setDashboard(nextDashboard);
      setEvents(nextEvents);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? caught.message
          : "Could not read the trail.",
      );
    }
  }, [action, group, patientId, days, page]);

  useAsyncEffect(() => load(), [load]);

  function focus(tile: Tile) {
    setAction(tile.action ?? "");
    setGroup(tile.group ?? "");
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Audit</h1>
        <p className="text-sm text-muted">
          Who did what, when, and what it looked like before. Entries cannot be
          edited or deleted, by anyone — the database refuses, not the
          application.
        </p>
      </div>

      {error && <Alert title="Not shown">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {TILES.map((tile) => (
          <Card key={tile.key} title={tile.title} description={tile.hint}>
            <Counters
              tile={dashboard?.[tile.key] ?? { last24h: 0, last7d: 0 }}
              onClick={() => focus(tile)}
            />
            {tile.key === "breakGlass" &&
              (dashboard?.breakGlass.last24h ?? 0) > 0 && (
                <Alert tone="warning">
                  Legitimate when somebody is fixing a problem. Worth a question
                  if it was not.
                </Alert>
              )}
          </Card>
        ))}
      </div>

      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-56">
            <Field label="Kind of activity">
              <Select
                value={group}
                onChange={(event) => {
                  setGroup(event.target.value);
                  setAction("");
                  setPage(1);
                }}
              >
                <option value="">Everything</option>
                {Object.entries(AUDIT_GROUP_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="w-40">
            <Field label="Period">
              <Select
                value={days}
                onChange={(event) => {
                  setDays(event.target.value);
                  setPage(1);
                }}
              >
                <option value="1">Last 24 hours</option>
                <option value="7">Last 7 days</option>
                <option value="30">Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last 12 months</option>
              </Select>
            </Field>
          </div>
          <div className="w-72">
            <Field
              label="A particular patient"
              hint="Paste a patient id from their record."
            >
              <Input
                value={patientId}
                placeholder="optional"
                onChange={(event) => {
                  setPatientId(event.target.value);
                  setPage(1);
                }}
              />
            </Field>
          </div>
          {action && (
            <Button size="sm" variant="ghost" onClick={() => setAction("")}>
              Clear &ldquo;{action}&rdquo;
            </Button>
          )}
          <div className="ml-auto">
            <Button
              size="sm"
              variant="secondary"
              loading={exporting}
              onClick={async () => {
                setExporting(true);
                setError(null);
                try {
                  await downloadCsv({
                    actionGroup: group || undefined,
                    action: action || undefined,
                    patientId: patientId.trim() || undefined,
                    from: isoDaysAgo(Math.min(Number(days), 92)),
                  });
                } catch (caught) {
                  setError(
                    caught instanceof ApiError
                      ? caught.message
                      : "The export needs your password again.",
                  );
                } finally {
                  setExporting(false);
                }
              }}
            >
              Export CSV
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">
          An export covers at most 92 days, asks for your password again, and is
          itself recorded.
        </p>
      </Card>

      {!events ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : events.items.length === 0 ? (
        <EmptyState title="Nothing recorded for that filter" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-line bg-surface">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2.5 font-medium">When</th>
                  <th className="px-4 py-2.5 font-medium">Action</th>
                  <th className="px-4 py-2.5 font-medium">Who</th>
                  <th className="px-4 py-2.5 font-medium">Subject</th>
                  <th className="px-4 py-2.5 font-medium">What changed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {events.items.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer hover:bg-surface-muted"
                    onClick={async () => {
                      try {
                        setOpen(await api<AuditEntry>(`/audit/${row.id}`));
                      } catch {
                        setError("Could not open that entry.");
                      }
                    }}
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {timeAgo(row.occurredAt)}
                    </td>
                    <td className="px-4 py-2.5">
                      {row.action === "audit.break_glass" ? (
                        <Chip tone="LOCKED">break-glass</Chip>
                      ) : (
                        <span className="font-mono text-xs">{row.action}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <p>{row.actorName}</p>
                      <p className="text-xs text-muted">
                        {row.actorRole ?? "—"}
                      </p>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {row.entityType}
                      {row.entityId ? ` · ${row.entityId.slice(-8)}` : ""}
                    </td>
                    <td className="max-w-md truncate px-4 py-2.5 text-xs text-muted">
                      {row.reason ?? changedKeys(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-sm text-muted">
            <span>
              {events.total} entr{events.total === 1 ? "y" : "ies"}
            </span>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={page >= events.pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      <EntryDialog entry={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/**
 * AUD §11: the before-and-after, side by side, with the changed keys
 * picked out. The raw snapshots are underneath for when the diff is not
 * enough — which is usually when somebody is answering a complaint.
 */
function EntryDialog({
  entry,
  onClose,
}: {
  entry: AuditEntry | null;
  onClose: () => void;
}) {
  if (!entry) return null;
  const changes = Object.entries(entry.diff ?? {});

  return (
    <Modal open title={entry.action} onClose={onClose}>
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <Detail
          label="When"
          value={new Date(entry.occurredAt).toLocaleString("en-MY")}
        />
        <Detail
          label="Who"
          value={`${entry.actorName}${entry.actorRole ? ` · ${entry.actorRole}` : ""}`}
        />
        <Detail
          label="Entity"
          value={`${entry.entityType}${entry.entityId ? ` · ${entry.entityId}` : ""}`}
        />
        <Detail label="From" value={entry.ip ?? "—"} />
        <Detail label="Request" value={entry.requestId ?? "—"} />
        {entry.reason && <Detail label="Reason" value={entry.reason} />}
      </dl>

      <div className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          What changed
        </p>
        {changes.length === 0 ? (
          <p className="mt-1 text-sm text-muted">
            Nothing was compared — this entry records that something happened,
            not an edit.
          </p>
        ) : (
          <ul className="mt-1 flex flex-col divide-y divide-line">
            {changes.map(([key, change]) => (
              <li
                key={key}
                className="grid grid-cols-[8rem_1fr_1fr] gap-2 py-1.5 text-xs"
              >
                <span className="font-medium">{key}</span>
                <span className="break-words text-danger line-through">
                  {show(change.from)}
                </span>
                <span className="break-words text-success">
                  {show(change.to)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-xs text-muted">
          The full snapshots
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-muted p-2 text-[11px]">
          {JSON.stringify(
            { before: entry.before, after: entry.after },
            null,
            2,
          )}
        </pre>
      </details>

      <div className="mt-4 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
    </Modal>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{label}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}

function Counters({ tile, onClick }: { tile: AuditTile; onClick: () => void }) {
  return (
    <button type="button" className="flex gap-8 text-left" onClick={onClick}>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted">
          Last 24 hours
        </dt>
        <dd className="text-2xl font-semibold tabular-nums">{tile.last24h}</dd>
      </div>
      <div>
        <dt className="text-xs uppercase tracking-wide text-muted">
          Last 7 days
        </dt>
        <dd className="text-2xl font-semibold tabular-nums">{tile.last7d}</dd>
      </div>
    </button>
  );
}

function changedKeys(row: AuditRow): string {
  const keys = Object.keys(row.diff ?? {});
  return keys.length === 0 ? "" : keys.slice(0, 5).join(", ");
}

function show(value: unknown): string {
  if (value === null || value === undefined) return "—";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Not through `api()`: the response is a file, not JSON, and the browser
 * has to be handed a blob to save rather than a parsed object.
 */
async function downloadCsv(
  filter: Record<string, string | undefined>,
): Promise<void> {
  const response = await fetch("/api/v1/audit/export", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(filter),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null);
    throw new ApiError(
      problem ?? {
        title: "The export was refused.",
        detail: "Sign in again and try once more.",
        status: response.status,
        code: "export_failed",
      },
    );
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
