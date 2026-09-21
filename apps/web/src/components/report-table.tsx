"use client";

import { type ReactNode } from "react";
import { EmptyState } from "@/components/ui";

/**
 * Every report is a table, and they all look the same on purpose.
 *
 * A report page whose columns move around between reports is one the
 * owner has to re-learn each time. Sticky header, right-aligned numbers,
 * nothing clever.
 */
export function ReportTable<T>({
  rows,
  columns,
  empty = "Nothing in this period",
}: {
  rows: T[];
  columns: Array<{
    key: string;
    label: string;
    numeric?: boolean;
    render: (row: T) => ReactNode;
  }>;
  empty?: string;
}) {
  if (rows.length === 0) return <EmptyState title={empty} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="sticky top-0 border-b border-line bg-surface text-left text-xs uppercase tracking-wide text-muted">
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                className={`px-4 py-2.5 font-medium ${column.numeric ? "text-right" : ""}`}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row, index) => (
            <tr key={index}>
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`px-4 py-2.5 ${column.numeric ? "text-right tabular-nums" : ""}`}
                >
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
