'use client';

import { useCallback, useState } from 'react';
import {
  ApiError,
  METHOD_LABEL,
  api,
  senToRinggit,
  type CashSession,
  type ClosePreview,
  type PaymentMethod,
} from '@/lib/api';
import { useSession } from '@/lib/session';
import { useAsyncEffect } from '@/lib/use-async';
import { Alert, Button, Card, EmptyState, Field, Input, Modal, TextField } from '@/components/ui';

type ZReport = {
  session: CashSession;
  asAtClose: boolean;
  reopened: boolean;
  expectedCashSen: string;
  totalsByMethod: Record<string, string>;
  collectedSen: string;
  roundingSen: string;
  payments: number;
  voids: number;
  voidedSen: string;
  movements: Array<{ type: string; amount: string; reason: string | null; by: string; at: string }>;
  lines: Array<{
    receiptNo: string;
    method: PaymentMethod;
    amount: string;
    status: string;
    by: string;
    at: string;
  }>;
};

const MOVEMENT_LABEL: Record<string, string> = {
  FLOAT_IN: 'Opening float',
  PAYMENT_IN: 'Payment',
  VOID_OUT: 'Voided payment',
  REFUND_OUT: 'Refund',
  CASH_DROP: 'To the safe',
  PETTY_OUT: 'Petty cash',
};

/**
 * The drawer (PAY §11).
 *
 * One screen for the whole of a shift: open it with a float in the
 * morning, watch what is expected in it, and count it in the evening.
 * The variance is shown as soon as a count is typed, before anything is
 * committed, because a cashier who is RM 15 short wants to recount
 * before telling anybody.
 */
