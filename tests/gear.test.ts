import { describe, expect, it } from 'vitest';
import type { GearDevice } from '../src/shared/types';
import { uniqueGear } from '../src/shared/gear';

const reading = (ip: string, sysName: string, addresses: string[] = []): GearDevice => ({
  ip,
  sysName,
  addresses: addresses.map((a, i) => ({ ip: a, prefix: 24, ifIndex: i + 1 })),
  interfaces: [],
  neighbors: [],
  fdb: [],
  arp: [],
});

describe('one reading per device', () => {
  // A router-on-a-stick network: R1 answered SNMP on each of its addresses, so it was read three times.
  const r1 = ['10.0.0.130', '172.20.10.1', '172.20.20.1', '172.20.99.1'];

  it('keeps one reading of a device that answered on several of its addresses', () => {
    const out = uniqueGear([reading('172.20.20.1', 'R1', r1), reading('172.20.99.2', 'CORE', ['172.20.99.2']), reading('172.20.99.1', 'R1', r1), reading('172.20.10.1', 'R1', r1)]);
    expect(out.map((d) => d.ip)).toEqual(['172.20.20.1', '172.20.99.2']);
  });

  it('keeps devices whose addresses do not overlap, even with the same name', () => {
    const out = uniqueGear([reading('10.0.0.2', 'SW', ['10.0.0.2']), reading('10.0.0.3', 'SW', ['10.0.0.3']), reading('10.0.0.4', 'SW')]);
    expect(out).toHaveLength(3);
  });

  it('keeps a different device read on an address another device also lists', () => {
    // A switch with a leftover default address on an unused interface, the router's own address.
    const sw = { ...reading('10.0.0.2', 'SW', ['10.0.0.2', '192.168.1.1']), mac: 'aa:aa:aa:aa:aa:01' };
    const router = { ...reading('192.168.1.1', 'EDGE', ['192.168.1.1']), mac: 'aa:aa:aa:aa:aa:02' };
    expect(uniqueGear([sw, router]).map((d) => d.ip)).toEqual(['10.0.0.2', '192.168.1.1']);
    // Without a bridge address the name tells them apart.
    expect(uniqueGear([reading('10.0.0.2', 'SW', ['10.0.0.2', '192.168.1.1']), reading('192.168.1.1', 'EDGE')])).toHaveLength(2);
  });

  it('ignores placeholder addresses when matching', () => {
    const out = uniqueGear([reading('10.0.0.2', 'A', ['0.0.0.0', '127.0.0.1', '10.0.0.2']), reading('10.0.0.3', 'B', ['0.0.0.0', '127.0.0.1', '10.0.0.3'])]);
    expect(out).toHaveLength(2);
  });
});
