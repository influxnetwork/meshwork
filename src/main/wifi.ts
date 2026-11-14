/**
 * Wi-Fi survey: the current connection and nearby access points. On macOS a bundled helper
 * reads CoreWLAN (and asks for Location access, which macOS requires for network names); on
 * Windows the built-in `netsh wlan` commands are parsed.
 */
import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WifiLocation, WifiReport } from '@shared/types';
import { VendorDb } from '../scanner/analysis';
import { vendorDbPath } from './vendors';
import { isAppStoreBuild } from '../scanner/sandbox-net';
import { fromHelper, netshNeedsLocation, parseNetshInterface, parseNetshNetworks, type HelperReport } from './wifi-format';

/** The background helper app bundle (macOS). */
function helperBundle(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bin', 'MeshworkWiFi.app')
    : join(import.meta.dirname, '..', '..', 'resources', 'bin', 'mac', 'MeshworkWiFi.app');
}

/**
 * Runs the helper through Launch Services (`open`), so it is its own responsible process and
 * macOS attributes the Location prompt and permission to it, and returns what it printed.
 */
async function runHelper(command: 'scan' | 'authorize', timeoutMs: number): Promise<string> {
  const bundle = helperBundle();
  if (!existsSync(bundle)) throw new Error('The Wi-Fi component is missing from this build.');
  if (isAppStoreBuild()) {
    // A sandboxed app cannot hand its helper a file to write through Launch Services; the helper
    // runs as a child process instead, inheriting the app's sandbox and its Location access.
    return run(join(bundle, 'Contents', 'MacOS', 'meshwork-wifi'), [command], timeoutMs);
  }
  const dir = mkdtempSync(join(tmpdir(), 'wifi-'));
  const out = join(dir, 'out.json');
  try {
    const background = command === 'scan' ? ['-g'] : [];
    await run('/usr/bin/open', ['-W', '-n', ...background, '--stdout', out, '--stderr', '/dev/null', bundle, '--args', command], timeoutMs);
    return readFileSync(out, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) reject(err);
      else resolve(stdout);
    });
  });
}

// The table is reloaded when the vendor database moves or is rewritten by an update.
let vendors: { path: string; mtime: number; db: VendorDb } | undefined;
function vendorDb(): VendorDb {
  const path = vendorDbPath();
  const mtime = statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? 0;
  if (!vendors || vendors.path !== path || vendors.mtime !== mtime) vendors = { path, mtime, db: VendorDb.fromFile(path) };
  return vendors.db;
}

/** Access point maker from the BSSID; randomised or locally administered BSSIDs have none. */
function vendorOf(bssid: string | undefined): string | undefined {
  const v = bssid ? vendorDb().lookup(bssid) : undefined;
  return v && v !== 'Private address' ? v : undefined;
}

async function scanMac(): Promise<WifiReport> {
  const parsed = fromHelper(JSON.parse(await runHelper('scan', 25_000)) as HelperReport);
  return { platform: 'darwin', scannedAt: new Date().toISOString(), ...parsed };
}

async function scanWindows(): Promise<WifiReport> {
  const [ifaceOut, netsOut] = await Promise.all([
    run('netsh', ['wlan', 'show', 'interfaces'], 10_000).catch(() => ''),
    run('netsh', ['wlan', 'show', 'networks', 'mode=bssid'], 15_000).catch(() => ''),
  ]);
  const needsLocation = netshNeedsLocation(ifaceOut) || netshNeedsLocation(netsOut);
  const connection = parseNetshInterface(ifaceOut);
  const networks = parseNetshNetworks(netsOut);
  return {
    platform: 'win32',
    scannedAt: new Date().toISOString(),
    location: needsLocation ? 'denied' : 'not-required',
    poweredOn: !!connection || networks.length > 0,
    connection,
    networks,
    error: !ifaceOut && !netsOut ? 'No Wi-Fi adapter was found.' : undefined,
  };
}

export async function wifiScan(): Promise<WifiReport> {
  const report: WifiReport =
    process.platform === 'darwin'
      ? await scanMac()
      : process.platform === 'win32'
        ? await scanWindows()
        : {
            platform: process.platform,
            scannedAt: new Date().toISOString(),
            location: 'not-required',
            poweredOn: false,
            networks: [],
            error: 'Wi-Fi survey is available on macOS and Windows.',
          };
  if (report.connection) report.connection.vendor = vendorOf(report.connection.bssid);
  for (const n of report.networks) n.vendor = vendorOf(n.bssid);
  return report;
}

/** Asks for Location access (macOS shows its prompt) and returns the resulting state. */
export async function wifiAuthorize(): Promise<WifiLocation> {
  if (process.platform !== 'darwin') {
    await wifiOpenLocationSettings();
    return 'unknown';
  }
  const out = await runHelper('authorize', 130_000);
  const { location } = JSON.parse(out) as { location: string };
  return (['authorized', 'denied', 'restricted', 'not-determined'].includes(location) ? location : 'unknown') as WifiLocation;
}

export function wifiOpenLocationSettings(): Promise<void> {
  return shell.openExternal(
    process.platform === 'win32'
      ? 'ms-settings:privacy-location'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices',
  );
}
