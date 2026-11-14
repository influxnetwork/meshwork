/** Pure helpers for reading and compacting MAC vendor registry downloads. */

/** Compares dotted numeric versions; returns > 0 when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The IEEE registration authority's public assignment lists. Larger vendors hold a 24-bit block
 * (MA-L); smaller and older ones hold 28-bit (MA-M) or 36-bit (MA-S, and the retired IAB) blocks.
 */
export const IEEE_REGISTRIES = [
  { registry: 'MA-L', path: 'oui/oui.csv', digits: 6 },
  { registry: 'MA-M', path: 'oui28/mam.csv', digits: 7 },
  { registry: 'MA-S', path: 'oui36/oui36.csv', digits: 9 },
  { registry: 'IAB', path: 'iab/iab.csv', digits: 9 },
] as const;

/** Splits CSV text into rows of fields; quoted fields may hold commas, doubled quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * Reads one IEEE assignment list (columns: Registry, Assignment, Organization Name, Address) into
 * "hex prefix -> organisation name". Prefixes are 6, 7 or 9 hex digits depending on the list.
 */
export function parseIeeeCsv(csv: string, digits: number): Record<string, string> {
  const out: Record<string, string> = {};
  const shape = new RegExp(`^[0-9A-F]{${digits}}$`);
  for (const [, assignment, organisation] of parseCsv(csv).slice(1)) {
    const prefix = assignment?.trim().toUpperCase();
    const name = organisation?.trim().replace(/\s+/g, ' ');
    if (!prefix || !shape.test(prefix) || !name || name.toLowerCase() === 'private') continue;
    out[prefix] = name;
  }
  return out;
}
