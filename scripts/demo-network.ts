/**
 * Writes a fictional facility network into an inventory database, for screenshots and demos:
 * a router, two managed switches with VLANs and PoE, access points, cameras, servers and clients.
 * Every name, address and MAC address here is invented.
 *
 * Usage: npx tsx --tsconfig tsconfig.node.json scripts/demo-network.ts <user-data-dir>
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Inventory } from '../src/main/inventory';
import type { DeviceType, DiscoveredHost, GearDevice, GearInterface, OpenPort } from '../src/shared/types';

const dir = process.argv[2];
if (!dir) throw new Error('Pass the user data folder to write into.');
mkdirSync(dir, { recursive: true });

interface Spec {
  ip: string;
  name: string;
  type: DeviceType;
  vendor: string;
  os?: string;
  ports?: OpenPort[];
  /** Where a switch learned the device: switch ip, port index, VLAN. */
  at?: [string, number, number];
  poeWatts?: number;
}

const web: OpenPort[] = [{ port: 80, service: 'http' }, { port: 443, service: 'https' }];
const ssh: OpenPort = { port: 22, service: 'ssh' };
const rtsp: OpenPort = { port: 554, service: 'rtsp' };

const ROUTER = '10.20.0.1';
const CORE = '10.20.0.2';
const FLOOR = '10.20.0.3';

