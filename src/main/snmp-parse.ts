/**
 * Pure decoding of SNMP table walks into a managed device's ports, LLDP neighbours, learned MAC
 * addresses and PoE state. Inputs are the raw varbinds of each walk (OID and value); values may be
 * numbers, bigints, strings or byte buffers, as SNMP libraries return them.
 */
import type { GearDevice, GearFdbEntry, GearInterface, GearNeighbor, LldpCapability, StpState } from '@shared/types';

export interface Varbind {
  oid: string;
  value: unknown;
}

export const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  sysObjectId: '1.3.6.1.2.1.1.2.0',
  sysUpTime: '1.3.6.1.2.1.1.3.0',
  sysName: '1.3.6.1.2.1.1.5.0',
  ifDescr: '1.3.6.1.2.1.2.2.1.2',
  ifPhysAddress: '1.3.6.1.2.1.2.2.1.6',
  ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
  ifName: '1.3.6.1.2.1.31.1.1.1.1',
  ifHCInOctets: '1.3.6.1.2.1.31.1.1.1.6',
  ifHCOutOctets: '1.3.6.1.2.1.31.1.1.1.10',
  ifHighSpeed: '1.3.6.1.2.1.31.1.1.1.15',
  ifAlias: '1.3.6.1.2.1.31.1.1.1.18',
  baseBridgeAddress: '1.3.6.1.2.1.17.1.1.0',
  basePortIfIndex: '1.3.6.1.2.1.17.1.4.1.2',
  stpPriority: '1.3.6.1.2.1.17.2.2.0',
  dot1dFdbPort: '1.3.6.1.2.1.17.4.3.1.2',
  dot1dFdbStatus: '1.3.6.1.2.1.17.4.3.1.3',
  stpPortState: '1.3.6.1.2.1.17.2.15.1.3',
  qFdbPort: '1.3.6.1.2.1.17.7.1.2.2.1.2',
  qFdbStatus: '1.3.6.1.2.1.17.7.1.2.2.1.3',
  ipNetToMedia: '1.3.6.1.2.1.4.22.1.2',
  ipNetToPhysical: '1.3.6.1.2.1.4.35.1.4',
  ipForwarding: '1.3.6.1.2.1.4.1.0',
  /** Default route in the three route tables devices publish (RFC 1213, 2096 and 4292). */
  ipRouteNextHopDefault: '1.3.6.1.2.1.4.21.1.7.0.0.0.0',
  ipRouteIfIndexDefault: '1.3.6.1.2.1.4.21.1.2.0.0.0.0',
  ipCidrRouteIfIndexDefault: '1.3.6.1.2.1.4.24.4.1.5.0.0.0.0.0.0.0.0',
  inetCidrRouteIfIndexDefault: '1.3.6.1.2.1.4.24.7.1.7.1.4.0.0.0.0.0',
  ipAdEntIfIndex: '1.3.6.1.2.1.4.20.1.2',
  ipAdEntNetMask: '1.3.6.1.2.1.4.20.1.3',
  /** 802.1Q VLANs (Q-BRIDGE-MIB): names, member and untagged ports (configured and current), PVIDs. */
  vlanStaticName: '1.3.6.1.2.1.17.7.1.4.3.1.1',
  vlanStaticEgress: '1.3.6.1.2.1.17.7.1.4.3.1.2',
  vlanStaticUntagged: '1.3.6.1.2.1.17.7.1.4.3.1.4',
  vlanCurrentEgress: '1.3.6.1.2.1.17.7.1.4.2.1.4',
  vlanCurrentUntagged: '1.3.6.1.2.1.17.7.1.4.2.1.5',
  pvid: '1.3.6.1.2.1.17.7.1.4.5.1.1',
  // IEEE8021-Q-BRIDGE-MIB: the same data indexed by bridge component, which some switches publish instead.
  ieeeVlanStaticName: '1.3.111.2.802.1.1.4.1.4.3.1.3',
  ieeeVlanStaticEgress: '1.3.111.2.802.1.1.4.1.4.3.1.4',
  ieeeVlanStaticUntagged: '1.3.111.2.802.1.1.4.1.4.3.1.6',
  ieeePvid: '1.3.111.2.802.1.1.4.1.4.5.1.1',
  lldpLocPortId: '1.0.8802.1.1.2.1.3.7.1.3',
  lldpRem: '1.0.8802.1.1.2.1.4.1.1',
  lldpRemManAddr: '1.0.8802.1.1.2.1.4.2.1.3',
  pethPortDetection: '1.3.6.1.2.1.105.1.1.1.6',
  pethMain: '1.3.6.1.2.1.105.1.3.1.1',
  /** Per-port PoE output power in milliwatts, published by Cisco small-business switches. */
  poePortMilliwattsSb: '1.3.6.1.4.1.9.6.1.101.108.1.1.5',
  /** Per-port PoE power drawn, in milliwatts, published by Cisco Catalyst switches (indexed like the PoE port table). */
  poePortMilliwattsCisco: '1.3.6.1.4.1.9.9.402.1.2.1.9',
} as const;

