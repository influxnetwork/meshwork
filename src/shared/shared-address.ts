/**
 * Addresses that several routers share so that one of them answers as the gateway of a network
 * (first-hop redundancy). Such an address answers a scan like a device, but it is not one: it is
 * a second address of whichever router holds it at the moment. Each protocol uses a reserved
 * range of MAC addresses for it, which is how the address is recognised.
 */
import { inCidr } from './report';
import type { GearDevice } from './types';

export type SharedAddressProtocol = 'HSRP' | 'VRRP' | 'GLBP';

const RANGES: [RegExp, SharedAddressProtocol][] = [
  [/^00:00:0c:07:ac:/, 'HSRP'],
  [/^00:00:0c:9f:f/, 'HSRP'],
  [/^00:00:5e:00:01:/, 'VRRP'],
  [/^00:07:b4:00:/, 'GLBP'],
];

/** The protocol whose reserved range the MAC address belongs to, when it is a shared router address. */
export function sharedAddressProtocol(mac: string | undefined): SharedAddressProtocol | undefined {
  const m = mac?.toLowerCase();
  return m ? RANGES.find(([range]) => range.test(m))?.[1] : undefined;
}

const ipNum = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + (Number(o) || 0), 0);

/** The address of `d` whose network holds `ip`: the most specific one. */
function addressOn(d: GearDevice, ip: string) {
  return (d.addresses ?? [])
    .filter((a) => a.prefix > 0 && a.prefix < 32 && a.ip !== '0.0.0.0' && !a.ip.startsWith('127.') && inCidr(ip, `${a.ip}/${a.prefix}`))
    .sort((p, q) => q.prefix - p.prefix)[0];
}

/**
 * The router that answers for a shared address, among `routers` (the routing devices on its
 * network, lowest address first), as far as the MAC tables tell. A router that learned the shared
 * MAC address itself does not hold it: it is one hop from the one that does. Of the others, the
 * one that is alone in being heard on a port where a device learned that address is the holder,
 * and so is the only one left when the rest all learned it. Otherwise nothing tells, and with
 * GLBP nothing can: each router answers for the address with a MAC address of its own.
 */
function answering(routers: GearDevice[], devices: GearDevice[], mac: string): GearDevice | undefined {
  if (sharedAddressProtocol(mac) === 'GLBP') return undefined;
  const learned = (d: GearDevice) => d.fdb.filter((f) => f.mac.toLowerCase() === mac);
  const others = routers.filter((r) => !learned(r).length);
  const towards = new Set<GearDevice>();
  for (const d of devices) {
    for (const f of learned(d)) {
      for (const n of d.neighbors) {
        if (n.localIfIndex !== f.ifIndex) continue;
        const heard = others.find((r) => r.ip === n.mgmtIp || r.addresses?.some((a) => a.ip === n.mgmtIp) || (!!n.sysName && r.sysName === n.sysName));
        if (heard) towards.add(heard);
      }
    }
  }
  if (towards.size === 1) return [...towards][0];
  return others.length === 1 && routers.length > 1 ? others[0] : undefined;
}

/**
 * The readings with every shared router address listed by one router. `macOf` is the MAC address
 * known for each IP address (from the inventory and the devices' own ARP tables). A shared address
 * no reading lists is given to one of the routing devices on its network: the one the MAC tables
 * show answering for it (`answering`), else the one with the lowest address, whatever order the
 * devices were read in (marked `assumed`: nothing shows that router answering for it). It is added
 * on that router's interface on the network. A shared address
 * whose MAC address is not known, or whose network no managed router is on, is left as the scan
 * found it. Devices that gain an address are copies; the readings given are not altered.
 */
export function withSharedAddresses(devices: GearDevice[], macOf: ReadonlyMap<string, string>): GearDevice[] {
  const listed = new Set(devices.flatMap((d) => (d.addresses ?? []).map((a) => a.ip)));
  const extra = new Map<GearDevice, { ip: string; prefix: number; ifIndex: number; assumed?: boolean }[]>();
  for (const [ip, mac] of [...macOf].sort((p, q) => ipNum(p[0]) - ipNum(q[0]))) {
    if (!sharedAddressProtocol(mac) || listed.has(ip)) continue;
    const routers = devices.filter((d) => d.forwarding && addressOn(d, ip)).sort((p, q) => ipNum(p.ip) - ipNum(q.ip));
    if (!routers.length) continue;
    const seen = answering(routers, devices, mac.toLowerCase());
    const holder = seen ?? (routers[0] as GearDevice);
    const on = addressOn(holder, ip) as { prefix: number; ifIndex: number };
    extra.set(holder, [...(extra.get(holder) ?? []), { ip, prefix: on.prefix, ifIndex: on.ifIndex, ...(seen ? {} : { assumed: true }) }]);
  }
  return extra.size ? devices.map((d) => (extra.has(d) ? { ...d, addresses: [...(d.addresses ?? []), ...(extra.get(d) ?? [])] } : d)) : devices;
}