const specs: Spec[] = [
  { ip: ROUTER, name: 'edge-gw', type: 'router', vendor: 'Juniper Networks', os: 'JunOS', ports: [ssh, ...web, { port: 161, service: 'snmp' }] },
  { ip: CORE, name: 'sw-core-01', type: 'switch', vendor: 'Cisco Systems, Inc', ports: [ssh, ...web], at: [CORE, 0, 1] },
  { ip: FLOOR, name: 'sw-floor2', type: 'switch', vendor: 'Hewlett Packard Enterprise', ports: [ssh, ...web], at: [CORE, 2, 1] },
  { ip: '10.20.0.11', name: 'ap-lobby', type: 'ap', vendor: 'Ubiquiti Inc.', ports: [ssh, ...web], at: [CORE, 3, 1], poeWatts: 9.8 },
  { ip: '10.20.0.12', name: 'ap-floor1', type: 'ap', vendor: 'Ubiquiti Inc.', ports: [ssh, ...web], at: [CORE, 4, 1], poeWatts: 11.2 },
  { ip: '10.20.0.13', name: 'ap-floor2', type: 'ap', vendor: 'Ubiquiti Inc.', ports: [ssh, ...web], at: [FLOOR, 16, 1], poeWatts: 10.4 },
  { ip: '10.20.0.21', name: 'cam-entrance', type: 'camera', vendor: 'Axis Communications AB', ports: [...web, rtsp], at: [CORE, 6, 20], poeWatts: 5.1 },
  { ip: '10.20.0.22', name: 'cam-reception', type: 'camera', vendor: 'Axis Communications AB', ports: [...web, rtsp], at: [CORE, 7, 20], poeWatts: 4.8 },
  { ip: '10.20.0.23', name: 'cam-parking-n', type: 'camera', vendor: 'Hanwha Vision Co., Ltd.', ports: [...web, rtsp], at: [CORE, 8, 20], poeWatts: 6.3 },
  { ip: '10.20.0.24', name: 'cam-parking-s', type: 'camera', vendor: 'Hanwha Vision Co., Ltd.', ports: [...web, rtsp], at: [CORE, 9, 20], poeWatts: 6.1 },
  { ip: '10.20.0.25', name: 'cam-warehouse', type: 'camera', vendor: 'Axis Communications AB', ports: [...web, rtsp], at: [CORE, 10, 20], poeWatts: 7.4 },
  { ip: '10.20.0.26', name: 'cam-loading', type: 'camera', vendor: 'Axis Communications AB', ports: [...web, rtsp, { port: 23, service: 'telnet' }], at: [CORE, 11, 20], poeWatts: 7.0 },
  { ip: '10.20.0.31', name: 'nas-01', type: 'storage', vendor: 'Synology Incorporated', os: 'Linux', ports: [ssh, ...web, { port: 445, service: 'smb' }], at: [CORE, 12, 10] },
  { ip: '10.20.0.32', name: 'srv-apps', type: 'server', vendor: 'Dell Inc.', os: 'Linux', ports: [ssh, ...web], at: [CORE, 13, 10] },
  { ip: '10.20.0.33', name: 'nvr-01', type: 'server', vendor: 'Dell Inc.', os: 'Windows', ports: [...web, { port: 3389, service: 'rdp' }], at: [CORE, 14, 20] },
  { ip: '10.20.0.41', name: 'printer-office', type: 'printer', vendor: 'HP Inc.', ports: [...web, { port: 9100, service: 'jetdirect' }], at: [CORE, 15, 10] },
  { ip: '10.20.0.42', name: 'printer-floor2', type: 'printer', vendor: 'Brother Industries, Ltd.', ports: [...web, { port: 9100, service: 'jetdirect' }], at: [FLOOR, 12, 10] },
  { ip: '10.20.0.51', name: 'reception-pc', type: 'computer', vendor: 'Dell Inc.', os: 'Windows', ports: [{ port: 445, service: 'smb' }], at: [FLOOR, 2, 10] },
  { ip: '10.20.0.52', name: 'accounting-pc', type: 'computer', vendor: 'Dell Inc.', os: 'Windows', ports: [{ port: 445, service: 'smb' }], at: [FLOOR, 3, 10] },
  { ip: '10.20.0.53', name: 'design-mac', type: 'computer', vendor: 'Apple, Inc.', os: 'macOS', ports: [ssh], at: [FLOOR, 4, 10] },
  { ip: '10.20.0.54', name: 'manager-pc', type: 'computer', vendor: 'Lenovo', os: 'Windows', ports: [], at: [FLOOR, 5, 10] },
  { ip: '10.20.0.61', name: 'phone-101', type: 'phone', vendor: 'Yealink Network Technology', ports: web, at: [FLOOR, 7, 10], poeWatts: 3.2 },
  { ip: '10.20.0.62', name: 'phone-102', type: 'phone', vendor: 'Yealink Network Technology', ports: web, at: [FLOOR, 8, 10], poeWatts: 3.1 },
  { ip: '10.20.0.63', name: 'phone-103', type: 'phone', vendor: 'Yealink Network Technology', ports: web, at: [FLOOR, 9, 10], poeWatts: 3.4 },
  { ip: '10.20.0.71', name: 'meeting-room-tv', type: 'tv', vendor: 'Samsung Electronics Co.,Ltd', ports: [{ port: 8001, service: 'http-alt' }], at: [FLOOR, 13, 10] },
  { ip: '10.20.0.81', name: 'hvac-controller', type: 'iot', vendor: 'Honeywell', ports: web, at: [CORE, 16, 10] },
  { ip: '10.20.0.101', name: 'laptop-sales-1', type: 'laptop', vendor: 'Apple, Inc.', os: 'macOS', at: [CORE, 3, 10] },
  { ip: '10.20.0.102', name: 'laptop-sales-2', type: 'laptop', vendor: 'Lenovo', os: 'Windows', at: [CORE, 4, 10] },
  { ip: '10.20.0.103', name: 'laptop-ops', type: 'laptop', vendor: 'Dell Inc.', os: 'Windows', at: [CORE, 4, 10] },
  { ip: '10.20.0.104', name: 'tablet-front-desk', type: 'tablet', vendor: 'Apple, Inc.', at: [CORE, 3, 30] },
  { ip: '10.20.0.105', name: 'phone-guest', type: 'phone', vendor: 'Samsung Electronics Co.,Ltd', at: [FLOOR, 16, 30] },
  { ip: '10.20.0.106', name: 'laptop-engineering', type: 'laptop', vendor: 'Apple, Inc.', os: 'macOS', at: [FLOOR, 16, 10] },
];

/** The bundled IEEE table: 24-bit prefixes (6 hex digits) and longer blocks to vendor names. */
const OUI: Record<string, string> = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'resources', 'data', 'oui.json'), 'utf8'));

/**
 * A 24-bit prefix registered to `vendor` in the bundled IEEE table, so the MAC address and the
 * vendor shown next to it agree. Matches the registered name case-insensitively, first exactly,
 * then by its first two words. Throws when the table has no assignment for the vendor.
 */
