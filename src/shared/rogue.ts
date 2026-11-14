/**
 * Finds the switch port behind a DHCP server, from what managed switches learned over SNMP.
 *
 * A server's DHCP offer is a broadcast, so every switch on the way learns the server's MAC address
 * on the port facing it. The device sits on the one port that is not a link to other network gear.
 */
import type { GearDevice } from './types';

/** Where a MAC address was learned at the edge of the network. */
export interface PortLocation {
  /** Address and name of the managed switch. */
  switchIp: string;
  switchName?: string;
  ifIndex: number;
  /** Port name (e.g. "gi14") and the description an administrator gave it. */
  port: string;
  portAlias?: string;
  /** True when other devices share the port with no managed neighbour: an unmanaged switch or hub. */
  unmanaged: boolean;
  /** True when the address was only seen on links between gear: the device is past a switch without SNMP. */
  beyond: boolean;
  /** True when the port is the one leading to the gateway: the device hangs off the gateway or a switch beside it. */
  gatewayPort: boolean;
}

/**
 * How a DHCP server was found. announced: it announced itself over LLDP to the switch port, with the
 * server's address or MAC. exact: its MAC from an ARP table now. recorded: its MAC from an earlier scan
 * of the server's address, and seen on the switches now. likely: the only new or unknown address.
 */
export type LocateConfidence = 'announced' | 'exact' | 'recorded' | 'likely';

/** Result of looking for one DHCP server on the managed switches, as shown in Diagnose. */
export interface DhcpLocation {
  networkId: string;
  mac?: string;
  confidence?: LocateConfidence;
  where?: PortLocation;
  /** When the MAC could not be pinned down: how many unknown addresses could be the server. */
  unknownCount?: number;
  /** Map node of a server found over LLDP and not in the inventory. */
  nodeId?: string;
}

const norm = (mac: string) => mac.toLowerCase();

/** MAC addresses of network gear: the gateway, every managed device and the devices they announce. */
function gearMacs(devices: GearDevice[], gatewayMac?: string): Set<string> {
  const gear = new Set<string>();
  if (gatewayMac) gear.add(norm(gatewayMac));
  for (const d of devices) {
    if (d.mac) gear.add(norm(d.mac));
    for (const n of d.neighbors) if (n.chassisMac) gear.add(norm(n.chassisMac));
  }
  return gear;
}

/**
 * Ports that lead to other network gear: ports with an LLDP neighbour and ports where another
 * managed device (or the gateway) was learned. Keys are "switch ip|ifIndex".
 */
export function transitPorts(devices: GearDevice[], gatewayMac?: string, except?: string): Set<string> {
  const gear = gearMacs(devices, gatewayMac);
  // The device being located may itself be gear (an L3 switch, an access point): its own port is not a link.
  if (except) gear.delete(norm(except));
  const out = new Set<string>();
  for (const d of devices) {
    for (const n of d.neighbors) {
      const self = !!except && (norm(n.chassisMac ?? '') === norm(except) || norm(n.portMac ?? '') === norm(except));
      if (n.localIfIndex !== undefined && !self) out.add(`${d.ip}|${n.localIfIndex}`);
    }
    for (const f of d.fdb) if (f.ifIndex !== undefined && gear.has(norm(f.mac))) out.add(`${d.ip}|${f.ifIndex}`);
  }
  return out;
}

/** Keys "switch ip|ifIndex|mac" of every address learned in a reading. */
function learned(devices: GearDevice[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const d of devices ?? []) for (const f of d.fdb) if (f.ifIndex !== undefined) out.add(`${d.ip}|${f.ifIndex}|${norm(f.mac)}`);
  return out;
}

/**
 * VLANs of the network being diagnosed: where this computer's MAC was learned, else where the
 * gateway's was, else the VLAN most of `members` (the network's known devices) were learned in.
 * Undefined when none was seen.
 */
export function networkVlans(devices: GearDevice[], localMac?: string, gatewayMac?: string, members: string[] = []): Set<number> | undefined {
  const vlansOf = (mac: string) => {
    const vlans = new Set<number>();
    for (const d of devices) for (const f of d.fdb) if (f.vlan !== undefined && norm(f.mac) === norm(mac)) vlans.add(f.vlan);
    return vlans;
  };
  for (const mac of [localMac, gatewayMac]) {
    if (!mac) continue;
    const vlans = vlansOf(mac);
    if (vlans.size) return vlans;
  }
  const votes = new Map<number, number>();
  for (const mac of members) for (const v of vlansOf(mac)) votes.set(v, (votes.get(v) ?? 0) + 1);
  const best = [...votes].sort((a, b) => b[1] - a[1])[0];
  return best ? new Set([best[0]]) : undefined;
}

/** Hints for picking among several ports where a MAC was learned. */
export interface LocateHints {
  /** VLANs of the network being diagnosed; ports learned in them come first. */
  vlans?: Set<number>;
  /** The previous reading: a port where the address is new comes first. */
  before?: GearDevice[];
}

