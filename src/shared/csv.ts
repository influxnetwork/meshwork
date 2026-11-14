/**
 * CSV for spreadsheets: fields are quoted when needed, and values a spreadsheet would read as a
 * formula are prefixed with an apostrophe. Lines end in CRLF.
 */
export function csvCell(raw: string): string {
  const v = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return /[",\n\r']/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
