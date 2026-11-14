/**
 * Pure helpers for Wi-Fi data: normalising the macOS helper's JSON and parsing `netsh wlan`
 * output on Windows. Windows labels are localised, so values are recognised by their shape
 * (percentages, "802.11…", "GHz", MAC addresses) rather than by label text.
 */
import type { WifiBand, WifiChannel, WifiConnection, WifiLocation, WifiNetwork } from '@shared/types';

/** Wi-Fi generation from the newest supported PHY mode (4 = n, 5 = ac, 6 = ax, 7 = be). */
export function generationOf(phy: string[] | string | undefined): number | undefined {
  const modes = Array.isArray(phy) ? phy : phy ? [phy] : [];
  if (modes.includes('be')) return 7;
  if (modes.includes('ax')) return 6;
  if (modes.includes('ac')) return 5;
  if (modes.includes('n')) return 4;
  return undefined;
}

/** Band of a channel number when the platform does not report it. */
export function bandOfChannel(channel: number): WifiBand {
  if (channel >= 1 && channel <= 14) return '2.4';
  return '5';
}

/** Windows reports signal quality in percent; this is the usual linear mapping to dBm. */
export function percentToDbm(percent: number): number {
  return Math.round(Math.max(0, Math.min(100, percent)) / 2 - 100);
}

function normalizeBssid(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const parts = raw.trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/.test(p))) return undefined;
  return parts.map((p) => p.padStart(2, '0')).join(':');
}

// ---------------------------------------------------------------- macOS helper JSON

interface HelperChannel {
  number: number;
  band?: string | null;
  width?: number | null;
}

export interface HelperReport {
  location: string;
  connection?: {
    interface: string;
    poweredOn: boolean;
    ssid?: string | null;
    bssid?: string | null;
    rssi: number;
    noise: number;
    channel?: HelperChannel | null;
    txRateMbps: number;
    phy?: string | null;
    security?: string | null;
  } | null;
  networks: {
    ssid?: string | null;
    bssid?: string | null;
    rssi: number;
    noise: number;
    channel?: HelperChannel | null;
    security: string[];
    phy: string[];
  }[];
  error?: string | null;
}

function channelOf(c: HelperChannel | null | undefined): WifiChannel | undefined {
  if (!c || !c.number) return undefined;
  const band = c.band === '2.4' || c.band === '5' || c.band === '6' ? c.band : bandOfChannel(c.number);
  return { number: c.number, band, width: c.width ?? undefined };
}

const LOCATION: Record<string, WifiLocation> = {
  authorized: 'authorized',
  denied: 'denied',
  restricted: 'restricted',
  'not-determined': 'not-determined',
};

export function locationOf(raw: string | undefined): WifiLocation {
  return (raw && LOCATION[raw]) || 'unknown';
}

/** Converts the macOS helper's report into the app's shapes. */
export function fromHelper(report: HelperReport): {
  location: WifiLocation;
  poweredOn: boolean;
  connection?: WifiConnection;
  networks: WifiNetwork[];
  error?: string;
} {
  const c = report.connection;
  // The signal can read 0 while a scan is running; joined networks still report a channel.
  const connected = c && c.poweredOn && (c.ssid || c.bssid || c.channel?.number);
  const bssid = normalizeBssid(c?.bssid);
  const fromScan = report.networks.find((n) => bssid && normalizeBssid(n.bssid) === bssid)?.rssi;
  const rssi = c?.rssi || fromScan || 0;
  return {
    location: locationOf(report.location),
    poweredOn: !!c?.poweredOn,
    connection: connected
      ? {
          interface: c.interface,
          ssid: c.ssid ?? undefined,
          bssid,
          rssi,
          noise: c.noise || undefined,
          channel: channelOf(c.channel),
          txRateMbps: c.txRateMbps || undefined,
          phy: c.phy ?? undefined,
          generation: generationOf(c.phy ?? undefined),
          security: c.security ?? undefined,
        }
      : undefined,
    networks: report.networks.map((n) => ({
      ssid: n.ssid || undefined,
      bssid: normalizeBssid(n.bssid),
      rssi: n.rssi,
      noise: n.noise || undefined,
      channel: channelOf(n.channel),
      security: n.security,
      phy: n.phy,
      generation: generationOf(n.phy),
    })),
    error: report.error ?? undefined,
  };
}

// ---------------------------------------------------------------- Windows netsh

function keyValue(line: string): [string, string] | undefined {
  const m = /^\s*([^:]+?)\s*:\s(.*)$/.exec(line);
  return m ? [(m[1] as string).trim(), (m[2] as string).trim()] : undefined;
}

function radioPhy(value: string): string[] {
  const m = /802\.11(\w+)/i.exec(value);
  return m ? [(m[1] as string).toLowerCase()] : [];
}

