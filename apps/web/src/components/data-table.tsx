"use client";

import { type ReactNode } from "react";
import { EmptyState, Skeleton, cx } from "./ui";

export type Column<T> = {
  key: string;
  header: ReactNode;
  /** Right-aligned and tabular. Use it for anything you would add up. */
  numeric?: boolean;
  /** Stops the column shrinking a name into an ellipsis on a narrow screen. */
  width?: string;
  /** Hidden below the given breakpoint, for columns that are nice to have. */
  hideBelow?: "sm" | "md" | "lg";
  cell: (row: T, index: number) => ReactNode;
};

/**
 * The table most of this application is.
 *
 * Four things it does that a hand-rolled `<table>` in a page does not,
 * and each of them is a bug somebody would otherwise hit once per
 * screen:
 *
 * - **Numbers line up.** Right-aligned and tabular, because a column of
 *   figures that does not line up cannot be compared, which is the only
 *   reason to put it in a column.
 * - **The header stays.** A clinic's patient list is two hundred rows
 *   and the person reading row 150 still needs to know what column four
 *   is.
 * - **Empty, loading and full are all drawn.** A table that renders a
 *   blank rectangle when it has nothing is indistinguishable from one
 *   that failed.
 * - **Rows are only interactive when they lead somewhere**, and then
 *   they are reachable by keyboard rather than being a `div` with an
 *   `onClick`.
 */
export function DataTable<T>({
  rows,
  columns,
  loading = false,
  empty = "Nothing here",
  emptyHint,
  onRowClick,
  rowKey,
  rowTone,
  dense = false,
  caption,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  loading?: boolean;
  empty?: string;
  emptyHint?: ReactNode;
  onRowClick?: (row: T) => void;
  rowKey: (row: T, index: number) => string;
  /** A tint for a row that needs one — overdue, cancelled, urgent. */
  rowTone?: (row: T) => "primary" | "warning" | "danger" | "muted" | undefined;
  dense?: boolean;
  caption?: string;
}) {
  const pad = dense ? "px-3 py-1.5" : "px-4 py-2.5";
  const hide = {
    sm: "hidden sm:table-cell",
    md: "hidden md:table-cell",
    lg: "hidden lg:table-cell",
  };
  const tones = {
    primary: "bg-primary-soft",
    warning: "bg-warning-soft/40",
    danger: "bg-danger-soft/40",
    muted: "text-muted",
  };

  if (loading) {
    return (
      <div className="overflow-hidden rounded-xl border border-line bg-surface shadow-e1">
        <div className="border-b border-line bg-surface-sunken px-4 py-2.5">
          <Skeleton className="h-3 w-40" />
        </div>
        <div className="divide-y divide-line">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (rows.length === 0) {
    return <EmptyState title={empty}>{emptyHint}</EmptyState>;
  }

  return (
    <div className="scroll-slim overflow-x-auto rounded-xl border border-line bg-surface shadow-e1">
      <table className="w-full border-collapse text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line bg-surface-sunken">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cx(
                  "sticky top-0 z-10 bg-surface-sunken text-[11px] font-semibold uppercase tracking-[0.08em] text-muted",
                  pad,
                  column.numeric ? "text-right" : "text-left",
                  column.hideBelow && hide[column.hideBelow],
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, index) => {
            const tone = rowTone?.(row);
            const clickable = Boolean(onRowClick);
            return (
              <tr
                key={rowKey(row, index)}
                onClick={clickable ? () => onRowClick?.(row) : undefined}
                onKeyDown={
                  clickable
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowClick?.(row);
                        }
                      }
                    : undefined
                }
                tabIndex={clickable ? 0 : undefined}
                role={clickable ? "button" : undefined}
                className={cx(
                  tone && tones[tone],
                  clickable &&
                    "cursor-pointer hover:bg-surface-muted focus-visible:bg-surface-muted",
                )}
              >
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={cx(
                      pad,
                      column.numeric && "text-right tabular-nums",
                      column.hideBelow && hide[column.hideBelow],
                    )}
                  >
                    {column.cell(row, index)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Two lines in one cell: the thing, and what qualifies it.
 *
 * A patient's name over their MRN, a product over its SKU. It keeps a
 * table to five columns instead of nine, which is the difference
 * between one that fits and one that scrolls sideways.
 */
export function Cell({
  primary,
  secondary,
  className,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="truncate font-medium">{primary}</div>
      {secondary !== undefined && secondary !== null && secondary !== "" && (
        <div className="truncate text-[13px] text-muted">{secondary}</div>
      )}
    </div>
  );
}
