/**
 * CSV somebody opens in Excel.
 *
 * Two rules, and the second is the one that matters.
 *
 * RFC 4180 quoting, so a comma in a patient's address does not become a
 * new column. And a defence the RFC says nothing about: a cell starting
 * `=`, `+`, `-` or `@` is a **formula** to Excel, LibreOffice and Google
 * Sheets. Every file this system exports is full of strings a user
 * chose — a name, a reason somebody typed, a product description — so
 * `=cmd|'/c calc'!A1` in a free-text field is an attack on whoever opens
 * the export, carried out by the clinic's own spreadsheet. A leading
 * apostrophe makes it text and costs nothing.
 *
 * There is one implementation because two would mean one of them was
 * wrong and nobody would know which.
 */

/** UTF-8 byte order mark. Without it Excel reads Malay diacritics as mojibake. */
export const CSV_BOM = '﻿';

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'bigint'
        ? value.toString()
        : String(value);
  const defused = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(defused)
    ? `"${defused.replaceAll('"', '""')}"`
    : defused;
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(csvCell).join(',');
}

/** Header plus rows, CRLF as the RFC asks, with the BOM in front. */
export function toCsv(
  header: readonly string[],
  rows: Iterable<readonly unknown[]>,
): string {
  const lines = [csvRow(header)];
  for (const row of rows) lines.push(csvRow(row));
  return CSV_BOM + lines.join('\r\n');
}
