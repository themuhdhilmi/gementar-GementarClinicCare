"use client";

import { type ReactNode } from "react";
import { DataTable } from "@/components/data-table";

/**
 * Every report is a table, and they all look the same on purpose.
 *
 * A report page whose columns move around between reports is one the
 * owner has to re-learn each time.
 *
 * This is a thin adapter over `DataTable` rather than a second table.
 * Two tables in one application drift — one of them gets the sticky
 * header, the other gets the tabular figures — and then the reports
 * look like a different product from the rest of the screens.
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
  return (
    <DataTable
      rows={rows}
      columns={columns.map((column) => ({
        key: column.key,
        header: column.label,
        numeric: column.numeric,
        cell: (row: T) => column.render(row),
      }))}
      // A report row is a sum, not a record: there is nothing to open,
      // and the rows have no identity beyond their position.
      rowKey={(_row, index) => String(index)}
      empty={empty}
      emptyHint="Nothing was stored for these dates at this branch."
    />
  );
}
