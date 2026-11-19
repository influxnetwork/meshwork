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

  it('keeps one reading of a router that also answered on the network and broadcast addresses of its links', () => {
    // Two /30 links: .3 is the broadcast address of the first and .4 the network address of the second.
    const links = ['10.0.0.130', '172.20.255.1', '172.20.255.5'];
    const out = uniqueGear([reading('172.20.255.4', 'R1', links), reading('172.20.255.3', 'R1', links), reading('172.20.255.6', 'CORE2', ['172.20.255.6']), reading('172.20.255.5', 'R1', links)]);
    // The first reading is kept, under the address of its own that a later reading was taken on.
    expect(out.map((d) => d.ip)).toEqual(['172.20.255.5', '172.20.255.6']);
    const fresh = { ...reading('172.20.255.4', 'R1', links), sysDescr: 'fresh' };
    expect(uniqueGear([fresh, { ...reading('172.20.255.1', 'R1', links), sysDescr: 'stored' }])).toMatchObject([{ ip: '172.20.255.1', sysDescr: 'fresh' }]);
    expect(uniqueGear([reading('172.20.255.5', 'R1', links), reading('172.20.255.3', 'R1', links)]).map((d) => d.ip)).toEqual(['172.20.255.5']);
    // With no reading on an address of its own, the first one stands.
    expect(uniqueGear([reading('172.20.255.4', 'R1', links), reading('172.20.255.3', 'R1', links)]).map((d) => d.ip)).toEqual(['172.20.255.4']);
  });

  it('keeps two devices that list the same addresses under different names', () => {
    const shared = ['192.168.1.1'];
    expect(uniqueGear([reading('10.0.0.2', 'A', shared), reading('10.0.0.3', 'B', shared)])).toHaveLength(2);
  });

  it('ignores placeholder addresses when matching', () => {
    const out = uniqueGear([reading('10.0.0.2', 'A', ['0.0.0.0', '127.0.0.1', '10.0.0.2']), reading('10.0.0.3', 'B', ['0.0.0.0', '127.0.0.1', '10.0.0.3'])]);
    expect(out).toHaveLength(2);
  });
});
