"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ROLE_LABEL } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Icon } from "./icons";
import { Logo, LogoMark } from "./logo";
import { NAV, isActive, type NavItem } from "./nav";
import { Button, Select } from "./ui";

/**
 * The frame a clinic works inside all day.
 *
 * A left rail rather than a bar across the top, for the reason every
 * system of this kind ends up there: there are sixteen places to go and
 * a horizontal bar can hold about seven before it wraps into an
 * unreadable second row. Vertical space is cheap on a desk monitor,
 * horizontal space is not, and a rail groups things — which is what
 * turns a list you scan every time into one you learn.
 *
 * The rail is dark because the brand is red on black and because it
 * gives the working area an edge: on a wide screen a white sidebar on a
 * white page has nothing holding it together.
 *
 * The branch switcher is a **server** action. The client is never
 * trusted to say where somebody may work — it asks, and the server
 * decides.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { me, refresh, logout, can } = useSession();
  const pathname = usePathname();
  const [switching, setSwitching] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Escape closes the drawer. Subscribing to the keyboard is what an
  // effect is for; the state change happens in the callback, not in the
  // effect body.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!me) return null;

  const groups = NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.needs || can(item.needs)),
  })).filter((group) => group.items.length > 0);

  const current = groups
    .flatMap((group) => group.items)
    .find((item) => isActive(pathname, item));

  /**
   * Closing the drawer when a link is followed, rather than reacting to
   * the path afterwards. Leaving it open over the page you just asked
   * for is the commonest mobile-navigation bug there is, and doing it
   * in an effect means a render where it is still wrong.
   */
  const close = () => setMenuOpen(false);

  async function switchBranch(branchId: string) {
    setSwitching(true);
    try {
      await api("/auth/me/branch", { method: "PUT", body: { branchId } });
      await refresh();
    } finally {
      setSwitching(false);
    }
  }

  const rail = (
    <div
      className="flex h-full flex-col text-brand-ink"
      // The same surface as the sign-in panel, so the two read as one
      // product rather than two that happen to share a logo.
      style={{
        background:
          "linear-gradient(170deg, var(--brand-from) 0%, var(--brand-mid) 60%, var(--brand-to) 100%)",
      }}
    >
      <div className="flex items-center justify-between px-5 py-5">
        <Link
          href="/workspace"
          aria-label="ClinicCare"
          className="flex items-center"
        >
          <Logo className="h-9 w-auto" surface="dark" compact priority />
        </Link>
        <button
          type="button"
          onClick={close}
          className="rounded-md p-1.5 text-brand-ink-muted hover:bg-white/10 hover:text-brand-ink lg:hidden"
          aria-label="Close the menu"
        >
          <Icon name="close" />
        </button>
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
        {groups.map((group) => (
          <div key={group.label} className="mb-5">
            <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-brand-ink-muted">
              {group.label}
            </p>
            <ul className="flex flex-col gap-0.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <RailLink
                    item={item}
                    active={isActive(pathname, item)}
                    onNavigate={close}
                  />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-brand-rule px-3 py-3">
        <Link
          href="/account"
          onClick={close}
          aria-current={pathname.startsWith("/account") ? "page" : undefined}
          className={`flex items-center gap-3 rounded-md px-3 py-2 ${
            pathname.startsWith("/account")
              ? "bg-white/10 text-brand-ink"
              : "text-brand-ink-muted hover:bg-white/5 hover:text-brand-ink"
          }`}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-on-primary">
            {initials(me.user.name)}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-brand-ink">
              {me.user.name}
            </span>
            <span className="block truncate text-xs">
              {me.roles.map((role) => ROLE_LABEL[role]).join(", ") ||
                "No role here"}
            </span>
          </span>
        </Link>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen lg:flex">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm"
      >
        Skip to the page
      </a>

      {/* The rail, fixed on a desk monitor. */}
      <aside className="hidden w-64 shrink-0 lg:block">
        <div className="fixed inset-y-0 w-64">{rail}</div>
      </aside>

      {/* The same rail as a drawer on a phone or a tablet at the counter. */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-40 lg:hidden"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
        >
          <div
            className="absolute inset-0 bg-black/40"
            onClick={close}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 w-64 shadow-xl">{rail}</div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
          <div className="flex h-[var(--app-bar-h)] items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="rounded-md p-1.5 text-muted hover:bg-surface-muted hover:text-foreground lg:hidden"
              aria-label="Open the menu"
            >
              <Icon name="menu" />
            </button>
            <span className="lg:hidden">
              <LogoMark className="size-7" />
            </span>

            {/* Where you are. On a system with sixteen screens this is
                worth a line of its own, not a highlighted tab. */}
            <h1 className="truncate text-base font-semibold">
              {current?.label ?? titleFor(pathname)}
            </h1>

            <div className="ml-auto flex items-center gap-3">
              {me.branches.length > 1 ? (
                <label className="flex items-center gap-2 text-sm">
                  <span className="hidden text-muted sm:inline">Branch</span>
                  <Select
                    value={me.activeBranchId}
                    disabled={switching}
                    onChange={(event) => void switchBranch(event.target.value)}
                    className="w-44"
                  >
                    {me.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name} ({branch.code})
                      </option>
                    ))}
                  </Select>
                </label>
              ) : (
                <span className="hidden text-sm text-muted sm:inline">
                  {me.branches[0]?.name ?? "No branch"}
                </span>
              )}

              <Button
                variant="secondary"
                size="sm"
                onClick={() => void logout()}
              >
                Sign out
              </Button>
            </div>
          </div>
        </header>

        <main id="main" className="flex-1 px-4 py-6 sm:px-6">
          <div className="mx-auto max-w-7xl">{children}</div>
        </main>
      </div>
    </div>
  );
}

function RailLink({
  item,
  active,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  onNavigate: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      className={`group relative flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-white/10 font-medium text-brand-ink"
          : "text-brand-ink-muted hover:bg-white/5 hover:text-brand-ink"
      }`}
    >
      {/* The marker rather than a colour change alone: the rail is dark,
          and a dark red on near-black is not a difference everybody can
          see. */}
      <span
        aria-hidden
        className={`absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r ${
          active ? "bg-primary" : "bg-transparent"
        }`}
      />
      <Icon name={item.icon} className="size-5 shrink-0" />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

/**
 * What to call a page the menu does not contain.
 *
 * A visit, a consultation and the account screen are all reached from
 * somewhere else rather than from the rail, and putting the product's
 * name in the heading instead would be worse than leaving it blank —
 * it looks like the page failed to load.
 */
const OFF_MENU: Array<[prefix: string, title: string]> = [
  ["/encounters", "Visit"],
  ["/consultations", "Consultation"],
  ["/account", "My account"],
];

function titleFor(pathname: string): string {
  return OFF_MENU.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? "";
}

/** Two letters for the avatar. "Dr Farid" is D F, not D R. */
function initials(name: string): string {
  const words = name
    .split(/\s+/)
    .filter(
      (word) =>
        word.length > 0 &&
        !/^(dr|datuk|dato|haji|hajah|puan|encik|cik|en)\.?$/i.test(word),
    );
  const use = words.length > 0 ? words : name.split(/\s+/);
  return ((use[0]?.[0] ?? "") + (use[1]?.[0] ?? "")).toUpperCase() || "?";
}
