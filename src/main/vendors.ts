/**
 * MAC vendor database: a copy ships with the app and a newer copy can be downloaded into the user
 * data folder, straight from the IEEE registration authority's public assignment lists (24-, 28-
 * and 36-bit blocks). The most recently published copy is the one the scanner uses.
 */
import { app, net } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VendorAutoCheck, VendorDbStatus, VendorDbUpdateResult } from '@shared/types';
import { IEEE_REGISTRIES, compareVersions, parseIeeeCsv } from './vendor-format';

const IEEE_BASE = 'https://standards-oui.ieee.org/';
/** The IEEE republishes its lists daily; the user picks how often the app looks (weekly by default). */
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS: Record<VendorAutoCheck, number> = { daily: DAY_MS, weekly: 7 * DAY_MS, monthly: 30 * DAY_MS, off: Infinity };
const AUTO_CHECK_VALUES = Object.keys(CHECK_EVERY_MS) as VendorAutoCheck[];
/** How often a running app re-evaluates whether a check is due. */
const DUE_POLL_MS = 60 * 60 * 1000;

interface Meta {
  version: string;
  prefixes: number;
  /** When the IEEE published the lists this copy was built from (HTTP Last-Modified). */
  publishedAt?: string;
  updatedAt?: string;
  lastCheckAt?: string;
}

function bundledDir(): string {
  // Packaged: Contents/Resources/data. Development: <repo>/resources/data, two levels above out/main.
  return app.isPackaged ? join(process.resourcesPath, 'data') : join(import.meta.dirname, '..', '..', 'resources', 'data');
}

function downloadedDir(): string {
  return join(app.getPath('userData'), 'data');
}

function readMeta(dir: string): Meta | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, 'oui.meta.json'), 'utf8')) as Meta;
  } catch {
    return undefined;
  }
}

function writeMeta(dir: string, meta: Meta) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'oui.meta.json'), JSON.stringify(meta, null, 2));
}

/** True when copy `a` is newer than copy `b`: by IEEE publication date, else by package version. */
function newer(a: Meta, b: Meta | undefined): boolean {
  if (!b) return true;
  if (a.publishedAt || b.publishedAt) return Date.parse(a.publishedAt ?? '') > Date.parse(b.publishedAt ?? '') || !b.publishedAt;
  return compareVersions(a.version, b.version) >= 0;
}

function prefsPath(): string {
  return join(downloadedDir(), 'vendor-prefs.json');
}

export function vendorAutoCheck(): VendorAutoCheck {
  try {
    const v = (JSON.parse(readFileSync(prefsPath(), 'utf8')) as { autoCheck?: string }).autoCheck;
    return AUTO_CHECK_VALUES.includes(v as VendorAutoCheck) ? (v as VendorAutoCheck) : 'weekly';
  } catch {
    return 'weekly';
  }
}

export function setVendorAutoCheck(every: unknown): VendorDbStatus {
  if (!AUTO_CHECK_VALUES.includes(every as VendorAutoCheck)) throw new Error('Unknown check interval.');
  mkdirSync(downloadedDir(), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify({ autoCheck: every }, null, 2));
  return vendorDbStatus();
}

/** Path of the vendor file the scanner should load. */
export function vendorDbPath(): string {
  const downloaded = readMeta(downloadedDir());
  const bundled = readMeta(bundledDir());
  if (downloaded?.updatedAt && existsSync(join(downloadedDir(), 'oui.json')) && newer(downloaded, bundled)) {
    return join(downloadedDir(), 'oui.json');
  }
  return join(bundledDir(), 'oui.json');
}

export function vendorDbStatus(): VendorDbStatus {
  const path = vendorDbPath();
  const downloaded = path.startsWith(downloadedDir());
  const meta = (downloaded ? readMeta(downloadedDir()) : readMeta(bundledDir())) ?? { version: 'unknown', prefixes: 0 };
  return {
    source: downloaded ? 'downloaded' : 'bundled',
    autoCheck: vendorAutoCheck(),
    version: meta.version,
    prefixes: meta.prefixes,
    updatedAt: downloaded ? meta.updatedAt : undefined,
    lastCheckAt: readMeta(downloadedDir())?.lastCheckAt,
  };
}

