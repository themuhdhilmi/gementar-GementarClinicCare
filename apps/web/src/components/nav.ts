import type { IconName } from "./icons";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /**
   * What a person needs to see it at all. Absent means everybody.
   *
   * A string rather than a union, because the permission catalogue lives
   * on the server and `can()` already takes one — a second copy here
   * would be a list to keep in step for no gain the compiler can check.
   */
  needs?: string;
  /**
   * `true` when a child route should not light the parent — `/stock` and
   * `/stock/counts` are siblings in the menu, not a page and its detail.
   */
  exact?: boolean;
};

export type NavGroup = { label: string; items: NavItem[] };

/**
 * The menu, as a clinic thinks about its day rather than as the modules
 * happen to be named.
 *
 * Fifteen flat links in a bar was the old shape, and a flat list of
 * fifteen is a list nobody reads — you scan it every time instead of
 * learning it. Grouped, each group is three or four things and the one
 * you want is found by remembering *what kind* of task it is, which is
 * how people actually navigate software they use all day.
 *
 * The order is the day: the floor first, then the counter, then the
 * stock room, then the things an owner looks at, then setup. Admin is
 * last because most people never open it.
 */
export const NAV: NavGroup[] = [
  {
    label: "The floor",
    items: [
      { href: "/workspace", label: "Home", icon: "home" },
      { href: "/queue", label: "Today", icon: "today", needs: "patient.read" },
      {
        href: "/patients",
        label: "Patients",
        icon: "patients",
        needs: "patient.read",
      },
      // The full-screen station consoles (ENC-F-25). In the rail because
      // somebody has to set a counter monitor up once, and then never
      // comes back here — the monitor stays on its own screen.
      {
        href: "/station",
        label: "Station screen",
        icon: "display",
        needs: "patient.read",
      },
    ],
  },
  {
    label: "Care",
    items: [
      {
        href: "/pharmacy",
        label: "Pharmacy",
        icon: "pharmacy",
        needs: "dispense.perform",
      },
      {
        href: "/procedures",
        label: "Procedures",
        icon: "procedures",
        needs: "procedure.perform",
      },
    ],
  },
  {
    label: "Money",
    items: [
      {
        href: "/billing",
        label: "Billing",
        icon: "billing",
        needs: "invoice.read",
      },
      {
        href: "/drawer",
        label: "Drawer",
        icon: "drawer",
        needs: "payment.take",
      },
    ],
  },
  {
    label: "Stock",
    items: [
      {
        href: "/stock",
        label: "Stock",
        icon: "stock",
        needs: "stock.read",
        exact: true,
      },
      {
        href: "/stock/counts",
        label: "Counts",
        icon: "counts",
        needs: "stock.read",
      },
    ],
  },
  {
    label: "Insight",
    items: [
      {
        href: "/dashboard",
        label: "Dashboard",
        icon: "dashboard",
        needs: "report.operational",
      },
      {
        href: "/reports",
        label: "Reports",
        icon: "reports",
        needs: "report.operational",
      },
    ],
  },
  {
    label: "Setup",
    items: [
      {
        href: "/admin/users",
        label: "Staff",
        icon: "staff",
        needs: "admin.users",
      },
      {
        href: "/admin/branches",
        label: "Branches",
        icon: "branches",
        needs: "admin.settings",
      },
      {
        href: "/admin/clinic",
        label: "Clinic",
        icon: "clinic",
        needs: "admin.settings",
      },
      {
        href: "/admin/audit",
        label: "Audit",
        icon: "audit",
        needs: "audit.read",
      },
    ],
  },
];

/** Whether this path should light this item up. */
export function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}