/** Index parts after a table column OID, or undefined when the OID is outside it. */
export function suffix(oid: string, base: string): number[] | undefined {
  const o = oid.replace(/^\./, '');
  if (!o.startsWith(`${base}.`)) return undefined;
  return o.slice(base.length + 1).split('.').map(Number);
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) {
    // Counter64 values arrive as big-endian bytes.
    if (!v.length) return undefined;
    let n = 0n;
    for (const b of v) n = (n << 8n) | BigInt(b);
    return Number(n);
  }
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

export function text(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined;
  if (Buffer.isBuffer(v)) {
    const s = v.toString('utf8').replace(/\0+$/, '').trim();
    // Binary identifiers (MAC addresses) are not text.
    return s && !/[\u0000-\u0008\u000e-\u001f�]/.test(s) ? s : undefined;
  }
  return undefined;
}

/** A port's own unicast address; all-zero, broadcast and multicast values say nothing about the port. */
function portMac(v: unknown): string | undefined {
  const mac = macOf(v);
  if (!mac || mac === '00:00:00:00:00:00') return undefined;
  return parseInt(mac.slice(0, 2), 16) & 1 ? undefined : mac;
}

/** lldpRemSysCapEnabled bits, most significant first (BITS encoding). */
const LLDP_CAPABILITIES: readonly LldpCapability[] = ['other', 'repeater', 'bridge', 'wlanAccessPoint', 'router', 'telephone', 'docsis', 'station'];

/** Capabilities set in an LLDP capability bitmap; undefined when the value is not one. */
function lldpCapabilities(v: unknown): LldpCapability[] | undefined {
  if (!Buffer.isBuffer(v) || !v.length) return undefined;
  const first = v[0] as number;
  const set = LLDP_CAPABILITIES.filter((_, i) => first & (0x80 >> i));
  return set.length ? set : undefined;
}

/** dot1dStpPortState values, by number. */
const STP_STATES: readonly (StpState | undefined)[] = [undefined, 'disabled', 'blocking', 'listening', 'learning', 'forwarding', 'broken'];

export function macOf(v: unknown): string | undefined {
  if (Buffer.isBuffer(v) && v.length === 6) return [...v].map((b) => b.toString(16).padStart(2, '0')).join(':');
  if (typeof v === 'string') {
    const hex = v.replace(/[^0-9a-f]/gi, '');
    if (hex.length === 12) return hex.toLowerCase().match(/../g)?.join(':');
  }
  return undefined;
}

