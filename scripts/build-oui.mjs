// Builds resources/data/oui.json, the vendor table that ships with the app:
// { "<hex prefix>": "Organisation name" } from the IEEE registration authority's public lists
// (MA-L 24-bit, MA-M 28-bit, MA-S and IAB 36-bit prefixes). Also writes oui.meta.json with the
// lists' publication date, so the app can tell when a downloaded copy is newer.
// Refresh the bundled copy with: pnpm data:oui
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const BASE = 'https://standards-oui.ieee.org/';
const LISTS = [
  { registry: 'MA-L', path: 'oui/oui.csv', digits: 6 },
  { registry: 'MA-M', path: 'oui28/mam.csv', digits: 7 },
  { registry: 'MA-S', path: 'oui36/oui36.csv', digits: 9 },
  { registry: 'IAB', path: 'iab/iab.csv', digits: 9 },
];
const out = join(import.meta.dirname, '..', 'resources', 'data', 'oui.json');

/** Rows of CSV fields; quoted fields may hold commas, doubled quotes and newlines. */
function parseCsv(text) {
  const rows = [];
  let row = [];
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
    } else if (c === '"') quoted = true;
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
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

const merged = {};
let published;
const counts = [];
for (const list of LISTS) {
  const res = await fetch(BASE + list.path, { headers: { 'user-agent': 'Meshwork build (vendor table)' } });
  if (!res.ok) throw new Error(`${list.registry}: the IEEE site answered ${res.status}`);
  if (list.registry === 'MA-L') published = res.headers.get('last-modified') ?? new Date().toUTCString();
  const shape = new RegExp(`^[0-9A-F]{${list.digits}}$`);
  let n = 0;
  for (const [, assignment, organisation] of parseCsv(await res.text()).slice(1)) {
    const prefix = assignment?.trim().toUpperCase();
    const name = organisation?.trim().replace(/\s+/g, ' ');
    if (!prefix || !shape.test(prefix) || !name || name.toLowerCase() === 'private') continue;
    merged[prefix] = name;
    n++;
  }
  if (list.registry === 'MA-L' && n < 30_000) throw new Error('the MA-L list looks incomplete');
  counts.push(`${n} ${list.registry}`);
}

const publishedAt = new Date(published).toISOString();
const version = `IEEE ${publishedAt.slice(0, 10)}`;
const prefixes = Object.keys(merged).length;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(merged));
writeFileSync(join(dirname(out), 'oui.meta.json'), JSON.stringify({ version, prefixes, publishedAt }, null, 2));
console.log(`oui.json: ${prefixes} prefixes, ${version} (${counts.join(', ')})`);
