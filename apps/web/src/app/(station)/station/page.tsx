"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import {
  STATION_LABEL,
  api,
  type QueueStats,
  type Station,
} from "@/lib/api";
import { useSession } from "@/lib/session";
import { useAsyncEffect } from "@/lib/use-async";
import { Icon, type IconName } from "@/components/icons";
import { Button, PageHeader } from "@/components/ui";

/**
 * What this monitor is for.
 *
 * Asked once, when the screen is set up, and then never again: the
 * station page remembers which one it is, so the machine on the pharmacy
 * counter comes back to the pharmacy after a power cut rather than to a
 * menu nobody is standing in front of.
 */
const ABOUT: Partial<Record<Station, { hint: string; icon: IconName }>> = {
  reception: {
    hint: "Every open visit in the building. The screen at the front desk.",
    icon: "today",
  },
  triage: {
    hint: "Patients waiting for observations. The nurse station.",
    icon: "patients",
  },
  doctor: {
    hint: "The consulting room. Calls the next patient into your room.",
    icon: "account",
  },
  procedure: {
    hint: "Dressings, nebulisers and injections waiting to be done.",
    icon: "procedures",
  },
  pharmacy: {
    hint: "Prescriptions waiting to be dispensed.",
    icon: "pharmacy",
  },
  cashier: { hint: "Patients waiting to pay.", icon: "billing" },
  counter: {
    hint: "One window doing medicine and money together.",
    icon: "drawer",
  },
};

/**
 * What this machine was set to last time.
 *
 * `useSyncExternalStore` rather than an effect: this is browser-only
 * state being read during render, which is exactly what it is for. The
 * server snapshot is `null`, so the prerendered page and the first
 * client render agree and nothing flickers.
 */
function useLastStation(): Station | null {
  return useSyncExternalStore(
    () => () => {},
    () => {
      try {
        return window.localStorage.getItem("cliniccare.station");
      } catch {
        // A locked-down kiosk browser may refuse storage. The picker
        // still works; it just cannot offer the shortcut.
        return null;
      }
    },
    () => null,
  ) as Station | null;
}

export default function StationPickerPage() {
  const { me } = useSession();
  const [stations, setStations] = useState<Station[] | null>(null);
  const last = useLastStation();

  useAsyncEffect(async () => {
    if (!me?.activeBranchId) return;
    // Which stations this branch actually has is the server's answer, not
    // a list in the page: a clinic with no triage must not be offered a
    // triage monitor (ENC-F-15).
    const stats = await api<QueueStats>(
      `/branches/${me.activeBranchId}/queues-stats`,
    );
    setStations(stats.stations);
  }, [me?.activeBranchId]);

  const branch = me?.branches.find((b) => b.id === me?.activeBranchId);

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <PageHeader
        title="Set up this screen"
        description="Pick what this monitor is for. Bookmark the screen it opens, or make it the browser's home page, and this machine comes back to the right station on its own after a power cut."
        meta={branch && <span className="text-muted">{branch.name}</span>}
        actions={
          <Link href="/workspace">
            <Button variant="secondary">Back to the application</Button>
          </Link>
        }
      />

      {last && stations?.includes(last) && (
        <p className="mb-4">
          <Link href={`/station/${last}`}>
            <Button>Back to {STATION_LABEL[last]}</Button>
          </Link>
          <span className="ml-3 text-[13px] text-muted">
            what this screen was showing before.
          </span>
        </p>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {(stations ?? []).map((station) => {
          const about = ABOUT[station];
          return (
            <li key={station}>
              <Link
                href={`/station/${station}`}
                className="group flex h-full items-start gap-4 rounded-xl border border-line bg-surface p-5 shadow-e1 transition-shadow hover:shadow-e2 focus-visible:outline-none"
              >
                <span className="mt-0.5 shrink-0 rounded-lg bg-surface-muted p-2.5 text-muted">
                  <Icon name={about?.icon ?? "today"} className="size-6" />
                </span>
                <span>
                  <span className="block text-lg font-semibold">
                    {STATION_LABEL[station]}
                  </span>
                  <span className="mt-1 block text-[13px] leading-relaxed text-muted">
                    {about?.hint}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
