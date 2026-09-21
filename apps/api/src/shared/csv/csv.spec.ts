import { describe, expect, it } from 'vitest';
import { CSV_BOM, csvCell, csvRow, toCsv } from './csv.js';

describe('csvCell', () => {
  it('leaves ordinary text alone', () => {
    expect(csvCell('Siti binti Ahmad')).toBe('Siti binti Ahmad');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(4500n)).toBe('4500');
  });

  it('is empty for nothing, and empty is not "null"', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('quotes a comma, a quote and a newline', () => {
    expect(csvCell('Jalan Ampang, Kuala Lumpur')).toBe(
      '"Jalan Ampang, Kuala Lumpur"',
    );
    expect(csvCell('she said "no"')).toBe('"she said ""no"""');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
  });

  it('defuses anything a spreadsheet would run', () => {
    // The real one: typed into a cancellation reason, opened by the owner.
    expect(csvCell("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    for (const start of ['=', '+', '-', '@']) {
      expect(csvCell(`${start}SUM(A1)`)).toBe(`'${start}SUM(A1)`);
    }
    // A quote and a formula together: defused first, then quoted.
    expect(csvCell('=HYPERLINK("http://x")')).toBe(
      '"\'=HYPERLINK(""http://x"")"',
    );
    // A negative number is the awkward case: it starts with `-` and is
    // data. It is still quoted as text, which is the safe direction —
    // a number read as text is visible; a formula run is not.
    expect(csvCell(-45)).toBe("'-45");
  });

  it('writes a whole file with a BOM and CRLF', () => {
    const csv = toCsv(
      ['name', 'total'],
      [
        ['Ali', 4500n],
        ['Siti, A', -1],
      ],
    );
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')[1]).toBe('Ali,4500');
    expect(csv.split('\r\n')[2]).toBe('"Siti, A",\'-1');
  });

  it('csvRow and toCsv agree', () => {
    expect(toCsv(['a'], [['b']])).toBe(
      `${CSV_BOM}${csvRow(['a'])}\r\n${csvRow(['b'])}`,
    );
  });
});