/** MAC address written in an OID index as six decimal octets. */
function macFromIndex(parts: number[]): string | undefined {
  if (parts.length !== 6 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return undefined;
  return parts.map((p) => p.toString(16).padStart(2, '0')).join(':');
}

/** Values of one table column keyed by the joined index. */
function column(walk: Varbind[], base: string): Map<string, unknown> {
  const out = new Map<string, unknown>();
  for (const vb of walk) {
    const idx = suffix(vb.oid, base);
    if (idx) out.set(idx.join('.'), vb.value);
  }
  return out;
}

function scalar(walk: Varbind[], oid: string): unknown {
  return walk.find((vb) => vb.oid.replace(/^\./, '') === oid)?.value;
}

export interface GearWalks {
  /** Scalars: sysName, sysDescr, sysObjectID, sysUpTime, bridge address, STP priority. */
  system: Varbind[];
  ifName: Varbind[];
  ifDescr: Varbind[];
  /** Port MAC addresses; older readings lack them. */
  ifPhysAddress?: Varbind[];
  ifAlias: Varbind[];
  ifOperStatus: Varbind[];
  ifHighSpeed: Varbind[];
  basePortIfIndex: Varbind[];
  qFdbPort: Varbind[];
  qFdbStatus: Varbind[];
  dot1dFdbPort: Varbind[];
  dot1dFdbStatus: Varbind[];
  /** Spanning tree state per bridge port; older readings lack it. */
  stpPortState?: Varbind[];
  ipNetToMedia: Varbind[];
  /** Newer ARP table (any address family), read only when the classic one is empty. */
  ipNetToPhysical?: Varbind[];
  ipAdEntIfIndex: Varbind[];
  ipAdEntNetMask: Varbind[];
  /** Default route entries from ipCidrRouteTable and inetCidrRouteTable (scalars hold ipRouteTable's). */
  defaultRoutes: Varbind[];
  vlanStaticName: Varbind[];
  vlanStaticEgress: Varbind[];
  vlanStaticUntagged: Varbind[];
  vlanCurrentEgress: Varbind[];
  vlanCurrentUntagged: Varbind[];
  pvid: Varbind[];
  /** IEEE 802.1Q bridge tables, read only when the classic VLAN tables are empty. */
  ieeeVlanStaticName?: Varbind[];
  ieeeVlanStaticEgress?: Varbind[];
  ieeeVlanStaticUntagged?: Varbind[];
  ieeePvid?: Varbind[];
  lldpLocPortId: Varbind[];
  lldpRem: Varbind[];
  lldpRemManAddr: Varbind[];
  pethPortDetection: Varbind[];
  pethMain: Varbind[];
  poePortMilliwatts: Varbind[];
}

export function parseGear(ip: string, w: GearWalks): GearDevice {
  // Interfaces
  const names = column(w.ifName, OID.ifName);
  const descrs = column(w.ifDescr, OID.ifDescr);
  const aliases = column(w.ifAlias, OID.ifAlias);
  const oper = column(w.ifOperStatus, OID.ifOperStatus);
  const speeds = column(w.ifHighSpeed, OID.ifHighSpeed);
  const physical = column(w.ifPhysAddress ?? [], OID.ifPhysAddress);
  const indexes = new Set([...names.keys(), ...descrs.keys()].map(Number));
  const interfaces: GearInterface[] = [...indexes]
    .sort((a, b) => a - b)
    .map((ifIndex) => {
      const key = String(ifIndex);
      const speed = num(speeds.get(key));
      return {
        ifIndex,
        name: text(names.get(key)) ?? text(descrs.get(key)) ?? `if${ifIndex}`,
        descr: text(descrs.get(key)),
        alias: text(aliases.get(key)),
        up: num(oper.get(key)) === 1,
        speedMbps: speed || undefined,
        mac: portMac(physical.get(key)),
      };
    });
  const byIndex = new Map(interfaces.map((i) => [i.ifIndex, i]));
  const byName = new Map<string, GearInterface>();
  for (const i of interfaces) {
    byName.set(i.name.toLowerCase(), i);
    if (i.descr && !byName.has(i.descr.toLowerCase())) byName.set(i.descr.toLowerCase(), i);
  }

  // Bridge ports map to interfaces; most switches number them alike, which is the fallback.
  const bridge = new Map<number, number>();
  for (const [k, v] of column(w.basePortIfIndex, OID.basePortIfIndex)) {
    const ifIndex = num(v);
    if (ifIndex !== undefined) bridge.set(Number(k), ifIndex);
  }
  // Some switches (TP-Link among them) number MAC-table ports by position (1, 2, 3…) instead of by
  // bridge port: a number missing from the bridge table is read as a position in it, and only as an
  // interface index when the device publishes no bridge table at all.
  const bridgePorts = [...bridge.keys()].sort((a, b) => a - b);
  const portToIf = (port: number): number | undefined => {
    const direct = bridge.get(port);
    if (direct !== undefined) return direct;
    if (bridgePorts.length) return bridge.get(bridgePorts[port - 1] ?? -1);
    return byIndex.has(port) ? port : undefined;
  };

  // Spanning tree state of each bridge port, on its interface. The table is indexed by bridge port
  // number, so only the bridge table maps it (no positional reading, unlike the MAC table).
  for (const [k, v] of column(w.stpPortState ?? [], OID.stpPortState)) {
    const n = Number(k);
    const ifIndex = bridge.size ? bridge.get(n) : byIndex.has(n) ? n : undefined;
    const port = ifIndex !== undefined ? byIndex.get(ifIndex) : undefined;
    const state = STP_STATES[num(v) ?? 0];
    if (port && state) port.stp = state;
  }

  // Learned MAC addresses (802.1Q table first, the older bridge table otherwise). Only learned
  // entries count: the switch's own and static addresses are skipped.
  const fdb: GearFdbEntry[] = [];
  const seenMac = new Set<string>();
  const qStatus = column(w.qFdbStatus, OID.qFdbStatus);
  for (const [k, v] of column(w.qFdbPort, OID.qFdbPort)) {
    const parts = k.split('.').map(Number);
    const mac = macFromIndex(parts.slice(1));
    const port = num(v);
    const status = num(qStatus.get(k));
    if (!mac || !port || (status !== undefined && status !== 3)) continue;
    const key = `${mac}|${parts[0]}`;
    if (seenMac.has(key)) continue;
    seenMac.add(key);
    fdb.push({ mac, ifIndex: portToIf(port), vlan: parts[0] });
  }
  if (!fdb.length) {
    const dStatus = column(w.dot1dFdbStatus, OID.dot1dFdbStatus);
    for (const [k, v] of column(w.dot1dFdbPort, OID.dot1dFdbPort)) {
      const mac = macFromIndex(k.split('.').map(Number));
      const port = num(v);
      const status = num(dStatus.get(k));
      if (!mac || !port || (status !== undefined && status !== 3)) continue;
      fdb.push({ mac, ifIndex: portToIf(port) });
    }
  }

  // LLDP neighbours. The remote table is indexed by time mark, local port number and entry; some
  // switches (TP-Link) leave the time mark out, so indexes are read from the end.
  const localIds = column(w.lldpLocPortId, OID.lldpLocPortId);
  const localPortToIf = (portNum: number): GearInterface | undefined => {
    const id = text(localIds.get(String(portNum)))?.toLowerCase();
    return (id ? byName.get(id) : undefined) ?? byIndex.get(portNum) ?? byIndex.get(bridge.get(portNum) ?? -1);
  };
  const remote = new Map<string, Map<number, unknown>>();
  for (const vb of w.lldpRem) {
    const idx = suffix(vb.oid, OID.lldpRem);
    if (!idx || idx.length < 3) continue;
    const col = idx[0] as number;
    const key = idx.slice(-2).join('.');
    if (!remote.has(key)) remote.set(key, new Map());
    remote.get(key)?.set(col, vb.value);
  }
  const mgmt = new Map<string, string>();
  for (const vb of w.lldpRemManAddr) {
    const idx = suffix(vb.oid, OID.lldpRemManAddr);
    // [timeMark.]localPort.remIndex.addrSubtype.addrLen.addr…; an IPv4 address (subtype 1, length 4)
    // ends the index, so it is read from the end.
    if (!idx || idx.length < 8) continue;
    const tail = idx.slice(-6);
    if (tail[0] !== 1 || tail[1] !== 4) continue;
    const key = `${idx.at(-8)}.${idx.at(-7)}`;
    if (!mgmt.has(key)) mgmt.set(key, tail.slice(2).join('.'));
  }
  const neighbors: GearNeighbor[] = [];
  for (const [key, cols] of remote) {
    const localPortNum = Number(key.split('.')[0]);
    const local = localPortToIf(localPortNum);
    const chassisMac = num(cols.get(4)) === 4 ? macOf(cols.get(5)) : undefined;
    const portMac = num(cols.get(6)) === 3 ? macOf(cols.get(7)) : undefined;
    neighbors.push({
      localIfIndex: local?.ifIndex,
      localPort: local?.name ?? `port ${localPortNum}`,
      chassisMac,
      chassisId: chassisMac ?? text(cols.get(5)),
      portMac,
      // Port ids given as a MAC or network address say nothing useful; the port description does.
      remotePort: ([3, 4].includes(num(cols.get(6)) ?? 0) ? undefined : text(cols.get(7))) ?? text(cols.get(8)),
      sysName: text(cols.get(9)),
      sysDescr: text(cols.get(10)),
      mgmtIp: mgmt.get(key),
      capabilities: lldpCapabilities(cols.get(12)),
    });
  }

  // PoE: ports delivering power, per-port watts when published, and the power budget.
  const poePortToIf = (port: number) => (byIndex.has(port) ? port : (bridge.get(port) ?? bridge.get(bridgePorts[port - 1] ?? -1)));
  for (const [k, v] of column(w.pethPortDetection, OID.pethPortDetection)) {
    const iface = byIndex.get(poePortToIf(Number(k.split('.').at(-1))) ?? -1);
    if (iface) iface.poe = num(v) === 3;
  }
  for (const vb of w.poePortMilliwatts) {
    const idx = suffix(vb.oid, OID.poePortMilliwattsSb) ?? suffix(vb.oid, OID.poePortMilliwattsCisco);
    const mw = num(vb.value);
    const iface = idx ? byIndex.get(poePortToIf(idx.at(-1) ?? -1) ?? -1) : undefined;
    if (iface && mw && mw > 0) {
      iface.poeWatts = Math.round(mw / 100) / 10;
      iface.poe = true;
    }
  }
  const main = column(w.pethMain, OID.pethMain);
  const budget = num(main.get('2.1'));
  const used = num(main.get('4.1'));

  // ARP table: ifIndex.a.b.c.d → MAC. It holds at least the device's own gateway.
  const arp: { ip: string; mac: string }[] = [];
  for (const vb of w.ipNetToMedia) {
    const idx = suffix(vb.oid, OID.ipNetToMedia);
    const mac = macOf(vb.value);
    if (idx && idx.length === 5 && mac && mac !== '00:00:00:00:00:00') arp.push({ ip: idx.slice(1).join('.'), mac });
  }
  // The newer table: ifIndex.addressType.length.address; only IPv4 entries (type 1, length 4).
  for (const vb of arp.length ? [] : (w.ipNetToPhysical ?? [])) {
    const idx = suffix(vb.oid, OID.ipNetToPhysical);
    const mac = macOf(vb.value);
    if (idx && idx.length === 7 && idx[1] === 1 && idx[2] === 4 && mac && mac !== '00:00:00:00:00:00') arp.push({ ip: idx.slice(3).join('.'), mac });
  }

  // Own addresses: index is the address itself; the mask gives the network on that interface.
  const masks = column(w.ipAdEntNetMask, OID.ipAdEntNetMask);
  const addresses: { ip: string; prefix: number; ifIndex: number }[] = [];
  for (const [ip, v] of column(w.ipAdEntIfIndex, OID.ipAdEntIfIndex)) {
    const ifIndex = num(v);
    if (ifIndex === undefined || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) continue;
    addresses.push({ ip, prefix: prefixOf(masks.get(ip)), ifIndex });
  }

  // VLANs. Port lists are bitmaps of bridge ports (first octet's high bit is port 1). The configured
  // table is preferred; some switches publish only the current one (indexed by time mark and VLAN).
  const vlanIds = new Set<number>();
  const egress = new Map<number, number[]>();
  const untagged = new Map<number, number[]>();
  const readLists = (walk: Varbind[], base: string, into: Map<number, number[]>) => {
    for (const vb of walk) {
      const idx = suffix(vb.oid, base);
      const vlan = idx?.at(-1);
      if (vlan === undefined || into.has(vlan)) continue;
      into.set(vlan, portList(vb.value).map((p) => portToIf(p)).filter((x): x is number => x !== undefined));
      vlanIds.add(vlan);
    }
  };
  readLists(w.vlanStaticEgress, OID.vlanStaticEgress, egress);
  readLists(w.vlanStaticUntagged, OID.vlanStaticUntagged, untagged);
  readLists(w.vlanCurrentEgress, OID.vlanCurrentEgress, egress);
  readLists(w.vlanCurrentUntagged, OID.vlanCurrentUntagged, untagged);
  readLists(w.ieeeVlanStaticEgress ?? [], OID.ieeeVlanStaticEgress, egress);
  readLists(w.ieeeVlanStaticUntagged ?? [], OID.ieeeVlanStaticUntagged, untagged);
  // Classic tables are keyed by VLAN or port; the IEEE ones by component then VLAN or port, so the
  // last index part is the VLAN or port in both.
  const lastIndex = (walk: Varbind[], base: string) => {
    const out = new Map<string, unknown>();
    for (const vb of walk) {
      const last = suffix(vb.oid, base)?.at(-1);
      if (last !== undefined && !out.has(String(last))) out.set(String(last), vb.value);
    }
    return out;
  };
  const classicNames = column(w.vlanStaticName, OID.vlanStaticName);
  const vlanNames = classicNames.size ? classicNames : lastIndex(w.ieeeVlanStaticName ?? [], OID.ieeeVlanStaticName);
  for (const k of vlanNames.keys()) vlanIds.add(Number(k));
  const classicPvids = column(w.pvid, OID.pvid);
  const pvids = classicPvids.size ? classicPvids : lastIndex(w.ieeePvid ?? [], OID.ieeePvid);
  for (const [k, v] of pvids) {
    const iface = byIndex.get(portToIf(Number(k)) ?? -1);
    const vlan = num(v);
    if (iface && vlan) {
      iface.pvid = vlan;
      vlanIds.add(vlan);
    }
  }
  for (const [vlan, members] of egress) {
    const plain = new Set(untagged.get(vlan) ?? []);
    for (const ifIndex of members) {
      const iface = byIndex.get(ifIndex);
      if (!iface || plain.has(ifIndex) || iface.pvid === vlan) continue;
      iface.tagged = [...(iface.tagged ?? []), vlan].sort((a, b) => a - b);
    }
  }
  const vlans = [...vlanIds].sort((a, b) => a - b).map((id) => ({ id, name: text(vlanNames.get(String(id))) }));

  // Default route: the classic table answers by OID; the CIDR tables carry the next hop in the index.
  let defaultRoute: { nextHop?: string; ifIndex?: number } | undefined;
  const classicHop = scalar(w.system, OID.ipRouteNextHopDefault);
  const classicHopText = typeof classicHop === 'string' ? classicHop : Buffer.isBuffer(classicHop) && classicHop.length === 4 ? [...classicHop].join('.') : undefined;
  if (classicHopText && classicHopText !== '0.0.0.0') defaultRoute = { nextHop: classicHopText, ifIndex: num(scalar(w.system, OID.ipRouteIfIndexDefault)) };
  for (const vb of w.defaultRoutes) {
    if (defaultRoute) break;
    const cidr = suffix(vb.oid, OID.ipCidrRouteIfIndexDefault);
    const inet = suffix(vb.oid, OID.inetCidrRouteIfIndexDefault);
    // ipCidrRouteTable index after dest+mask: tos.nextHop(4); inetCidrRouteTable: policy….type.len.nextHop(4).
    const hop = (cidr ?? inet)?.slice(-4);
    if (hop && hop.length === 4 && hop.every((p) => p >= 0 && p <= 255) && hop.join('.') !== '0.0.0.0') {
      defaultRoute = { nextHop: hop.join('.'), ifIndex: num(vb.value) };
    }
  }
  const forwarding = num(scalar(w.system, OID.ipForwarding));

  const uptime = num(scalar(w.system, OID.sysUpTime));
  const objectId = scalar(w.system, OID.sysObjectId);
  return {
    ip,
    sysName: text(scalar(w.system, OID.sysName)),
    sysDescr: text(scalar(w.system, OID.sysDescr)),
    sysObjectId: typeof objectId === 'string' ? objectId : undefined,
    uptimeSec: uptime !== undefined ? Math.round(uptime / 100) : undefined,
    mac: macOf(scalar(w.system, OID.baseBridgeAddress)),
    interfaces,
    neighbors,
    fdb,
    arp,
    vlans: vlans.length ? vlans : undefined,
    addresses,
    forwarding: forwarding === undefined ? undefined : forwarding === 1,
    bridgePorts: bridge.size || undefined,
    defaultRoute,
    poe: budget !== undefined || used !== undefined ? { budgetW: budget, usedW: used } : undefined,
    stpPriority: num(scalar(w.system, OID.stpPriority)),
  };
}

/** Bridge port numbers set in an 802.1Q port list (a bitmap; the first octet's high bit is port 1). */
export function portList(v: unknown): number[] {
  const bytes = Buffer.isBuffer(v) ? [...v] : typeof v === 'string' ? (v.match(/[0-9a-f]{2}/gi) ?? []).map((h) => parseInt(h, 16)) : [];
  const ports: number[] = [];
  bytes.forEach((byte, i) => {
    for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) ports.push(i * 8 + bit + 1);
  });
  return ports;
}

