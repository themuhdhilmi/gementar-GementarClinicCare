/**
 * The few icons the navigation needs, drawn rather than installed.
 *
 * An icon set is a dependency, a bundle and a licence for the sake of
 * sixteen glyphs. These are stroke icons on a 24 grid, sharing one set
 * of attributes so they sit on the same optical weight — which is the
 * thing that makes a sidebar look made rather than assembled.
 *
 * They are decoration: every one sits beside its own label, so they
 * carry `aria-hidden` and no title.
 */
export type IconName =
  | "home"
  | "dashboard"
  | "today"
  | "patients"
  | "pharmacy"
  | "procedures"
  | "billing"
  | "drawer"
  | "stock"
  | "counts"
  | "reports"
  | "staff"
  | "branches"
  | "clinic"
  | "audit"
  | "account"
  | "menu"
  | "close"
  | "search"
  | "plus"
  | "chevronRight"
  | "alert"
  | "display";

const PATHS: Record<IconName, string> = {
  home: "M3 10.5 12 3l9 7.5M5.5 9.5V20h13V9.5M9.5 20v-6h5v6",
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  today: "M4 6h16M4 12h16M4 18h10M17.5 16.5v3M16 18h3",
  patients:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3 20a6 6 0 0 1 12 0M17 11a3 3 0 1 0 0-6M18 20a5 5 0 0 0-2-4",
  pharmacy:
    "M8.5 3.5h7M12 3.5v4M6.5 11h11M7.5 7.5h9l1 12a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 6.5 19.5Z",
  procedures:
    "M5 4v6a3 3 0 0 0 6 0V4M8 13v7M8 20h8a3 3 0 0 0 3-3V9M19 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  billing: "M6 3h12v18l-3-2-3 2-3-2-3 2ZM9 8h6M9 12h6M9 16h3",
  drawer: "M3 8h18v11H3zM3 8l2-4h14l2 4M9 12h6",
  stock: "M3 7.5 12 3l9 4.5v9L12 21l-9-4.5ZM3 7.5 12 12l9-4.5M12 12v9",
  counts: "M8 4h8v3H8zM6 6h2M16 6h2v14H6V6M9 12l2 2 4-4",
  reports: "M4 20V4M4 20h16M8 17v-5M12 17V8M16 17v-8",
  staff:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM3 20a6 6 0 0 1 12 0M18 5.5v5M15.5 8h5",
  branches:
    "M4 21V6l7-3v18M11 21h9V10l-9-3M7 9v.01M7 13v.01M15 12v.01M15 16v.01",
  clinic:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z M19.5 12a7.5 7.5 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7.5 7.5 0 0 0-2-1.2l-.3-2.5h-4l-.3 2.5a7.5 7.5 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7.6 7.6 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7.5 7.5 0 0 0 2 1.2l.3 2.5h4l.3-2.5a7.5 7.5 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.07-.4.1-.8.1-1.2Z",
  audit:
    "M12 3l7.5 3v6c0 4.5-3 7.8-7.5 9-4.5-1.2-7.5-4.5-7.5-9V6ZM9 12l2 2 4-4",
  account: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4.5 20a7.5 7.5 0 0 1 15 0",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6 6 18",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14ZM20 20l-4-4",
  plus: "M12 5v14M5 12h14",
  chevronRight: "m9 6 6 6-6 6",
  alert:
    "M12 8v5M12 16.5v.01M10.3 3.9 2.6 17a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  display: "M3 5h18v11H3zM9 20h6M12 16v4",
};

export function Icon({
  name,
  className = "size-5",
}: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
