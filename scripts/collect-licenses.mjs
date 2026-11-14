// Collects the licence of every third-party package bundled into the app (the packages our source
// imports, plus everything they depend on) into resources/licenses/THIRD_PARTY_LICENSES.txt, which
// is packaged with the app and opened from Help → Acknowledgements.
// Fails when a package has a licence outside the allow list, so nothing incompatible ships unnoticed.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

const root = join(import.meta.dirname, '..');

/** Packages our code imports directly (renderer, main, preload and stylesheets), plus bundled data. */
const ROOTS = [
  '@fontsource-variable/inter',
  '@fontsource-variable/jetbrains-mono',
  '@radix-ui/react-dialog',
  '@xyflow/react',
  'dns-packet',
  'html-to-image',
  'lucide-react',
  'net-snmp',
  'react',
  'react-dom',
  'tailwindcss',
  'zustand',
];

/** Licences that allow commercial use and only ask for the notice to be kept. */
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'OFL-1.1', 'CC0-1.0', 'Unlicense', 'BlueOak-1.0.0', 'Python-2.0']);

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** Directory of an installed package, searched from `fromDir` up through its node_modules folders. */
function locate(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    // pnpm keeps a package's dependencies next to it, in the node_modules folder that holds it.
    if (dir.endsWith(`${sep}node_modules`)) {
      const sibling = join(dir, name);
      if (existsSync(join(sibling, 'package.json'))) return realpathSync(sibling);
    }
    const nested = join(dir, 'node_modules', name);
    if (existsSync(join(nested, 'package.json'))) return realpathSync(nested);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The node_modules folder that holds a (possibly scoped) package directory. */
function storeOf(pkgDir, name) {
  return name.startsWith('@') ? dirname(dirname(pkgDir)) : dirname(pkgDir);
}

function licenceId(pkg) {
  const raw = pkg.license ?? (Array.isArray(pkg.licenses) ? pkg.licenses.map((l) => l.type ?? l).join(' OR ') : undefined);
  return typeof raw === 'object' && raw ? raw.type : raw;
}

/** True when an SPDX expression is allowed: any alternative of an OR, every part of an AND. */
function allowed(id) {
  if (!id) return false;
  const parts = id.replace(/[()]/g, '').split(/\s+(?:OR|AND)\s+/);
  return id.includes(' OR ') ? parts.some((p) => ALLOWED.has(p)) : parts.every((p) => ALLOWED.has(p));
}

/** Standard licence texts, used when a package declares a licence but ships no licence file. */
const TEMPLATES = {
  MIT: (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  ISC: (holder) => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`,
};

function holderOf(pkg) {
  const a = pkg.author;
  const name = typeof a === 'string' ? a.replace(/\s*[<(].*$/, '') : a?.name;
  return name?.trim() || `the ${pkg.name} authors`;
}

const seen = new Map();
const missing = [];
const queue = ROOTS.map((name) => ({ name, from: root }));
while (queue.length) {
  const { name, from } = queue.shift();
  const dir = locate(name, from);
  if (!dir) {
    missing.push(name);
    continue;
  }
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const key = `${pkg.name}@${pkg.version}`;
  if (seen.has(key)) continue;
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  seen.set(key, {
    name: pkg.name,
    version: pkg.version,
    licence: licenceId(pkg),
    repository: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url,
    text: file ? readFileSync(join(dir, file), 'utf8').trim() : undefined,
    holder: holderOf(pkg),
  });
  for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: storeOf(dir, pkg.name) });
}

if (missing.length) {
  console.error(`licenses: could not find installed packages: ${missing.join(', ')}`);
  process.exit(1);
}
const entries = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
const refused = entries.filter((e) => !allowed(e.licence));
if (refused.length) {
  console.error('licenses: these packages use a licence outside the allow list:');
  for (const e of refused) console.error(`  ${e.name}@${e.version}: ${e.licence ?? 'unknown'}`);
  process.exit(1);
}

const rule = '-'.repeat(78);
const lines = [
  'Meshwork includes the following third-party software.',
  'Each component is used under the licence shown; its full licence text follows.',
  'The Electron and Chromium licences are in LICENSE.electron.txt and LICENSES.chromium.html.',
  '',
  ...entries.map((e) => `  ${`${e.name}@${e.version}`.padEnd(52)} ${e.licence}`),
  '',
];
for (const e of entries) {
  lines.push(rule, `${e.name}@${e.version}`, `License: ${e.licence}`);
  if (e.repository) lines.push(`Source: ${e.repository.replace(/^git\+/, '').replace(/\.git$/, '')}`);
  const template = TEMPLATES[e.licence];
  const fallback = template
    ? `${template(e.holder)}\n\n(Standard ${e.licence} text; the package declares this licence but ships no licence file.)`
    : `This package does not include a licence file; it is distributed under the ${e.licence} licence.`;
  lines.push('', e.text ?? fallback, '');
}

const outDir = join(root, 'resources', 'licenses');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'THIRD_PARTY_LICENSES.txt'), lines.join('\n'));
const counts = entries.reduce((m, e) => m.set(e.licence, (m.get(e.licence) ?? 0) + 1), new Map());
const noText = entries.filter((e) => !e.text).map((e) => e.name);
console.log(`licenses: ${entries.length} packages (${[...counts].map(([k, v]) => `${v} ${k}`).join(', ')})`);
if (noText.length) console.log(`licenses: no licence file shipped by ${noText.join(', ')}; the standard text of their declared licence is used`);
