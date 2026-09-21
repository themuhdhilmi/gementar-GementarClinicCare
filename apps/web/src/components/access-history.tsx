"use client";

import { useCallback, useState } from "react";
import { ApiError, api, type AuditRow } from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import { Alert, EmptyState, Select, timeAgo } from "@/components/ui";

/**
 * AUD-F-11: everyone who has looked at, or changed, this patient's
 * records.
 *
 * This is the view a PDPA request turns into. It is also the one that
 * makes the promise in `AUD-Q-01` — "your record views are logged" —
 * something a member of staff can check rather than take on trust.
 */
export function AccessHistory({ patientId }: { patientId: string }) {
  const [items, setItems] = useState<AuditRow[] | null>(null);
  const [days, setDays] = useState("90");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await api<{ items: AuditRow[] }>(
        `/patients/${patientId}/access-history`,
        {
          query: { days: Number(days) },
        },
      );
      setItems(next.items);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 403
          ? "Only an administrator can read the access history."
          : "Could not read the access history.",
      );
    }
  }, [patientId, days]);

  useAsyncEffect(() => load(), [load]);

  if (error) return <Alert>{error}</Alert>;

  return (
    <div className="flex flex-col gap-3">
      <div className="w-40">
        <Select value={days} onChange={(event) => setDays(event.target.value)}>
          <option value="30">Last 30 days</option>
          <option value="90">Last 90 days</option>
          <option value="366">Last 12 months</option>
        </Select>
      </div>

      {!items ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState title="Nothing in that period" />
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((row) => (
            <li
              key={row.id}
              className="flex items-start justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm">
                  <span className="font-medium">{row.actorName}</span>{" "}
                  <span className="text-muted">{describe(row.action)}</span>
                </p>
                <p className="text-xs text-muted">
                  {row.actorRole ?? "unknown role"}
                  {row.reason ? ` · ${row.reason}` : ""}
                </p>
              </div>
              <span className="shrink-0 text-xs text-muted">
                {timeAgo(row.occurredAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Plain English, because this list is read by people, not by engineers. */
function describe(action: string): string {
  const known: Record<string, string> = {
    "clinical.viewed": "opened the clinical record",
    "patient.registered": "registered this patient",
    "patient.updated": "changed the patient details",
    "patient.id_unmasked": "revealed the full identity number",
    "patient.merged": "merged this record",
    "patient.exported": "exported this record",
    "patient.document_viewed": "opened an attachment",
    "audit.break_glass": "used break-glass access",
    "consultation.signed": "signed a consultation",
    "consultation.amended": "amended a signed consultation",
    "triage.recorded": "recorded vitals",
    "document.issued": "issued a document",
  };
  return known[action] ?? `did ${action}`;
}
