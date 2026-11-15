/**
 * Follows the default route of each managed device one hop: the interface it leaves through and
 * the managed device that receives it, when one does. A device whose next hop no managed device
 * owns is where the managed part of the network ends: its way out to the internet or to equipment
 * that was not read.
 */
import { inCidr } from './report';
import type { GearDevice } from './types';

export interface WayOut {
  nextHop: string;
  /** Interface the route leaves through: the one published, else the one whose network holds the next hop. */
  ifIndex?: number;
  /** Address (as read) of the managed device that owns the next hop. */
  via?: string;
}

const usable = (ip: string) => ip !== '0.0.0.0' && !ip.startsWith('127.');

/** Network of an interface address, as CIDR text for `inCidr`. */
const networkOf = (a: { ip: string; prefix: number }) => `${a.ip}/${a.prefix}`;

/** The way out of every device that has a default route, keyed by the address the device was read on. */
export function followDefaultRoutes(devices: GearDevice[]): Map<string, WayOut> {
  const ipNum = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + (Number(o) || 0), 0);
  // An address two devices hold belongs to the lower-addressed one, whatever order they were read in.
  const owner = new Map<string, string>();
  for (const d of [...devices].sort((x, y) => ipNum(x.ip) - ipNum(y.ip))) for (const ip of [d.ip, ...(d.addresses ?? []).map((a) => a.ip)]) if (usable(ip) && !owner.has(ip)) owner.set(ip, d.ip);
  const out = new Map<string, WayOut>();
  for (const d of devices) {
    const nextHop = d.defaultRoute?.nextHop;
    if (!nextHop || !usable(nextHop) || owner.get(nextHop) === d.ip) continue;
    const published = d.defaultRoute?.ifIndex;
    // The most specific of the device's networks that holds the next hop.
    const holding = (d.addresses ?? [])
      .filter((a) => usable(a.ip) && a.prefix > 0 && a.prefix < 32 && inCidr(nextHop, networkOf(a)))
      .sort((a, b) => b.prefix - a.prefix)[0];
    const ifIndex = published && d.interfaces.some((i) => i.ifIndex === published) ? published : holding?.ifIndex;
    const way: WayOut = { nextHop };
    if (ifIndex !== undefined) way.ifIndex = ifIndex;
    const via = owner.get(nextHop);
    if (via) way.via = via;
    out.set(d.ip, way);
  }
  return out;
}
