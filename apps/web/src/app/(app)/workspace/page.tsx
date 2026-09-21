"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import {
  ROLE_LABEL,
  api,
  minutes,
  senToRinggit,
  type DashboardTiles,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import { Icon, type IconName } from "@/components/icons";
import { Alert, Card, Chip, PageHeader, Skeleton, Stat } from "@/components/ui";

/**
 * Where signing in lands.
 *
 * It used to be a placeholder listing the modules that were coming.
 * They have all arrived, and a home page that tells somebody what the
 * software will one day do is worse than no home page — it is the first
 * screen they see every morning, so it should answer the first question
 * they have: *what is happening right now, and what am I about to do?*
 *
 * What it shows depends entirely on the role. A cashier does not need
 * the number of unsigned notes and a doctor does not need the drawer.
 */
export default function WorkspacePage() {
  const { me, can } = useSession();
  const [tiles, setTiles] = useState<DashboardTiles | null>(null);
  const [loading, setLoading] = useState(true);

  const branchId = me?.activeBranchId;
  const maySeeNumbers = can("report.operational");

  const load = useCallback(async () => {
    if (!branchId || !maySeeNumbers) {
      setLoading(false);
      return;
    }
    try {
      setTiles(await api<DashboardTiles>(`/branches/${branchId}/dashboard`));
    } catch {
      // The home page is not the place to shout about a failed
      // dashboard. The numbers simply do not appear.
      setTiles(null);
    } finally {
      setLoading(false);
    }
  }, [branchId, maySeeNumbers]);

  useAsyncEffect(() => load(), [load]);

  if (!me) return null;
  const branch = me.branches.find((b) => b.id === me.activeBranchId);

  // The things this person actually does, in the order they do them.
  const shortcuts = SHORTCUTS.filter((s) => !s.needs || can(s.needs));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        /* No first-name guessing: "Dr Farid" and "Puan Zana" both start
           with a title, and Malaysian names often carry bin or binti.
           Greet people with the name they were given. */
        title={`Good day, ${me.user.name}`}
        description={
          <>
            {branch?.name ?? "An unknown branch"} ·{" "}
            {me.roles
              .map((role) => ROLE_LABEL[role])
              .join(", ")
              .toLowerCase() || "no role here"}
          </>
        }
      />

      {me.mfa.enabled && me.mfa.recoveryCodesRemaining <= 2 && (
        <Alert tone="warning" title="Running low on recovery codes">
          You have {me.mfa.recoveryCodesRemaining} left. Generate a fresh set
          from{" "}
          <Link href="/account" className="underline underline-offset-4">
            your account
          </Link>{" "}
          before you run out.
        </Alert>
      )}

      {!me.mfa.enabled && (
        <Alert tone="info" title="Two-step verification is off">
          It is not required for your role, but it is the single best protection
          for a clinical account.{" "}
          <Link href="/account" className="underline underline-offset-4">
            Turn it on
          </Link>
          .
        </Alert>
      )}

      {maySeeNumbers && (
        <Card title="The clinic right now" padding="tight">
          {loading ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i}>
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="mt-2 h-7 w-16" />
                </div>
              ))}
            </div>
          ) : tiles ? (
            <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Waiting now"
                value={tiles.queue.reduce((sum, row) => sum + row.waiting, 0)}
                hint={`${tiles.patients.registered} registered today`}
              />
              <Stat
                label="Wait to the doctor"
                value={minutes(tiles.waitToDoctor.meanSeconds)}
                hint={`${tiles.waitToDoctor.seen} called`}
              />
              <Stat
                label="Finished"
                value={tiles.patients.completed}
                hint={`${tiles.patients.inProgress} still here`}
              />
              {tiles.money ? (
                <Stat
                  label="Billed today"
                  value={senToRinggit(tiles.money.billedSen)}
                  hint={`${tiles.money.issued} invoice${tiles.money.issued === 1 ? "" : "s"}`}
                />
              ) : (
                <Stat
                  label="Needs attention"
                  value={tiles.stock.low + tiles.stock.critical}
                  hint="Products low or critical"
                  tone={tiles.stock.critical > 0 ? "warning" : undefined}
                />
              )}
            </div>
          ) : (
            <p className="text-sm text-muted">
              The numbers are not available just now.
            </p>
          )}
        </Card>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold">
          What would you like to do?
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {shortcuts.map((shortcut) => (
            <Link
              key={shortcut.href}
              href={shortcut.href}
              className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-4 shadow-e1 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-e2"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-ink">
                <Icon name={shortcut.icon} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {shortcut.label}
                </span>
                <span className="mt-0.5 block text-[13px] leading-snug text-muted">
                  {shortcut.hint}
                </span>
              </span>
            </Link>
          ))}
        </div>
      </section>

      <Card
        title="What this role can do here"
        description="Resolved at this branch. Change a role on the Staff screen and this changes with it."
      >
        <div className="flex flex-wrap gap-1.5">
          {me.permissions.map((permission) => (
            <Chip key={permission} tone="neutral">
              {permission}
            </Chip>
          ))}
        </div>
        <p className="mt-3 text-[13px] text-muted">
          {me.permissions.length} permission
          {me.permissions.length === 1 ? "" : "s"} · the menu on the left shows
          only what these allow.
        </p>
      </Card>
    </div>
  );
}

type Shortcut = {
  href: string;
  label: string;
  hint: string;
  icon: IconName;
  needs?: string;
};

/**
 * The half-dozen things somebody actually opens, phrased as the task
 * rather than as the screen. "Register a patient" is what a receptionist
 * is doing; "Patients" is where it happens.
 */
const SHORTCUTS: Shortcut[] = [
  {
    href: "/patients/new",
    label: "Register a patient",
    hint: "A MyKad fills in the date of birth and sex by itself.",
    icon: "patients",
    needs: "patient.write",
  },
  {
    href: "/queue",
    label: "Today's queue",
    hint: "Who is waiting, and where.",
    icon: "today",
    needs: "patient.read",
  },
  {
    href: "/patients",
    label: "Find a patient",
    hint: "By name, telephone, or the last four of a card.",
    icon: "patients",
    needs: "patient.read",
  },
  {
    href: "/pharmacy",
    label: "Dispense",
    hint: "What is waiting at the counter.",
    icon: "pharmacy",
    needs: "dispense.perform",
  },
  {
    href: "/billing",
    label: "Take payment",
    hint: "Bills to issue, and money to collect.",
    icon: "billing",
    needs: "invoice.read",
  },
  {
    href: "/drawer",
    label: "Open the drawer",
    hint: "Nothing can be taken until somebody does.",
    icon: "drawer",
    needs: "payment.take",
  },
  {
    href: "/stock",
    label: "Check stock",
    hint: "What is on the shelves, and what is running out.",
    icon: "stock",
    needs: "stock.read",
  },
  {
    href: "/reports",
    label: "Run a report",
    hint: "Patients, money, stock — for any period.",
    icon: "reports",
    needs: "report.operational",
  },
  {
    href: "/admin/users",
    label: "Manage staff",
    hint: "Who works here, and what they may do.",
    icon: "staff",
    needs: "admin.users",
  },
];
