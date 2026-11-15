/**
 * Finds links whose two ends disagree on native VLAN or duplex, from what CDP neighbours announce.
 *
 * CDP carries the native (untagged) VLAN and the duplex of the sending port. Each end is compared
 * with the port it is plugged into: that port's own reading over SNMP when there is one, else what
 * the port announced to the other device when that device is managed too. A value that is not
 * known on both ends is never reported.
 */
import type { GearDevice, GearInterface, GearNeighbor } from './types';

export type MismatchKind = 'nativeVlan' | 'duplex';

/** One end of a link: the device, its port and the value it has there. */
export interface MismatchEnd {
  ip?: string;
  name?: string;
  port?: string;
  value: string;
}

export interface LinkMismatch {
  kind: MismatchKind;
  /** The managed device that reported the neighbour. */
  local: MismatchEnd;
  remote: MismatchEnd;
}

/** Host name for matching: lower case, without the domain. */
const hostKey = (name?: string) => name?.split('.')[0]?.toLowerCase() || undefined;
const portKey = (name?: string) => name?.toLowerCase().replace(/\s+/g, '');

const hasAddress = (d: GearDevice, ip?: string) => !!ip && (d.ip === ip || !!d.addresses?.some((a) => a.ip === ip));
/** True when a neighbour entry names device `d`, by address or by host name. */
const names = (n: GearNeighbor, d: GearDevice) => hasAddress(d, n.mgmtIp) || (!!hostKey(n.sysName) && hostKey(n.sysName) === hostKey(d.sysName));
/** True when interface `i` is the port named `port` (by its short name or its description). */
const isPort = (i: GearInterface | undefined, port?: string) => !!i && !!portKey(port) && (portKey(i.name) === portKey(port) || portKey(i.descr) === portKey(port));

const VALUE: Record<MismatchKind, (end: { iface?: GearInterface; announced?: GearNeighbor }) => string | undefined> = {
  nativeVlan: ({ iface, announced }) => {
    const v = iface?.pvid ?? announced?.nativeVlan;
    return v !== undefined ? String(v) : undefined;
  },
  duplex: ({ iface, announced }) => iface?.duplex ?? announced?.duplex,
};

export function findLinkMismatches(devices: GearDevice[]): LinkMismatch[] {
  const out: LinkMismatch[] = [];
  const seen = new Set<string>();
  for (const d of devices) {
    for (const n of d.neighbors) {
      if (!n.protocols?.includes('cdp')) continue;
      const iface = d.interfaces.find((i) => i.ifIndex === n.localIfIndex);
      const peer = devices.find((e) => e !== d && names(n, e));
      // What the peer heard from this port, when the peer is managed too.
      const fromHere = peer?.neighbors.filter((r) => r.protocols?.includes('cdp') && names(r, d));
      const back = fromHere?.find((r) => isPort(iface, r.remotePort)) ?? (fromHere?.length === 1 ? fromHere[0] : undefined);
      const peerIface = peer?.interfaces.find((i) => (back ? i.ifIndex === back.localIfIndex : isPort(i, n.remotePort)));
      for (const kind of ['nativeVlan', 'duplex'] as const) {
        const here = VALUE[kind]({ iface, announced: back });
        const there = VALUE[kind]({ announced: n }) ?? VALUE[kind]({ iface: peerIface });
        if (here === undefined || there === undefined || here === there) continue;
        const a = `${d.ip}|${portKey(iface?.name ?? n.localPort)}`;
        const b = `${peer?.ip ?? n.mgmtIp ?? hostKey(n.sysName)}|${portKey(peerIface?.name ?? n.remotePort)}`;
        const key = `${kind}|${[a, b].sort().join('|')}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          kind,
          local: { ip: d.ip, name: d.sysName, port: iface?.name ?? n.localPort, value: here },
          remote: { ip: peer?.ip ?? n.mgmtIp, name: peer?.sysName ?? n.sysName, port: peerIface?.name ?? n.remotePort, value: there },
        });
      }
    }
  }
  return out;
}

const valueText = (kind: MismatchKind, v: string) => (kind === 'nativeVlan' ? `VLAN ${v}` : `${v} duplex`);
/** One end with its value, e.g. "CORE Et0/3 (VLAN 1)". */
export const describeEnd = (kind: MismatchKind, e: MismatchEnd) => `${[e.name ?? e.ip, e.port].filter(Boolean).join(' ')} (${valueText(kind, e.value)})`;

/** One sentence naming both ends, e.g. "Native VLAN differs between CORE Et0/3 (VLAN 1) and ACC2 Ethernet0/0 (VLAN 30)". */
export function describeMismatch(m: LinkMismatch): string {
  return `${m.kind === 'nativeVlan' ? 'Native VLAN' : 'Duplex'} differs between ${describeEnd(m.kind, m.local)} and ${describeEnd(m.kind, m.remote)}`;
}

/** What the mismatch causes and how to fix it. */
export function mismatchAdvice(kind: MismatchKind): string {
  return kind === 'nativeVlan'
    ? 'Untagged frames sent on one end arrive in a different VLAN on the other, so devices can land in the wrong network and spanning tree can block VLANs on this link. Set the same native VLAN on both ports.'
    : 'One end transmits while the other is still sending, which causes collisions and slow, unreliable transfers. Set both ports to auto-negotiate, or to the same speed and duplex.';
}
