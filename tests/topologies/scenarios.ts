/**
 * Synthetic networks, one per kind of topology the map must draw correctly. Each holds what a scan
 * and an SNMP reading would give: the scanned network, its inventory and the managed devices.
 * Addresses are private (RFC 1918) or documentation ranges (RFC 5737), which stand for public ones.
 */
import type { Asset, DeviceType, GearDevice, GearNeighbor, Network } from '@shared/types';

export interface Scenario {
  id: string;
  title: string;
  network: Pick<Network, 'gatewayIp' | 'gatewayMac'> & { cidr?: string };
  assets: Asset[];
  devices: GearDevice[];
}

let seq = 0;
/** An inventory device as a scan stores it. */
export const asset = (ip: string, type: DeviceType = 'unknown', mac?: string): Asset => ({
  id: `a${++seq}`,
  networkId: 'n',
  firstSeen: '2026-01-01T00:00:00Z',
  lastSeen: '2026-01-01T00:00:00Z',
  lastRunId: 'r',
  isNew: false,
  ip,
  mac,
  names: [],
  aliveVia: ['icmp'],
  ports: [],
  type,
  typeConfidence: 0.9,
  evidence: [],
  risks: [],
});

interface GearSpec {
  /** Port name to "address/prefix"; ports are numbered in this order, from 1. */
  ports: Record<string, string | undefined>;
  /** Default route: next hop, and the port when the device publishes it. */
  route?: { nextHop: string; port?: string };
  routes?: boolean;
  switches?: boolean;
  mac?: string;
  /** Neighbours heard: local port, name, address, remote port. */
  hears?: [string, string, string, string][];
  /** Addresses learned: MAC, port. */
  learned?: [string, string][];
  blocking?: string[];
}

/** A managed device as an SNMP reading stores it. */
export function gear(ip: string, sysName: string, spec: GearSpec): GearDevice {
  const names = Object.keys(spec.ports);
  const index = (port: string) => names.indexOf(port) + 1;
  const neighbors: GearNeighbor[] = (spec.hears ?? []).map(([port, name, mgmtIp, remotePort]) => ({
    localIfIndex: index(port),
    localPort: port,
    sysName: name,
    chassisId: name,
    mgmtIp,
    remotePort,
    protocols: ['lldp'],
  }));
  return {
    ip,
    sysName,
    mac: spec.mac,
    interfaces: names.map((name) => ({ ifIndex: index(name), name, up: true, speedMbps: 1000, stp: spec.blocking?.includes(name) ? ('blocking' as const) : undefined })),
    neighbors,
    fdb: (spec.learned ?? []).map(([mac, port]) => ({ mac, ifIndex: index(port) })),
    arp: [],
    addresses: names.flatMap((name) => {
      const a = spec.ports[name];
      return a ? [{ ip: a.split('/')[0] as string, prefix: Number(a.split('/')[1]), ifIndex: index(name) }] : [];
    }),
    forwarding: spec.routes,
    bridgePorts: spec.switches ? names.length : undefined,
    defaultRoute: spec.route ? { nextHop: spec.route.nextHop, ifIndex: spec.route.port ? index(spec.route.port) : 0 } : undefined,
  };
}

const sw = (ip: string, name: string, uplink: [string, string, string], extra: Partial<GearSpec> = {}) =>
  gear(ip, name, { ports: { p1: undefined, p2: undefined, p3: undefined, Vlan1: `${ip}/24` }, switches: true, hears: [['p1', uplink[0], uplink[1], uplink[2]]], ...extra });