function securityOf(auth: string | undefined): string[] {
  if (!auth) return [];
  const a = auth.toUpperCase();
  if (a.includes('WPA3')) return [a.includes('ENTERPRISE') ? 'WPA3 Enterprise' : 'WPA3'];
  if (a.includes('WPA2')) return [a.includes('ENTERPRISE') ? 'WPA2 Enterprise' : 'WPA2'];
  if (a.includes('WPA')) return ['WPA'];
  if (a.includes('OWE')) return ['OWE'];
  return ['Open'];
}

function bandOf(value: string): WifiBand {
  if (/2[.,]4/.test(value)) return '2.4';
  if (/^\s*6/.test(value)) return '6';
  return '5';
}

/** Parses `netsh wlan show networks mode=bssid`: one entry per access point (BSSID). */
export function parseNetshNetworks(out: string): WifiNetwork[] {
  const networks: WifiNetwork[] = [];
  let ssid: string | undefined;
  let auth: string | undefined;
  let current: WifiNetwork | undefined;
  let afterBand = false;
  const flush = () => {
    if (current?.channel?.number) {
      current.channel.band ??= bandOfChannel(current.channel.number);
      current.generation = generationOf(current.phy);
      networks.push(current);
    }
    current = undefined;
    afterBand = false;
  };
  for (const line of out.split(/\r?\n/)) {
    const kv = keyValue(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (/^SSID \d+$/i.test(key)) {
      flush();
      ssid = value || undefined;
      auth = undefined;
      continue;
    }
    if (/^BSSID \d+$/i.test(key)) {
      flush();
      current = { ssid, bssid: normalizeBssid(value), rssi: -100, security: securityOf(auth), phy: [] };
      continue;
    }
    if (!current) {
      // Network-level lines before the first BSSID: the authentication line names a WPA/open mode.
      if (!auth && /WPA|Open|Abierta|Ouvert|Offen|Aberta|OWE/i.test(value)) auth = value;
      continue;
    }
    const pct = /^(\d{1,3})\s*%$/.exec(value);
    if (pct && current.rssi === -100) current.rssi = percentToDbm(Number(pct[1]));
    else if (/^802\.11/i.test(value)) current.phy = radioPhy(value);
    else if (/GHz/i.test(value)) {
      current.channel = { number: current.channel?.number ?? 0, band: bandOf(value) };
      afterBand = true;
    } else if (/^\d{1,3}$/.test(value) && (afterBand || !current.channel)) {
      // The first plain number after the band line is the channel; later ones are load statistics.
      current.channel = { number: Number(value), band: current.channel?.band };
      afterBand = false;
    }
  }
  flush();
  return networks;
}

/** Parses `netsh wlan show interfaces`: the current connection, or undefined when not connected. */
export function parseNetshInterface(out: string): WifiConnection | undefined {
  let iface: string | undefined;
  let ssid: string | undefined;
  let bssid: string | undefined;
  let rssi: number | undefined;
  let phy: string | undefined;
  let security: string | undefined;
  let channel: WifiChannel | undefined;
  let afterBand = false;
  const rates: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    const kv = keyValue(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (/^SSID$/i.test(key)) ssid = value || undefined;
    else if (/^(AP )?BSSID$/i.test(key)) bssid = normalizeBssid(value);
    else if (!iface && /^(Name|Nombre|Nom)$/i.test(key)) iface = value;
    else if (/^\d{1,3}\s*%$/.test(value)) rssi = percentToDbm(Number.parseInt(value, 10));
    else if (/^802\.11/i.test(value)) phy = radioPhy(value)[0];
    else if (!security && /WPA|Open|Abierta|OWE/i.test(value)) security = securityOf(value)[0];
    else if (/GHz/i.test(value)) {
      channel = { number: 0, band: bandOf(value) };
      afterBand = true;
    } else if (/\(Mbps\)/i.test(key) && /^[\d.]+$/.test(value)) rates.push(Number(value));
    else if (afterBand && channel && /^\d{1,3}$/.test(value)) {
      channel.number = Number(value);
      afterBand = false;
    }
  }
  if (!ssid || rssi === undefined) return undefined;
  return {
    interface: iface ?? 'Wi-Fi',
    ssid,
    bssid,
    rssi,
    channel: channel?.number ? channel : undefined,
    txRateMbps: rates.length ? Math.max(...rates) : undefined,
    phy,
    generation: generationOf(phy),
    security,
  };
}

/** Windows 11 refuses WLAN details without Location access and says so in the command output. */
export function netshNeedsLocation(out: string): boolean {
  return /location permission|ms-settings:privacy-location/i.test(out);
}
