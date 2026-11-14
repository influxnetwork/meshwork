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

/**
 * One reading per device: a reading taken on an address that an earlier reading lists as one of
 * its own is the same device, and is left out, unless the two readings show different devices (a
 * leftover address on one device can be another device's own). Order is kept.
 */
export function uniqueGear(devices: GearDevice[]): GearDevice[] {
  const owner = new Map<string, GearDevice>();
  const out: GearDevice[] = [];
  for (const d of devices) {
    const o = owner.get(d.ip);
    if (o && sameDevice(o, d)) continue;
    out.push(d);
    owner.set(d.ip, d);
    for (const a of d.addresses ?? []) if (!placeholder(a.ip) && !owner.has(a.ip)) owner.set(a.ip, d);
  }
  return out;
}