/** Prefix length of a netmask given as dotted text or four bytes; 32 when unknown. */
export function prefixOf(mask: unknown): number {
  const parts = Buffer.isBuffer(mask) && mask.length === 4 ? [...mask] : typeof mask === 'string' ? mask.split('.').map(Number) : [];
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return 32;
  return parts.reduce((bits, p) => bits + p.toString(2).replace(/0/g, '').length, 0);
}

/**
 * Bits per second between two octet counter readings. A counter that went backwards was reset
 * (device restart or cleared counters); 64-bit counters do not wrap in practice, so that reads as 0.
 */
export function rate(before: number, after: number, seconds: number): number {
  if (seconds <= 0 || after < before) return 0;
  return Math.round(((after - before) * 8) / seconds);
}

/** One device's octet counters per ifIndex, and when they were read (ms). */
export interface CounterReading {
  at: number;
  values: Map<number, { in: number; out: number }>;
}

/** Traffic state of one device: the reading rates are measured from, and the last rates per ifIndex. */
export interface DeviceTraffic {
  base: CounterReading;
  rates: Map<number, { inBps: number; outBps: number }>;
}

/**
 * Traffic state of a device that did not answer a sample: no rates until it answers again, and the
 * last reading stays the base, so the next answer is measured over the whole span.
 */
