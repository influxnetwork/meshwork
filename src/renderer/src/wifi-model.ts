/**
 * Pure state helpers for the WiFi page: merging successive scans into a list of recently seen
 * access points, per-network signal samples, signal display units and view options.
 */
import type { WifiNetwork } from '@shared/types';

export interface SignalSample {
  t: number; // epoch ms
  rssi: number;
}

/** An access point with the time it was first and last reported, and its recent signal. */
export interface SeenNetwork extends WifiNetwork {
  key: string;
  firstSeen: number;
  lastSeen: number;
  samples: SignalSample[];
}

export type SignalUnit = 'dbm' | 'percent';
export type SecurityFilter = 'all' | 'open' | 'secure';

export interface WifiOptions {
  /** Minutes a network stays listed after it stops appearing in scans; 0 lists only the last scan. */
  keepMinutes: number;
  unit: SignalUnit;
  /** Signal shown as 100% at or above this level (dBm). */
  fullDbm: number;
  /** Signal shown as 0% at or below this level (dBm). */
  emptyDbm: number;
}

export const DEFAULT_WIFI_OPTIONS: WifiOptions = { keepMinutes: 5, unit: 'dbm', fullDbm: -30, emptyDbm: -90 };
export const KEEP_CHOICES = [0, 1, 5, 15] as const;

/** Reads stored options, falling back to defaults for anything missing or out of range. */
export function readOptions(raw: string | null): WifiOptions {
  let parsed: Partial<WifiOptions> = {};
  try {
    parsed = raw ? (JSON.parse(raw) as Partial<WifiOptions>) : {};
  } catch {
    parsed = {};
  }
  const o = { ...DEFAULT_WIFI_OPTIONS, ...parsed };
  if (!(KEEP_CHOICES as readonly number[]).includes(o.keepMinutes)) o.keepMinutes = DEFAULT_WIFI_OPTIONS.keepMinutes;
  if (o.unit !== 'dbm' && o.unit !== 'percent') o.unit = 'dbm';
  if (!Number.isFinite(o.fullDbm) || !Number.isFinite(o.emptyDbm) || o.fullDbm <= o.emptyDbm) {
    o.fullDbm = DEFAULT_WIFI_OPTIONS.fullDbm;
    o.emptyDbm = DEFAULT_WIFI_OPTIONS.emptyDbm;
  }
  return o;
}

/**
 * Stable identity of an access point across scans. Without a BSSID (no Location access) there is
 * nothing stable to follow, so such entries only live for one scan.
 */
export function networkKey(n: WifiNetwork, index: number): string {
  return n.bssid ?? `scan:${n.ssid ?? ''}:${n.channel?.number ?? 0}:${index}`;
}

/**
 * Folds one scan into the list: reported networks are refreshed and get a signal sample; stable
 * networks missing from the scan stay for `keepMs` after they were last seen.
 */
export function mergeScan(prev: SeenNetwork[], scan: WifiNetwork[], now: number, keepMs: number, historyMs: number): SeenNetwork[] {
  const byKey = new Map(prev.map((n) => [n.key, n]));
  const reported = new Set<string>();
  const next: SeenNetwork[] = [];
  scan.forEach((n, i) => {
    const key = networkKey(n, i);
    if (reported.has(key)) return;
    reported.add(key);
    const old = byKey.get(key);
    const samples = [...(old?.samples ?? []).filter((s) => now - s.t < historyMs), { t: now, rssi: n.rssi }];
    next.push({ ...n, key, firstSeen: old?.firstSeen ?? now, lastSeen: now, samples });
  });
  for (const old of prev) {
    if (reported.has(old.key) || old.key.startsWith('scan:')) continue;
    if (now - old.lastSeen <= keepMs) next.push({ ...old, samples: old.samples.filter((s) => now - s.t < historyMs) });
  }
  return next;
}

/** Signal as 0–100 on the configured scale. */
export function signalPercent(rssi: number, o: Pick<WifiOptions, 'fullDbm' | 'emptyDbm'>): number {
  const pct = ((rssi - o.emptyDbm) / (o.fullDbm - o.emptyDbm)) * 100;
  return Math.round(Math.max(0, Math.min(100, pct)));
}

export function formatSignal(rssi: number, o: WifiOptions): string {
  return o.unit === 'percent' ? `${signalPercent(rssi, o)}%` : `${rssi} dBm`;
}

/** 802.11 modes from oldest to newest, e.g. "a/n/ac/ax". */
export function modeLabel(phy: string[]): string {
  return phy.length ? [...phy].reverse().join('/') : '—';
}

export function matchesSecurity(n: WifiNetwork, filter: SecurityFilter): boolean {
  if (filter === 'all') return true;
  const top = n.security[0];
  if (filter === 'open') return top === 'Open';
  return !!top && top !== 'Open';
}

/** "now", "40 s ago", "3 min ago". */
export function ago(t: number, now: number): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 10) return 'now';
  if (s < 60) return `${s} s ago`;
  return `${Math.floor(s / 60)} min ago`;
}