function recordCheck(now: string) {
  const dir = downloadedDir();
  const existing = readMeta(dir);
  writeMeta(dir, existing ? { ...existing, lastCheckAt: now } : { version: '0', prefixes: 0, lastCheckAt: now });
}

function fetchIeee(path: string, method: 'GET' | 'HEAD' = 'GET') {
  // The IEEE site turns away requests without a descriptive client name.
  return net.fetch(IEEE_BASE + path, { method, headers: { 'user-agent': `Meshwork/${app.getVersion()} (vendor database update)` } });
}

/** Version label of a copy built from lists published on `date`. */
export function ieeeVersion(date: string): string {
  return `IEEE ${new Date(date).toISOString().slice(0, 10)}`;
}

export async function updateVendorDb(): Promise<VendorDbUpdateResult> {
  const dir = downloadedDir();
  const current = vendorDbStatus();
  const currentMeta = current.source === 'downloaded' ? readMeta(dir) : readMeta(bundledDir());
  const now = new Date().toISOString();
  try {
    // The main list's publication date tells whether anything changed since this copy was built.
    const head = await fetchIeee(IEEE_REGISTRIES[0].path, 'HEAD');
    if (!head.ok) throw new Error(`the IEEE site answered ${head.status}`);
    const published = head.headers.get('last-modified') ?? now;
    if (currentMeta?.publishedAt && Date.parse(published) <= Date.parse(currentMeta.publishedAt)) {
      recordCheck(now);
      return { updated: false, status: vendorDbStatus(), message: `Vendor database is up to date (${current.version}).` };
    }

    const merged: Record<string, string> = {};
    const counts: string[] = [];
    for (const r of IEEE_REGISTRIES) {
      const res = await fetchIeee(r.path);
      if (!res.ok) throw new Error(`the ${r.registry} list answered ${res.status}`);
      const part = parseIeeeCsv(await res.text(), r.digits);
      const n = Object.keys(part).length;
      if (r.registry === 'MA-L' && n < 30_000) throw new Error('the downloaded list looks incomplete');
      Object.assign(merged, part);
      counts.push(`${n.toLocaleString()} ${r.registry}`);
    }
    const prefixes = Object.keys(merged).length;
    const added = prefixes - (currentMeta?.prefixes ?? 0);

    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, 'oui.json.tmp');
    writeFileSync(tmp, JSON.stringify(merged));
    renameSync(tmp, join(dir, 'oui.json'));
    const version = ieeeVersion(published);
    writeMeta(dir, { version, prefixes, publishedAt: new Date(published).toISOString(), updatedAt: now, lastCheckAt: now });
    return {
      updated: true,
      status: vendorDbStatus(),
      message: `Vendor database updated to ${version}: ${prefixes.toLocaleString()} assignments${added > 0 ? `, ${added.toLocaleString()} more than before` : ''} (${counts.join(', ')}).`,
    };
  } catch (err) {
    return { updated: false, status: current, message: `Could not update the vendor database: ${(err as Error).message}` };
  }
}

/**
 * Checks for newer IEEE lists in the background whenever the last check is older than the chosen
 * interval: shortly after start, then re-evaluated every hour while the app stays open.
 */
export function scheduleVendorDbCheck(onUpdated?: () => void) {
  let running = false;
  const checkIfDue = () => {
    const last = readMeta(downloadedDir())?.lastCheckAt;
    const every = CHECK_EVERY_MS[vendorAutoCheck()];
    if (running || every === Infinity || (last && Date.now() - Date.parse(last) < every)) return;
    running = true;
    void updateVendorDb()
      .then((r) => {
        if (r.updated) onUpdated?.();
      })
      .finally(() => {
        running = false;
      });
  };
  setTimeout(checkIfDue, 15_000);
  setInterval(checkIfDue, DUE_POLL_MS).unref();
}
