import { parseDeviceModel } from './model';
import type { Observed } from './fingerprint/types';
import type { LivenessSource, NameSource, OpenPort } from './types';

/** Everything the drawer knows about one device, already in display words. */
export interface DeviceDetailsInput {
  name: string;
  ip?: string;
  mac?: string;
  vendor?: string;
  /** Type shown in the drawer. */
  type: string;
  /** Type the scan guessed, when it differs from the one shown. */
  scanType?: string;
  /** Confidence of the type (0..1). */
  confidence?: number;
  os?: string;
  /** Confidence of the OS guess (0..1). */
  osConfidence?: number;
  hostname?: string;
  names?: { source: NameSource; name: string }[];
  aliveVia?: LivenessSource[];
  rttMs?: number;
  ttl?: number;
  ports?: OpenPort[];
  evidence?: string[];
  /** Version of the fingerprint rules that chose the type. */
  fingerprint?: string;
  /** Evidence from the identify phase. */
  observed?: Observed;
  /** What the device reports over SNMP or announces over LLDP. */
  gear?: { source: 'snmp' | 'lldp'; name?: string; description?: string };
  connection?: { path: string; switchName?: string; switchPort?: string; vlan?: number; poeWatts?: number; confirmed: boolean };
  /** Where the map learned about a device that is not in the inventory. */
  note?: string;
}

const NAME_SOURCE: Record<NameSource, string> = { dns: 'DNS', mdns: 'mDNS', netbios: 'NetBIOS' };
const ALIVE: Record<LivenessSource, string> = { tcp: 'TCP', icmp: 'ping', arp: 'ARP' };

/**
 * Plain-text summary of a device for the clipboard: identity, how it was found, what it reports
 * about itself and where it is plugged in. Lines with nothing to say are left out.
 */
export function deviceDetailsText(d: DeviceDetailsInput): string {
  const lines: string[] = [];
  const row = (label: string, value: string | number | undefined) => {
    if (value !== undefined && value !== '') lines.push(`${label}: ${value}`);
  };
  row('Device', d.name);
  row('IP address', d.ip);
  row('MAC address', d.mac);
  row('Vendor', d.vendor);
  const confidence = d.confidence ? `${Math.round(d.confidence * 100)}% confidence` : '';
  row(
    'Type',
    d.scanType
      ? `${d.type} (the scan guessed ${d.scanType}${confidence ? `, ${confidence}` : ''})`
      : `${d.type}${confidence ? ` (${confidence})` : ''}`,
  );
  row('OS', d.os && (d.osConfidence ? `${d.os} (${Math.round(d.osConfidence * 100)}% confidence)` : d.os));
  row('Hostname', d.hostname);
  row('Names', d.names?.map((n) => `${n.name} (${NAME_SOURCE[n.source]})`).join(', '));
  const answered = d.aliveVia?.map((v) => ALIVE[v]).join(', ');
  if (answered) {
    const extra = [d.rttMs !== undefined ? `${d.rttMs} ms` : '', d.ttl !== undefined ? `TTL ${d.ttl}` : ''].filter(Boolean);
    row('Answered by', [answered, ...extra].join(', '));
  }
  if (d.ports)
    row('Open ports', d.ports.length ? d.ports.map((p) => (p.service ? `${p.port}/${p.service}` : String(p.port))).join(', ') : 'none found');
  if (d.gear) {
    const { model, firmware } = parseDeviceModel(d.gear.description);
    const via = d.gear.source === 'snmp' ? 'SNMP' : 'LLDP';
    row(`Name over ${via}`, d.gear.name);
    row('Model', model);
    row('Firmware', firmware);
    row(`Description over ${via}`, d.gear.description?.replace(/\s+/g, ' ').trim());
  }
  if (d.connection) {
    const c = d.connection;
    row('Connected to', c.switchName && c.switchPort ? `${c.switchName} port ${c.switchPort}` : undefined);
    row('VLAN', c.vlan);
    row('PoE', c.poeWatts !== undefined ? `${c.poeWatts} W` : undefined);
    row('Path', `${c.path}${c.confirmed ? '' : ' (assumed)'}`);
  }
  const o = d.observed;
  if (o) {
    row('Announces', o.services?.join(', '));
    const upnp = [o['upnp.deviceType']?.[0], o['upnp.manufacturer']?.[0], o['upnp.model']?.[0]].filter(Boolean).join(' · ');
    row('UPnP', upnp);
    row('ONVIF', o.onvif?.join(', '));
    row('Web page', [...(o['http.title'] ?? []), ...(o['http.server'] ?? [])].join(' · '));
    row('Certificate', o['tls.subject']?.join('; '));
    row('SSH', o.ssh?.join('; '));
  }
  if (d.evidence?.length) {
    lines.push('Why this type:');
    for (const e of d.evidence) lines.push(`- ${e}`);
  }
  row('Classified with', d.fingerprint);
  row('Note', d.note);
  return lines.join('\n');
}

/** Model and maker a device reports about itself: its UPnP description first, then ONVIF. */
export function reportedIdentity(o: Observed | undefined): { model?: string; manufacturer?: string; source: 'UPnP' | 'ONVIF' } | undefined {
  const model = o?.['upnp.model']?.[0];
  const manufacturer = o?.['upnp.manufacturer']?.[0];
  if (model || manufacturer) return { ...(model ? { model } : {}), ...(manufacturer ? { manufacturer } : {}), source: 'UPnP' };
  const hardware = o?.onvif?.find((v) => v.startsWith('hardware/'))?.slice('hardware/'.length);
  return hardware ? { model: hardware, source: 'ONVIF' } : undefined;
}
