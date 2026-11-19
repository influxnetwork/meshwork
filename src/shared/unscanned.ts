/**
 * Networks the managed routers hold that were not scanned: each is a place where devices the map
 * does not know may be. The one a default route leaves through comes first, since the device the
 * network goes out by is there.
 */
import { followDefaultRoutes } from './default-routes';
import { inCidr } from './report';
import type { GearDevice, Network } from './types';

/** Every range scanned for a network, comma-separated: the ranges that name it and those scanned into it. */
export const scannedRanges = (network: Pick<Network, 'cidr' | 'alsoScanned'>): string => [network.cidr, network.alsoScanned].filter(Boolean).join(', ');

export interface UnscannedNetwork {
  /** The network, as CIDR text ready to scan. */
  cidr: string;
  /** The managed device that holds it, and the interface it is on. */
  device: string;
  port?: string;
  /** Set when the device's default route leaves through this network: the next hop to look for. */
  nextHop?: string;
}

const ipNum = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + (Number(p) || 0), 0);
const isPrivate = (ip: string) => {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
};
const networkOf = (ip: string, prefix: number) => {
  const size = 2 ** (32 - prefix);
  const base = Math.floor(ipNum(ip) / size) * size;
  return { cidr: `${[base >>> 24, (base >>> 16) & 255, (base >>> 8) & 255, base & 255].join('.')}/${prefix}`, base, size };
};

/** Largest network offered: scanning more than about a thousand addresses is a choice for Discover. */
const MIN_PREFIX = 22;

/**
 * `scanned` is the network's scanned ranges (comma-separated); `known` are the addresses of its
 * inventory. A network is left out when a scanned range covers it, when the inventory already has
 * a device in it that is not one of the managed devices, or when the managed devices own every
 * address it has (a point-to-point link between two of them).
 */
export function unscannedNetworks(devices: GearDevice[], scanned: string, known: string[]): UnscannedNetwork[] {
  // Scanned ranges as first and last address: CIDR blocks and "first-last" ranges.
  const ranges = scanned.split(',').flatMap((text): [number, number][] => {
    const r = text.trim();
    const block = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(r);
    if (block) {
      const net = networkOf(block[1] as string, Number(block[2]));
      return [[net.base, net.base + net.size - 1]];
    }
    const span = /^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/.exec(r);
    return span ? [[ipNum(span[1] as string), ipNum(span[2] as string)]] : [];
  });
  const own = new Set(devices.flatMap((d) => [d.ip, ...(d.addresses ?? []).map((a) => a.ip)]));
  const routes = followDefaultRoutes(devices);
  const out = new Map<string, UnscannedNetwork>();
  for (const d of [...devices].sort((x, y) => ipNum(x.ip) - ipNum(y.ip))) {
    const way = routes.get(d.ip);
    for (const a of d.addresses ?? []) {
      if (a.prefix < MIN_PREFIX || a.prefix > 30 || !isPrivate(a.ip)) continue;
      if (d.interfaces.find((i) => i.ifIndex === a.ifIndex)?.up === false) continue;
      const net = networkOf(a.ip, a.prefix);
      const last = net.base + net.size - 1;
      if (ranges.some(([from, to]) => from <= last && to >= net.base)) continue;
      if (known.some((ip) => !own.has(ip) && inCidr(ip, net.cidr))) continue;
      // Hosts of the network (without its network and broadcast addresses) the managed devices do not own.
      if (net.size <= 4 && [net.base + 1, net.base + 2].every((n) => [...own].some((ip) => ipNum(ip) === n))) continue;
      const nextHop = way && !way.via && inCidr(way.nextHop, net.cidr) ? way.nextHop : undefined;
      const prev = out.get(net.cidr);
      if (!prev || (nextHop && !prev.nextHop)) out.set(net.cidr, { cidr: net.cidr, device: d.sysName ?? d.ip, port: d.interfaces.find((i) => i.ifIndex === a.ifIndex)?.name, nextHop });
    }
  }
  return [...out.values()].sort((x, y) => Number(!!y.nextHop) - Number(!!x.nextHop) || ipNum(x.cidr.split('/')[0] as string) - ipNum(y.cidr.split('/')[0] as string));
}