function ouiFor(vendor: string): { prefix: string; name: string } {
  const entries = Object.entries(OUI).filter(([k]) => k.length === 6);
  const want = vendor.toLowerCase();
  const words = want.split(/[\s,.]+/).filter(Boolean).slice(0, 2).join(' ');
  const hit = entries.find(([, v]) => v.toLowerCase() === want) ?? entries.find(([, v]) => v.toLowerCase().includes(words));
  if (!hit) throw new Error(`no IEEE assignment for ${vendor}`);
  return { prefix: hit[0], name: hit[1] };
}

/** A stable, invented MAC address per device: a real prefix of its vendor and an invented tail. */
function macFor(i: number, prefix: string): string {
  const b = [0, 2, 4].map((o) => Number.parseInt(prefix.slice(o, o + 2), 16));
  b.push(0x40 + Math.floor(i / 16), (i * 37) & 0xff, (i * 91 + 17) & 0xff);
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':');
}

const ouis = new Map(specs.map((s) => [s.ip, ouiFor(s.vendor)]));
const macs = new Map(specs.map((s, i) => [s.ip, macFor(i + 1, (ouis.get(s.ip) as { prefix: string }).prefix)]));
const mac = (ip: string) => macs.get(ip) as string;

const hosts: DiscoveredHost[] = specs.map((s) => ({
  ip: s.ip,
  mac: mac(s.ip),
  vendor: (ouis.get(s.ip) as { name: string }).name,
  hostname: `${s.name}.demo.lan`,
  names: [{ source: 'dns', name: `${s.name}.demo.lan` }],
  aliveVia: ['arp', 'icmp'],
  rttMs: 1 + (Number(s.ip.split('.')[3]) % 7),
  ports: s.ports ?? [],
  type: s.type,
  typeConfidence: 0.9,
  os: s.os,
  osConfidence: s.os ? 0.8 : undefined,
  evidence: [`Answers on ${(s.ports ?? []).map((p) => p.service).join(', ') || 'ARP only'}`],
  risks: s.ports?.some((p) => p.port === 23)
    ? [{ ruleId: 'telnet-open', severity: 'high', title: 'Telnet is open', detail: 'Logins travel unencrypted. Turn Telnet off and use SSH.' }]
    : [],
}));

const VLANS = [
  { id: 1, name: 'Default' },
  { id: 10, name: 'Staff' },
  { id: 20, name: 'Cameras' },
  { id: 30, name: 'Guest' },
];

function switchPorts(ip: string, count: number, uplinks: Record<number, number[]>): GearInterface[] {
  return Array.from({ length: count }, (_, i) => {
    const port = i + 1;
    const onPort = specs.filter((s) => s.at?.[0] === ip && s.at[1] === port);
    const powered = onPort.find((s) => s.poeWatts);
    const pvid = onPort[0]?.at?.[2] && !uplinks[port] ? onPort[0].at[2] : 1;
    return {
      ifIndex: port,
      name: `Gi1/0/${port}`,
      up: port in uplinks || onPort.length > 0,
      speedMbps: 1000,
      poe: !!powered,
      poeWatts: powered?.poeWatts,
      pvid,
      tagged: uplinks[port],
    };
  });
}

function fdb(ip: string) {
  return specs
    .filter((s) => s.at?.[0] === ip && s.ip !== ip)
    .map((s) => ({ mac: mac(s.ip), ifIndex: (s.at as [string, number, number])[1], vlan: (s.at as [string, number, number])[2] }));
}

const routerMac = mac(ROUTER);
const coreMac = mac(CORE);
const floorMac = mac(FLOOR);
/** Access points announce themselves over LLDP on the switch port they are plugged into. */
const ap = (port: number, ip: string, name: string) => ({
  localIfIndex: port,
  localPort: `Gi1/0/${port}`,
  chassisMac: mac(ip),
  remotePort: 'eth0',
  sysName: name,
  sysDescr: 'Wireless access point',
  mgmtIp: ip,
});
const arp = specs.filter((s) => s.ip !== ROUTER).map((s) => ({ ip: s.ip, mac: mac(s.ip) }));