/** The edge port where `mac` was learned; undefined when no switch has seen it. */
export function locateMac(devices: GearDevice[], mac: string, gatewayMac?: string, hints: LocateHints = {}): PortLocation | undefined {
  const target = norm(mac);
  const transit = transitPorts(devices, gatewayMac, target);
  const old = hints.before ? learned(hints.before) : undefined;
  const seen: { d: GearDevice; ifIndex: number; vlan?: number }[] = [];
  for (const d of devices) for (const f of d.fdb) if (f.ifIndex !== undefined && norm(f.mac) === target) seen.push({ d, ifIndex: f.ifIndex, vlan: f.vlan });
  if (!seen.length) return undefined;
  // Distinct addresses: one device learned in two VLANs on a port is still one device.
  const count = (d: GearDevice, ifIndex: number) => new Set(d.fdb.filter((f) => f.ifIndex === ifIndex).map((f) => norm(f.mac))).size;
  // Among edge ports: the network's VLAN first, then a port where the address is new, then the quietest port.
  const rank = (x: (typeof seen)[number]) =>
    (hints.vlans && (x.vlan === undefined || !hints.vlans.has(x.vlan)) ? 2 : 0) + (old && old.has(`${x.d.ip}|${x.ifIndex}|${target}`) ? 1 : 0);
  const edges = seen.filter((x) => !transit.has(`${x.d.ip}|${x.ifIndex}`)).sort((a, b) => rank(a) - rank(b) || count(a.d, a.ifIndex) - count(b.d, b.ifIndex));
  const edge = edges[0];
  // Only seen on links between gear: the port with the fewest addresses is the closest one.
  const pick = edge ?? [...seen].sort((a, b) => rank(a) - rank(b) || count(a.d, a.ifIndex) - count(b.d, b.ifIndex))[0];
  if (!pick) return undefined;
  const iface = pick.d.interfaces.find((i) => i.ifIndex === pick.ifIndex);
  const gw = gatewayMac ? norm(gatewayMac) : undefined;
  const gatewayPort = !!gw && pick.d.fdb.some((f) => f.ifIndex === pick.ifIndex && norm(f.mac) === gw);
  return {
    switchIp: pick.d.ip,
    switchName: pick.d.sysName,
    ifIndex: pick.ifIndex,
    port: iface?.name ?? `port ${pick.ifIndex}`,
    portAlias: iface?.alias || undefined,
    unmanaged: !gatewayPort && !!edge && count(pick.d, pick.ifIndex) > 1,
    beyond: !gatewayPort && !edge,
    gatewayPort,
  };
}

/**
 * The switch port where a device announced itself over LLDP with management address `ip` or with
 * MAC `mac`. LLDP only crosses one link, so the port is where the device is plugged in.
 */
export function locateByLldp(devices: GearDevice[], ip: string, mac?: string): { where: PortLocation; mac?: string; nodeId: string } | undefined {
  const target = mac ? norm(mac) : undefined;
  for (const d of devices) {
    for (const n of d.neighbors) {
      const byIp = n.mgmtIp === ip;
      const byMac = !!target && (norm(n.chassisMac ?? '') === target || norm(n.portMac ?? '') === target);
      if (!byIp && !byMac) continue;
      const iface = n.localIfIndex !== undefined ? d.interfaces.find((i) => i.ifIndex === n.localIfIndex) : undefined;
      return {
        mac: mac ?? n.chassisMac ?? n.portMac,
        // Same id the map gives an LLDP neighbour that is not in the inventory.
        nodeId: `lldp:${n.chassisMac ?? n.portMac ?? n.chassisId ?? `${d.ip}:${n.localPort}`}`,
        where: {
          switchIp: d.ip,
          switchName: d.sysName,
          ifIndex: n.localIfIndex ?? -1,
          port: iface?.name ?? n.localPort,
          portAlias: iface?.alias || undefined,
          unmanaged: false,
          beyond: false,
          gatewayPort: false,
        },
      };
    }
  }
  return undefined;
}

/**
 * Addresses learned on edge ports that are neither network gear nor in `known` (the inventory,
 * this computer, servers already identified). `fresh` lists those on a port where `before`, the
 * previous reading, did not have them: a server plugged in by mistake is usually new or just moved.
 * Without `before`, none are fresh.
 */
export function unknownEdgeMacs(
  devices: GearDevice[],
  known: Set<string>,
  before?: GearDevice[],
  gatewayMac?: string,
): { fresh: string[]; rest: string[] } {
  const transit = transitPorts(devices, gatewayMac);
  const gear = gearMacs(devices, gatewayMac);
  for (const d of devices) for (const n of d.neighbors) if (n.portMac) gear.add(norm(n.portMac));
  const knownN = new Set([...known].map(norm));
  const found = new Set<string>();
  for (const d of devices) {
    for (const f of d.fdb) {
      const m = norm(f.mac);
      if (f.ifIndex === undefined || transit.has(`${d.ip}|${f.ifIndex}`) || gear.has(m) || knownN.has(m)) continue;
      found.add(m);
    }
  }
  const all = [...found].sort();
  if (!before) return { fresh: [], rest: all };
  // New: learned on an edge port where the previous reading did not have it (new, or moved).
  const old = learned(before);
  const fresh = new Set<string>();
  for (const d of devices) {
    for (const f of d.fdb) {
      const m = norm(f.mac);
      if (f.ifIndex === undefined || !found.has(m) || transit.has(`${d.ip}|${f.ifIndex}`)) continue;
      if (!old.has(`${d.ip}|${f.ifIndex}|${m}`)) fresh.add(m);
    }
  }
  return { fresh: all.filter((m) => fresh.has(m)), rest: all.filter((m) => !fresh.has(m)) };
}

/**
 * The server's MAC among unknown addresses: the only new one, else the only unknown one.
 * Undefined when several could be the server; guessing would send the technician to the wrong port.
 */
export function guessServerMac(c: { fresh: string[]; rest: string[] }): string | undefined {
  if (c.fresh.length === 1) return c.fresh[0];
  if (!c.fresh.length && c.rest.length === 1) return c.rest[0];
  return undefined;
}