export function missedTraffic(prev: DeviceTraffic | undefined): DeviceTraffic | undefined {
  return prev && { base: prev.base, rates: new Map() };
}

/** Longest a device may answer with identical counters before they are taken as no traffic. */
const COUNTER_HOLD_MS = 30_000;

/**
 * Next traffic state after a new reading. Many switches refresh their counters every few seconds
 * and answer in between with the values they already gave: a reading where every counter is the
 * same as the base keeps the last rates and the base, so the next refresh is measured over the whole
 * span instead of showing a gap of zero traffic. Counters that stay the same for longer are idle.
 */
export function advanceTraffic(prev: DeviceTraffic | undefined, reading: CounterReading, holdMs = COUNTER_HOLD_MS): DeviceTraffic {
  if (!prev) return { base: reading, rates: new Map() };
  const { base } = prev;
  const unchanged =
    reading.values.size > 0 &&
    [...reading.values].every(([i, v]) => {
      const b = base.values.get(i);
      return !!b && b.in === v.in && b.out === v.out;
    });
  if (unchanged && reading.at - base.at < holdMs) return prev;
  const seconds = (reading.at - base.at) / 1000;
  const rates = new Map<number, { inBps: number; outBps: number }>();
  for (const [i, v] of reading.values) {
    const b = base.values.get(i);
    if (b) rates.set(i, { inBps: rate(b.in, v.in, seconds), outBps: rate(b.out, v.out, seconds) });
  }
  return { base: reading, rates };
}
