"use client";

import { useCallback, useState } from "react";
import {
  ApiError,
  DOCUMENT_TYPE_LABEL,
  api,
  documentFileUrl,
  type ClinicDocument,
} from "@/lib/api";
import { useAsyncEffect } from "@/lib/use-async";
import {
  Alert,
  Button,
  Chip,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  TextField,
} from "./ui";

/**
 * Printing is a browser concern (DOC-F-03).
 *
 * The API hands back the document as HTML; the browser opens it and
 * calls `print()`. There is no PDF renderer on the server and no print
 * driver in V0 — the Phase 0 spike decides whether one is needed, and
 * until it does this is the path that works on the clinic's existing
 * machine with no installation.
 *
 * The print *count* is recorded separately, because whether a window
 * printed is not something the page can know: the user may cancel the
 * dialog. What is recorded is that the document was sent to print,
 * which is the question the audit trail actually gets asked.
 */
async function printDocument(id: string): Promise<void> {
  const target = window.open(
    documentFileUrl(id),
    "_blank",
    "noopener,width=820,height=1000",
  );
  await api(`/documents/${id}/print`, { method: "POST" });
  target?.addEventListener("load", () => target.print(), { once: true });
}

function issuedOn(iso: string): string {
  return new Date(iso).toLocaleString("en-MY", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Today, tomorrow, the day after — what an MC actually covers. */
function coverage(fromDate: string, days: number): string {
  const from = new Date(`${fromDate}T00:00:00Z`);
  const to = new Date(from.getTime() + (days - 1) * 86_400_000);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-MY", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  return days === 1 ? fmt(from) : `${fmt(from)} — ${fmt(to)}`;
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 10);
}

type Scope =
  | { kind: "patient"; patientId: string }
  | { kind: "encounter"; encounterId: string };

/**
 * What the patient walks out with.
 *
 * A list first: on a patient's record this is a history, and on a
 * signed consultation it is a receipt for what has just been printed.
 * Issuing only appears where there is a signed consultation to issue
 * from, because DOC-R-01 means there is nothing to make a document out
 * of until then.
 */
export function DocumentsPanel({
  scope,
  consultationId,
  canIssue = false,
}: {
  scope: Scope;
  consultationId?: string;
  canIssue?: boolean;
}) {
  const [items, setItems] = useState<ClinicDocument[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState<
    "MC" | "REFERRAL" | "MEDICAL_LETTER" | null
  >(null);

  const path =
    scope.kind === "patient"
      ? `/patients/${scope.patientId}/issued-documents`
      : `/encounters/${scope.encounterId}/documents`;

  const refresh = useCallback(async () => {
    const next = await api<{ items: ClinicDocument[] }>(path);
    setItems(next.items);
  }, [path]);

  useAsyncEffect(refresh, [refresh]);

  async function guard(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "That did not work.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <Alert>{error}</Alert>}

      {canIssue && consultationId && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setIssuing("MC")}>
            Medical certificate
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setIssuing("REFERRAL")}
          >
            Referral
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setIssuing("MEDICAL_LETTER")}
          >
            Letter
          </Button>
        </div>
      )}

      {items.length === 0 ? (
        <EmptyState title="Nothing issued yet">
          {canIssue
            ? "A certificate or referral printed here is kept on the patient’s record."
            : "Documents issued from a signed consultation appear here."}
        </EmptyState>
      ) : (
        <ul className="flex flex-col divide-y divide-line">
          {items.map((doc) => (
            <li
              key={doc.id}
              className="flex items-start justify-between gap-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {DOCUMENT_TYPE_LABEL[doc.type] ?? doc.type}
                  {doc.status === "CANCELLED" && (
                    <Chip tone="DISABLED">Cancelled</Chip>
                  )}
                  {doc.printCount > 1 && (
                    <span className="text-xs font-normal text-muted">
                      printed {doc.printCount}&times;
                    </span>
                  )}
                </p>
                <p className="truncate text-xs text-muted">
                  {doc.documentNo ?? "Not numbered"} · {issuedOn(doc.issuedAt)}
                  {doc.issuedByName ? ` · ${doc.issuedByName}` : ""}
                </p>
                {doc.cancelReason && (
                  <p className="mt-0.5 text-xs text-danger">
                    {doc.cancelReason}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void guard(() => printDocument(doc.id))}
                >
                  Print
                </Button>
                {doc.status === "ISSUED" && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void guard(async () => {
                        const reason = window.prompt(
                          "Why is this being cancelled? The number stays used, and the reason is read later.",
                        );
                        if (!reason) return;
                        await api(`/documents/${doc.id}/cancel`, {
                          method: "POST",
                          body: { reason },
                        });
                      })
                    }
                  >
                    Cancel
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {consultationId && (
        <IssueDialog
          kind={issuing}
          consultationId={consultationId}
          onClose={() => setIssuing(null)}
          onIssued={async (doc) => {
            setIssuing(null);
            await refresh();
            await printDocument(doc.id).catch(() => undefined);
          }}
        />
      )}
    </div>
  );
}

function IssueDialog({
  kind,
  consultationId,
  onClose,
  onIssued,
}: {
  kind: "MC" | "REFERRAL" | "MEDICAL_LETTER" | null;
  consultationId: string;
  onClose: () => void;
  onIssued: (doc: ClinicDocument) => Promise<void>;
}) {
  const [days, setDays] = useState(1);
  const [fromDate, setFromDate] = useState(todayIso());
  const [lightDuty, setLightDuty] = useState(false);
  const [includeDiagnosis, setIncludeDiagnosis] = useState(false);
  const [backdateReason, setBackdateReason] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const backdated = fromDate < todayIso();

  async function submit(path: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const doc = await api<ClinicDocument>(
        `/consultations/${consultationId}/documents/${path}`,
        { method: "POST", body: payload },
      );
      await onIssued(doc);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Could not issue that.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Modal open={kind === "MC"} title="Medical certificate" onClose={onClose}>
        {error && <Alert>{error}</Alert>}
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From">
              <Input
                type="date"
                value={fromDate}
                onChange={(event) => setFromDate(event.target.value)}
              />
            </Field>
            <Field label="Days">
              <Select
                value={days}
                onChange={(event) => setDays(Number(event.target.value))}
              >
                {[1, 2, 3, 4, 5, 6, 7, 10, 14].map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? "day" : "days"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* The number of days is the thing people get wrong: two days
              from today means today and tomorrow, not today plus two. */}
          <Alert tone="info">Covers {coverage(fromDate, days)}</Alert>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={lightDuty}
              onChange={(event) => setLightDuty(event.target.checked)}
            />
            Light duty rather than time off
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={includeDiagnosis}
              onChange={(event) => setIncludeDiagnosis(event.target.checked)}
            />
            Print the diagnosis
            <span className="text-xs text-muted">
              (an employer will read this)
            </span>
          </label>

          {backdated && (
            <TextField
              label="Why does this start before today?"
              hint="Recorded with the certificate. Backdating is allowed, not silent."
              value={backdateReason}
              onChange={(event) => setBackdateReason(event.target.value)}
            />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button
            loading={busy}
            disabled={backdated && backdateReason.trim().length < 3}
            onClick={() =>
              void submit("mc", {
                fromDate,
                days,
                lightDuty,
                includeDiagnosis,
                backdateReason: backdated ? backdateReason.trim() : undefined,
              })
            }
          >
            Issue and print
          </Button>
        </div>
      </Modal>

      <Modal open={kind === "REFERRAL"} title="Referral" onClose={onClose}>
        {error && <Alert>{error}</Alert>}
        <div className="mt-3 flex flex-col gap-3">
          <TextField
            label="Refer to"
            placeholder="Hospital Kuala Lumpur — ENT"
            value={to}
            onChange={(event) => setTo(event.target.value)}
          />
          <Field
            label="Reason"
            hint="The summary is filled in from the record and can be edited on the printout."
          >
            <textarea
              className="min-h-24 w-full rounded-md border border-line bg-surface px-3 py-2 text-base"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button
            loading={busy}
            disabled={to.trim().length < 2 || reason.trim().length < 2}
            onClick={() =>
              void submit("referral", { to: to.trim(), reason: reason.trim() })
            }
          >
            Issue and print
          </Button>
        </div>
      </Modal>

      <Modal open={kind === "MEDICAL_LETTER"} title="Letter" onClose={onClose}>
        {error && <Alert>{error}</Alert>}
        <div className="mt-3 flex flex-col gap-3">
          <TextField
            label="Title"
            placeholder="Medical Letter"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
          <Field label="Letter">
            <textarea
              className="min-h-40 w-full rounded-md border border-line bg-surface px-3 py-2 text-base"
              value={body}
              onChange={(event) => setBody(event.target.value)}
            />
          </Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Not now
          </Button>
          <Button
            loading={busy}
            disabled={body.trim().length < 2}
            onClick={() =>
              void submit("letter", {
                title: title.trim() || undefined,
                body: body.trim(),
              })
            }
          >
            Issue and print
          </Button>
        </div>
      </Modal>
    </>
  );
}
