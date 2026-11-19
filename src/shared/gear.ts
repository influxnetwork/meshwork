/**
 * Readings of managed devices taken over SNMP. A router or layer 3 switch answers on each of its
 * addresses, so a scan of several of its networks reads it once per address.
 */
import type { GearDevice } from './types';

const placeholder = (ip: string) => ip === '0.0.0.0' || ip.startsWith('127.');

/**
 * True when two readings can be the same device: their bridge addresses agree when both have one,
 * otherwise their names agree when both have one.
 */
function sameDevice(a: GearDevice, b: GearDevice): boolean {
  if (a.mac && b.mac) return a.mac === b.mac;
  if (a.sysName && b.sysName) return a.sysName === b.sysName;
  return true;
}

/** The addresses a reading lists as the device's own, in a fixed order. */
const listed = (d: GearDevice): string[] => (d.addresses ?? []).map((a) => a.ip).filter((ip) => !placeholder(ip)).sort();

/**
 * One reading per device: a reading taken on an address that an earlier reading lists as one of
 * its own is the same device, and is left out, unless the two readings show different devices (a
 * leftover address on one device can be another device's own). So is a reading that lists exactly
 * the addresses an earlier one lists: a router also answers on the network and broadcast addresses
 * of its links, which are not in its list. The first reading of a device is the one kept; when it
 * was taken on an address the device does not list and a later one on an address it does, the
 * reading kept is given that address. Order is kept.
 */
export function uniqueGear(devices: GearDevice[]): GearDevice[] {
  const owner = new Map<string, GearDevice>();
  const bySet = new Map<string, GearDevice>();
  const out: GearDevice[] = [];
  for (const d of devices) {
    const own = listed(d);
    const key = own.join(',');
    const holder = owner.get(d.ip);
    const twin = own.length ? bySet.get(key) : undefined;
    const same = holder && sameDevice(holder, d) ? holder : twin && sameDevice(twin, d) ? twin : undefined;
    if (same) {
      if (!listed(same).includes(same.ip) && own.includes(d.ip)) {
        const moved = { ...same, ip: d.ip };
        out[out.indexOf(same)] = moved;
        for (const [ip, o] of owner) if (o === same) owner.set(ip, moved);
        for (const [k, o] of bySet) if (o === same) bySet.set(k, moved);
      }
      continue;
    }
    out.push(d);
    owner.set(d.ip, d);
    for (const ip of own) if (!owner.has(ip)) owner.set(ip, d);
    if (own.length && !bySet.has(key)) bySet.set(key, d);
  }
  return out;
}