const devices: GearDevice[] = [
  {
    ip: ROUTER,
    sysName: 'edge-gw',
    sysDescr: 'Edge router',
    mac: routerMac,
    uptimeSec: 3_888_000,
    forwarding: true,
    defaultRoute: { nextHop: '203.0.113.1', ifIndex: 1 },
    addresses: [
      { ip: '203.0.113.10', prefix: 29, ifIndex: 1 },
      { ip: ROUTER, prefix: 24, ifIndex: 2 },
    ],
    interfaces: [
      { ifIndex: 1, name: 'ge-0/0/0', alias: 'Internet', up: true, speedMbps: 1000 },
      { ifIndex: 2, name: 'ge-0/0/1', alias: 'LAN', up: true, speedMbps: 1000, pvid: 1, tagged: [10, 20, 30] },
    ],
    neighbors: [{ localIfIndex: 2, localPort: 'ge-0/0/1', chassisMac: coreMac, remotePort: 'Gi1/0/1', sysName: 'sw-core-01', mgmtIp: CORE }],
    fdb: [],
    arp,
    vlans: VLANS,
  },
  {
    ip: CORE,
    sysName: 'sw-core-01',
    sysDescr: 'Managed switch, 24 ports, PoE+',
    mac: coreMac,
    uptimeSec: 2_592_000,
    interfaces: switchPorts(CORE, 24, { 1: [10, 20, 30], 2: [10, 20, 30], 3: [10, 30], 4: [10, 30] }),
    neighbors: [
      { localIfIndex: 1, localPort: 'Gi1/0/1', chassisMac: routerMac, remotePort: 'ge-0/0/1', sysName: 'edge-gw', mgmtIp: ROUTER },
      { localIfIndex: 2, localPort: 'Gi1/0/2', chassisMac: floorMac, remotePort: 'Gi1/0/1', sysName: 'sw-floor2', mgmtIp: FLOOR },
      ap(3, '10.20.0.11', 'ap-lobby'),
      ap(4, '10.20.0.12', 'ap-floor1'),
    ],
    fdb: [...fdb(CORE), { mac: routerMac, ifIndex: 1, vlan: 1 }],
    arp: [],
    vlans: VLANS,
    poe: { budgetW: 370, usedW: 58.5 },
  },
  {
    ip: FLOOR,
    sysName: 'sw-floor2',
    sysDescr: 'Managed switch, 16 ports, PoE',
    mac: floorMac,
    uptimeSec: 1_728_000,
    interfaces: switchPorts(FLOOR, 16, { 1: [10, 20, 30], 16: [10, 30] }),
    neighbors: [
      { localIfIndex: 1, localPort: 'Gi1/0/1', chassisMac: coreMac, remotePort: 'Gi1/0/2', sysName: 'sw-core-01', mgmtIp: CORE },
      ap(16, '10.20.0.13', 'ap-floor2'),
    ],
    fdb: [...fdb(FLOOR), { mac: coreMac, ifIndex: 1, vlan: 1 }, { mac: routerMac, ifIndex: 1, vlan: 1 }],
    arp: [],
    vlans: VLANS,
    poe: { budgetW: 195, usedW: 20.1 },
  },
];

const inventory = new Inventory(join(dir, 'inventory.db'));
const network = inventory.resolveNetwork({ fingerprint: `gw:${routerMac}`, cidr: '10.20.0.0/24', gatewayIp: ROUTER, gatewayMac: routerMac, local: true });
inventory.renameNetwork(network.id, 'Arctic Facility 7');
const runId = 'demo-run';
const finished = new Date();
const started = new Date(finished.getTime() - 94_000);
for (const h of hosts) inventory.upsert(h, runId, network.id);
inventory.recordRun({
  runId,
  networkId: network.id,
  targets: '10.20.0.0/24',
  startedAt: started.toISOString(),
  finishedAt: finished.toISOString(),
  status: 'done',
  scanned: 254,
  live: hosts.length,
  newAssets: hosts.length,
  openPorts: hosts.reduce((n, h) => n + h.ports.length, 0),
  risks: hosts.reduce((n, h) => n + h.risks.length, 0),
});
inventory.saveGearSnapshot({ networkId: network.id, collectedAt: finished.toISOString(), probed: 3, devices });
inventory.close();
console.log(`demo network: ${hosts.length} devices written to ${join(dir, 'inventory.db')}`);