export default function DrawerPage() {
  const { me, can } = useSession();
  const branchId = me?.activeBranchId;

  const [session, setSession] = useState<CashSession | null>(null);
  const [preview, setPreview] = useState<ClosePreview | null>(null);
  const [report, setReport] = useState<ZReport | null>(null);
  const [history, setHistory] = useState<CashSession[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [closing, setClosing] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState(false);

  const [float, setFloat] = useState('200');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [dropAmount, setDropAmount] = useState('');
  const [dropReason, setDropReason] = useState('');

  const load = useCallback(async () => {
    if (!branchId) return;
    setError(null);
    const current = await api<{ session: CashSession | null }>(
      `/branches/${branchId}/cash-sessions/current`,
    );
    setSession(current.session);
    setPreview(
      current.session
        ? await api<ClosePreview>(`/cash-sessions/${current.session.id}/preview-close`)
        : null,
    );
    if (can('eod.close')) {
      const past = await api<{ items: CashSession[] }>(`/branches/${branchId}/cash-sessions`, {
        query: { days: 14 },
      });
      setHistory(past.items.filter((row) => row.status === 'CLOSED'));
    }
  }, [branchId, can]);

  useAsyncEffect(() => load(), [load]);

  async function guard(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      await load();
      return true;
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'That did not work.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (!branchId) return <EmptyState title="No branch selected" />;

  const expected = preview ? Number(preview.expectedCashSen) : 0;
  const countedSen = counted === '' ? null : Math.round(Number(counted) * 100);
  const variance = countedSen === null ? null : countedSen - expected;
  const threshold = preview?.varianceApprovalSen ?? 1_000;
  const needsApproval = variance !== null && Math.abs(variance) > threshold;

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-semibold">Drawer</h1>
        <p className="text-sm text-muted">
          What is expected in it, and what was counted. A difference is recorded, never corrected.
        </p>
      </div>

      {error && <Alert title="Not done">{error}</Alert>}

      {!session ? (
        <Card title="No drawer is open" description="Nothing can be taken until one is.">
          {can('eod.close') ? (
            <Button onClick={() => setOpening(true)}>Open the drawer</Button>
          ) : (
            <p className="text-sm text-muted">Ask a cashier or the administrator to open it.</p>
          )}
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <Card title="Expected in the drawer" description="Float, plus cash in, less what left.">
              <p className="text-3xl font-semibold tabular-nums">
                {senToRinggit(preview?.expectedCashSen ?? '0')}
              </p>
              <p className="mt-1 text-sm text-muted">
                Opened {new Date(session.openedAt).toLocaleTimeString('en-MY')} with{' '}
                {senToRinggit(session.floatSen)}
              </p>
            </Card>
            <Card title="Taken today" description="Every method, posted only.">
              {preview && Object.keys(preview.totalsByMethod).length === 0 ? (
                <p className="text-sm text-muted">Nothing yet.</p>
              ) : (
                <dl className="flex flex-col gap-1 text-sm">
                  {Object.entries(preview?.totalsByMethod ?? {}).map(([method, total]) => (
                    <div key={method} className="flex justify-between">
                      <dt className="text-muted">
                        {METHOD_LABEL[method as PaymentMethod] ?? method}
                      </dt>
                      <dd className="tabular-nums">{senToRinggit(total)}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
            <Card title={`Drawer ${session.drawerCode}`} description={session.status}>
              <div className="flex flex-wrap gap-2">
                {can('eod.close') && (
                  <>
                    <Button size="sm" variant="secondary" onClick={() => setDropping(true)}>
                      Cash out
                    </Button>
                    <Button size="sm" onClick={() => setClosing(true)}>
                      Count and close
                    </Button>
                  </>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void guard(async () =>
                      setReport(await api<ZReport>(`/cash-sessions/${session.id}/z-report`)),
                    )
                  }
                >
                  Z-report
                </Button>
              </div>
            </Card>
          </div>
        </>
      )}

      {history.length > 0 && (
        <Card title="Closed today and this fortnight">
          <ul className="flex flex-col divide-y divide-line text-sm">
            {history.map((row) => (
              <li key={row.id} className="flex items-center justify-between py-2">
                <span>
                  {row.drawerCode} ·{' '}
                  {new Date(row.openedAt).toLocaleDateString('en-MY')}{' '}
                  {row.reopenedAt && <span className="text-warning">· reopened</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span
                    className={`tabular-nums ${
                      row.varianceSen && row.varianceSen !== '0' ? 'text-warning' : 'text-muted'
                    }`}
                  >
                    {row.varianceSen === '0' || row.varianceSen === null
                      ? 'balanced'
                      : senToRinggit(row.varianceSen)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void guard(async () =>
                        setReport(await api<ZReport>(`/cash-sessions/${row.id}/z-report`)),
                      )
                    }
                  >
                    Z-report
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* ------------------------------------------------------ open */}
      <Modal open={opening} title="Open the drawer" onClose={() => setOpening(false)}>
        <TextField
          label="Float"
          hint="What is in the drawer before the first patient."
          type="number"
          step="0.01"
          value={float}
          onChange={(event) => setFloat(event.target.value)}
        />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpening(false)}>
            Not now
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              const ok = await guard(() =>
                api(`/branches/${branchId}/cash-sessions`, {
                  method: 'POST',
                  body: { float: Number(float) },
                }),
              );
              if (ok) setOpening(false);
            }}
          >
            Open with {senToRinggit(String(Math.round(Number(float || 0) * 100)))}
          </Button>
        </div>
      </Modal>

      {/* ----------------------------------------------------- close */}
      <Modal open={closing} title="Count and close" onClose={() => setClosing(false)}>
        <dl className="flex flex-col gap-1 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted">Expected</dt>
            <dd className="tabular-nums">{senToRinggit(preview?.expectedCashSen ?? '0')}</dd>
          </div>
        </dl>
        <div className="mt-3">
          <TextField
            label="Counted"
            hint="What is actually in the drawer, notes and coins."
            type="number"
            step="0.01"
            value={counted}
            onChange={(event) => setCounted(event.target.value)}
          />
        </div>

        {variance !== null && (
          <Alert tone={variance === 0 ? 'success' : needsApproval ? 'danger' : 'warning'}>
            {variance === 0
              ? 'The drawer balances.'
              : `Out by ${senToRinggit(String(variance))}. ${
                  needsApproval
                    ? 'That is more than the clinic allows without an administrator.'
                    : 'Within what the clinic allows; it is still recorded.'
                }`}
          </Alert>
        )}

        {variance !== null && variance !== 0 && (
          <div className="mt-3">
            <TextField
              label="What happened?"
              hint={needsApproval ? 'Required.' : 'Worth writing down.'}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setClosing(false)}>
            Keep it open
          </Button>
          <Button
            loading={busy}
            disabled={counted === '' || (needsApproval && note.trim().length < 3)}
            onClick={async () => {
              const ok = await guard(() =>
                api(`/cash-sessions/${session!.id}/close`, {
                  method: 'POST',
                  body: {
                    counted: Number(counted),
                    note: note.trim() || undefined,
                    // An administrator saying so, deliberately.
                    approve: needsApproval && can('admin.settings') ? true : undefined,
                  },
                }),
              );
              if (ok) {
                setClosing(false);
                setCounted('');
                setNote('');
              }
            }}
          >
            {needsApproval && !can('admin.settings') ? 'Needs an administrator' : 'Close the drawer'}
          </Button>
        </div>
      </Modal>

      {/* ------------------------------------------------------ drop */}
      <Modal open={dropping} title="Take cash out" onClose={() => setDropping(false)}>
        <div className="flex flex-col gap-3">
          <Field label="Amount">
            <Input
              type="number"
              step="0.01"
              value={dropAmount}
              onChange={(event) => setDropAmount(event.target.value)}
            />
          </Field>
          <TextField
            label="What for?"
            hint="To the safe, or petty cash."
            value={dropReason}
            onChange={(event) => setDropReason(event.target.value)}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDropping(false)}>
            Cancel
          </Button>
          <Button
            loading={busy}
            disabled={!dropAmount || dropReason.trim().length < 3}
            onClick={async () => {
              const ok = await guard(() =>
                api(`/cash-sessions/${session!.id}/movements`, {
                  method: 'POST',
                  body: {
                    type: 'CASH_DROP',
                    amount: Number(dropAmount),
                    reason: dropReason.trim(),
                  },
                }),
              );
              if (ok) {
                setDropping(false);
                setDropAmount('');
                setDropReason('');
              }
            }}
          >
            Take it out
          </Button>
        </div>
      </Modal>

      {/* -------------------------------------------------- Z-report */}
      <Modal open={report !== null} title="Z-report" onClose={() => setReport(null)}>
        {report && (
          <div className="flex flex-col gap-3 text-sm">
            {report.reopened && (
              <Alert tone="warning">
                This drawer was reopened after it was closed. An earlier copy of this report may
                say something different.
              </Alert>
            )}
            <p className="text-muted">
              {report.session.drawerCode} ·{' '}
              {new Date(report.session.openedAt).toLocaleString('en-MY')}
              {report.asAtClose ? ' · as at close' : ' · still open'}
            </p>

            <dl className="flex flex-col gap-1">
              {Object.entries(report.totalsByMethod).map(([method, total]) => (
                <div key={method} className="flex justify-between">
                  <dt className="text-muted">
                    {METHOD_LABEL[method as PaymentMethod] ?? method}
                  </dt>
                  <dd className="tabular-nums">{senToRinggit(total)}</dd>
                </div>
              ))}
              <div className="flex justify-between border-t border-line pt-1 font-medium">
                <dt>Collected</dt>
                <dd className="tabular-nums">{senToRinggit(report.collectedSen)}</dd>
              </div>
              {report.roundingSen !== '0' && (
                <div className="flex justify-between">
                  <dt className="text-muted">Rounding</dt>
                  <dd className="tabular-nums">{senToRinggit(report.roundingSen)}</dd>
                </div>
              )}
              <div className="flex justify-between">
                <dt className="text-muted">Expected in the drawer</dt>
                <dd className="tabular-nums">{senToRinggit(report.expectedCashSen)}</dd>
              </div>
              {report.session.countedCashSen && (
                <>
                  <div className="flex justify-between">
                    <dt className="text-muted">Counted</dt>
                    <dd className="tabular-nums">{senToRinggit(report.session.countedCashSen)}</dd>
                  </div>
                  <div className="flex justify-between font-medium">
                    <dt>Difference</dt>
                    <dd className="tabular-nums">{senToRinggit(report.session.varianceSen)}</dd>
                  </div>
                </>
              )}
              {report.voids > 0 && (
                <div className="flex justify-between text-danger">
                  <dt>Voided</dt>
                  <dd className="tabular-nums">
                    {report.voids} · {senToRinggit(report.voidedSen)}
                  </dd>
                </div>
              )}
            </dl>

            {report.session.varianceNote && (
              <p className="text-xs text-muted">{report.session.varianceNote}</p>
            )}

            <details>
              <summary className="cursor-pointer text-xs text-muted">
                Every movement ({report.movements.length})
              </summary>
              <ul className="mt-2 flex flex-col divide-y divide-line text-xs">
                {report.movements.map((row, index) => (
                  <li key={index} className="flex justify-between py-1">
                    <span>
                      {MOVEMENT_LABEL[row.type] ?? row.type}
                      {row.reason ? ` · ${row.reason}` : ''}
                    </span>
                    <span className="tabular-nums">{senToRinggit(row.amount)}</span>
                  </li>
                ))}
              </ul>
            </details>

            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => window.print()}>
                Print
              </Button>
              <Button onClick={() => setReport(null)}>Close</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