export const SCENARIOS: Scenario[] = [
  {
    id: 'flat',
    title: 'One router, one switch, everything in one network',
    network: { gatewayIp: '192.168.1.1', gatewayMac: 'aa:00:00:00:00:01', cidr: '192.168.1.0/24' },
    assets: [asset('192.168.1.1', 'router', 'aa:00:00:00:00:01'), asset('192.168.1.2', 'switch', 'aa:00:00:00:00:02'), asset('192.168.1.20', 'computer', 'aa:00:00:00:00:20')],
    devices: [
      gear('192.168.1.1', 'R1', { ports: { wan: '203.0.113.2/30', lan: '192.168.1.1/24' }, routes: true, route: { nextHop: '203.0.113.1', port: 'wan' }, hears: [['lan', 'SW1', '192.168.1.2', 'p1']] }),
      sw('192.168.1.2', 'SW1', ['R1', '192.168.1.1', 'lan'], { mac: 'aa:00:00:00:00:02', learned: [['aa:00:00:00:00:01', 'p1'], ['aa:00:00:00:00:20', 'p2']] }),
    ],
  },
  {
    id: 'stick',
    title: 'Router with VLAN subinterfaces on one trunk',
    network: { gatewayIp: '10.0.99.1', cidr: '10.0.99.0/24,10.0.10.0/24' },
    assets: [asset('10.0.99.1', 'router'), asset('10.0.99.2', 'switch'), asset('10.0.10.11', 'computer')],
    devices: [
      gear('10.0.99.1', 'R1', {
        ports: { 'Et0/0': '203.0.113.2/30', 'Et0/3': undefined, 'Et0/3.10': '10.0.10.1/24', 'Et0/3.99': '10.0.99.1/24' },
        routes: true,
        route: { nextHop: '203.0.113.1' },
        hears: [['Et0/3', 'SW1', '10.0.99.2', 'p1']],
      }),
      gear('10.0.99.2', 'SW1', { ports: { p1: undefined, p2: undefined, Vlan99: '10.0.99.2/24' }, switches: true, hears: [['p1', 'R1', '10.0.99.1', 'Et0/3']] }),
    ],
  },
  {
    id: 'core-firewall',
    title: 'Layer 3 core switch behind a firewall that is not managed',
    network: { gatewayIp: '10.0.10.1', cidr: '10.0.10.0/24,10.255.0.0/30' },
    assets: [asset('10.0.10.1', 'server'), asset('10.0.10.2', 'switch'), asset('10.255.0.1', 'firewall'), asset('10.0.10.30', 'computer')],
    devices: [
      gear('10.0.10.1', 'CORE', {
        ports: { 'Gi1/0/1': undefined, 'Gi1/0/48': '10.255.0.2/30', Vl10: '10.0.10.1/24', Vl20: '10.0.20.1/24' },
        routes: true,
        switches: true,
        route: { nextHop: '10.255.0.1' },
        hears: [['Gi1/0/1', 'ACC1', '10.0.10.2', 'p1']],
      }),
      gear('10.0.10.2', 'ACC1', { ports: { p1: undefined, p2: undefined, Vlan10: '10.0.10.2/24' }, switches: true, hears: [['p1', 'CORE', '10.0.10.1', 'Gi1/0/1']] }),
    ],
  },
  {
    id: 'virtual-gateway',
    title: 'Two routers sharing a virtual gateway address',
    network: { gatewayIp: '10.0.0.1', gatewayMac: '00:00:0c:07:ac:01', cidr: '10.0.0.0/24' },
    assets: [asset('10.0.0.1', 'router', '00:00:0c:07:ac:01'), asset('10.0.0.2', 'router', 'aa:00:00:00:01:02'), asset('10.0.0.3', 'router', 'aa:00:00:00:01:03'), asset('10.0.0.5', 'switch', 'aa:00:00:00:01:05')],
    devices: [
      gear('10.0.0.2', 'R1', { ports: { wan: '203.0.113.2/30', lan: '10.0.0.2/24' }, routes: true, route: { nextHop: '203.0.113.1' }, hears: [['lan', 'SW1', '10.0.0.5', 'p1']] }),
      gear('10.0.0.3', 'R2', { ports: { wan: '198.51.100.2/30', lan: '10.0.0.3/24' }, routes: true, route: { nextHop: '198.51.100.1' }, hears: [['lan', 'SW1', '10.0.0.5', 'p2']] }),
      gear('10.0.0.5', 'SW1', {
        ports: { p1: undefined, p2: undefined, p3: undefined, Vlan1: '10.0.0.5/24' },
        switches: true,
        mac: 'aa:00:00:00:01:05',
        hears: [['p1', 'R1', '10.0.0.2', 'lan'], ['p2', 'R2', '10.0.0.3', 'lan']],
      }),
    ],
  },
  {
    id: 'two-sites',
    title: 'Two sites joined by a private link, each with its own way out, scanned from outside',
    network: { cidr: '172.20.0.0/24,172.20.10.0/24,172.20.100.0/24,172.20.110.0/24' },
    assets: [asset('172.20.0.1', 'router'), asset('172.20.0.2', 'switch'), asset('172.20.10.11'), asset('172.20.100.1', 'router'), asset('172.20.100.2', 'switch'), asset('172.20.110.11')],
    devices: [
      gear('172.20.0.1', 'EDGE-A', {
        ports: { 'Et0/0': '203.0.113.2/30', 'Et0/1': '10.0.0.130/24', 'Et0/2': '10.255.0.1/30', 'Et0/3': undefined, 'Et0/3.99': '172.20.0.1/24', 'Et0/3.10': '172.20.10.1/24' },
        routes: true,
        route: { nextHop: '203.0.113.1' },
        hears: [['Et0/2', 'EDGE-B', '10.255.0.2', 'Et0/2'], ['Et0/3', 'SW-A', '172.20.0.2', 'Et0/0'], ['Et0/1', 'home-sw', '10.0.0.56', 'gi28']],
      }),
      gear('172.20.100.1', 'EDGE-B', {
        ports: { 'Et0/0': '198.51.100.2/30', 'Et0/2': '10.255.0.2/30', 'Et0/3': undefined, 'Et0/3.100': '172.20.100.1/24', 'Et0/3.110': '172.20.110.1/24' },
        routes: true,
        route: { nextHop: '198.51.100.1' },
        hears: [['Et0/2', 'EDGE-A', '10.255.0.1', 'Et0/2'], ['Et0/3', 'SW-B', '172.20.100.2', 'Et0/0']],
      }),
      gear('172.20.0.2', 'SW-A', { ports: { 'Et0/0': undefined, 'Et0/1': undefined, Vlan99: '172.20.0.2/24' }, switches: true, routes: true, route: { nextHop: '172.20.0.1' }, hears: [['Et0/0', 'EDGE-A', '172.20.0.1', 'Et0/3']] }),
      gear('172.20.100.2', 'SW-B', { ports: { 'Et0/0': undefined, 'Et0/1': undefined, Vlan100: '172.20.100.2/24' }, switches: true, routes: true, route: { nextHop: '172.20.100.1' }, hears: [['Et0/0', 'EDGE-B', '172.20.100.1', 'Et0/3']] }),
    ],
  },
  {
    id: 'hub-spoke',
    title: 'Branches that reach the internet through the main site, over tunnels',
    network: { gatewayIp: '10.1.0.1', cidr: '10.1.0.0/24,10.2.0.0/24,10.3.0.0/24' },
    assets: [asset('10.1.0.1', 'router'), asset('10.2.0.1', 'router'), asset('10.3.0.1', 'router'), asset('10.2.0.20', 'computer')],
    devices: [
      gear('10.1.0.1', 'HUB', { ports: { wan: '203.0.113.2/30', lan: '10.1.0.1/24', Tunnel0: '10.9.0.1/24' }, routes: true, route: { nextHop: '203.0.113.1' } }),
      gear('10.2.0.1', 'SPOKE1', { ports: { wan: '198.51.100.2/30', lan: '10.2.0.1/24', Tunnel0: '10.9.0.2/24' }, routes: true, route: { nextHop: '10.9.0.1' } }),
      gear('10.3.0.1', 'SPOKE2', { ports: { wan: '198.51.100.6/30', lan: '10.3.0.1/24', Tunnel0: '10.9.0.3/24' }, routes: true, route: { nextHop: '10.9.0.1' } }),
    ],
  },
  {
    id: 'site-vpn',
    title: 'Two sites with their own internet, joined by a tunnel',
    network: { gatewayIp: '10.1.0.1', cidr: '10.1.0.0/24,10.2.0.0/24' },
    assets: [asset('10.1.0.1', 'router'), asset('10.2.0.1', 'router'), asset('10.2.0.20', 'computer')],
    devices: [
      gear('10.1.0.1', 'RA', { ports: { wan: '203.0.113.2/30', lan: '10.1.0.1/24', Tu0: '10.9.9.1/30' }, routes: true, route: { nextHop: '203.0.113.1' } }),
      gear('10.2.0.1', 'RB', { ports: { wan: '198.51.100.2/30', lan: '10.2.0.1/24', Tu0: '10.9.9.2/30' }, routes: true, route: { nextHop: '198.51.100.1' } }),
    ],
  },
  {
    id: 'provider-wan',
    title: 'Two sites whose way out is a provider device on a private link',
    network: { gatewayIp: '10.1.0.1', cidr: '10.1.0.0/24,10.2.0.0/24' },
    assets: [asset('10.1.0.1', 'router'), asset('10.2.0.1', 'router')],
    devices: [
      gear('10.1.0.1', 'R1', { ports: { wan: '10.254.1.2/30', lan: '10.1.0.1/24' }, routes: true, route: { nextHop: '10.254.1.1' } }),
      gear('10.2.0.1', 'R2', { ports: { wan: '10.254.2.2/30', lan: '10.2.0.1/24' }, routes: true, route: { nextHop: '10.254.2.1' } }),
    ],
  },
  {
    id: 'double-nat',
    title: "A provider's modem in front of the router",
    network: { gatewayIp: '10.0.0.1', gatewayMac: 'aa:00:00:00:02:01', cidr: '10.0.0.0/24,192.168.1.0/24' },
    assets: [asset('10.0.0.1', 'router', 'aa:00:00:00:02:01'), asset('192.168.1.1', 'router'), asset('10.0.0.20', 'computer', 'aa:00:00:00:02:20')],
    devices: [gear('10.0.0.1', 'R1', { ports: { wan: '192.168.1.2/24', lan: '10.0.0.1/24' }, routes: true, route: { nextHop: '192.168.1.1' } })],
  },
  {
    id: 'no-internet',
    title: 'A lab with no way out',
    network: { gatewayIp: '10.0.0.1', cidr: '10.0.0.0/24' },
    assets: [asset('10.0.0.1', 'router'), asset('10.0.0.2', 'switch')],
    devices: [gear('10.0.0.1', 'R1', { ports: { lan: '10.0.0.1/24', lab: '10.0.5.1/24' }, routes: true }), sw('10.0.0.2', 'SW1', ['R1', '10.0.0.1', 'lan'])],
  },
  {
    id: 'scanned-from-outside',
    title: 'A network scanned from another one, through a router that is not managed',
    network: { cidr: '172.16.5.0/24' },
    assets: [asset('172.16.5.1', 'router'), asset('172.16.5.2', 'switch'), asset('172.16.5.20', 'computer')],
    devices: [
      gear('172.16.5.1', 'R1', { ports: { up: '172.16.0.2/30', lan: '172.16.5.1/24' }, routes: true, route: { nextHop: '172.16.0.1' }, hears: [['lan', 'SW1', '172.16.5.2', 'p1']] }),
      sw('172.16.5.2', 'SW1', ['R1', '172.16.5.1', 'lan']),
    ],
  },
  {
    id: 'main-site',
    title: 'A firewall that is not managed, a layer 3 core and a branch over a tunnel, scanned from outside',
    network: { cidr: '172.20.0.0/24, 172.20.10.0/24, 172.20.30.0/24, 172.20.255.0/30' },
    assets: [asset('172.20.0.1'), asset('172.20.0.3'), asset('172.20.10.1'), asset('172.20.10.11'), asset('172.20.30.1'), asset('172.20.30.11'), asset('172.20.255.1'), asset('172.20.255.2')],
    devices: [
      // The access switch answers first: the order devices were read in must not change the map.
      gear('172.20.0.3', 'ACC1', { ports: { 'Et0/0': undefined, 'Et0/1': undefined, Vl99: '172.20.0.3/24' }, switches: true, hears: [['Et0/0', 'CORE', '172.20.255.2', 'Et0/0']] }),
      gear('172.20.0.1', 'CORE', {
        ports: { 'Et0/0': undefined, 'Et1/0': '172.20.255.2/30', Vl10: '172.20.10.1/24', Vl99: '172.20.0.1/24', Tu0: '172.20.254.1/30' },
        routes: true,
        switches: true,
        route: { nextHop: '172.20.255.1' },
        hears: [['Et0/0', 'ACC1', '172.20.0.3', 'Et0/0']],
      }),
      gear('172.20.30.1', 'BRANCH', { ports: { 'Et0/0': '198.51.100.2/30', 'Et0/1': '172.20.30.1/24', Tu0: '172.20.254.2/30' }, routes: true, route: { nextHop: '172.20.254.1' } }),
    ],
  },
  {
    id: 'unread-gateway',
    title: 'Nothing answers SNMP',
    network: { gatewayIp: '192.168.1.1', gatewayMac: 'aa:00:00:00:03:01', cidr: '192.168.1.0/24' },
    assets: [asset('192.168.1.1', 'router', 'aa:00:00:00:03:01'), asset('192.168.1.20', 'computer', 'aa:00:00:00:03:20'), asset('192.168.1.21', 'phone', 'aa:00:00:00:03:21')],
    devices: [],
  },
];
