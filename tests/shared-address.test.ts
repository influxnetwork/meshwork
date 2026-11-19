import { describe, expect, it } from 'vitest';
import type { GearDevice } from '../src/shared/types';
import { sharedAddressProtocol, withSharedAddresses } from '../src/shared/shared-address';
import { gear } from './topologies/scenarios';

const SHARED_MAC = '00:00:0c:07:ac:14';
const router = (ip: string, name: string, lan: string, extra: Partial<Parameters<typeof gear>[2]> = {}) => gear(ip, name, { ports: { wan: undefined, lan: `${lan}/24` }, routes: true, ...extra });
const orders = <T>(list: T[]): T[][] => [...list.map((_, i) => [...list.slice(i), ...list.slice(0, i)]), [...list].reverse()];
/** The name of the device that lists `ip` among its addresses after shared addresses are given out. */
const holder = (devices: GearDevice[], ip: string, macs: Map<string, string>) => withSharedAddresses(devices, macs).filter((d) => d.addresses?.some((a) => a.ip === ip)).map((d) => d.sysName);

describe('addresses several routers share', () => {
  it('tells the protocol from the range the address belongs to', () => {
    expect(sharedAddressProtocol('00:00:0c:07:ac:14')).toBe('HSRP');
    expect(sharedAddressProtocol('00:00:0C:9F:F0:14')).toBe('HSRP');
    expect(sharedAddressProtocol('00:00:5e:00:01:0a')).toBe('VRRP');
    expect(sharedAddressProtocol('00:07:b4:00:01:01')).toBe('GLBP');
    expect(sharedAddressProtocol('00:00:0c:12:34:56')).toBeUndefined();
    expect(sharedAddressProtocol(undefined)).toBeUndefined();
  });

  it('gives a shared address no reading lists to the router with the lowest address, in any reading order', () => {
    const macs = new Map([['10.0.0.1', SHARED_MAC]]);
    for (const devices of orders([router('10.0.0.3', 'R2', '10.0.0.3'), router('10.0.0.2', 'R1', '10.0.0.2'), router('10.9.0.2', 'R9', '10.9.0.2')])) {
      expect(holder(devices, '10.0.0.1', macs)).toEqual(['R1']);
    }
  });

  it('gives it to the router a switch learned the address towards, when a switch tells', () => {
    const macs = new Map([['10.0.0.1', SHARED_MAC]]);
    const sw = gear('10.0.0.5', 'SW1', { ports: { p1: undefined, p2: undefined, Vlan1: '10.0.0.5/24' }, switches: true, learned: [[SHARED_MAC, 'p2']], hears: [['p1', 'R1', '10.0.0.2', 'lan'], ['p2', 'R2', '10.0.0.3', 'lan']] });
    for (const devices of orders([router('10.0.0.2', 'R1', '10.0.0.2'), router('10.0.0.3', 'R2', '10.0.0.3'), sw])) {
      expect(holder(devices, '10.0.0.1', macs)).toEqual(['R2']);
    }
  });

  it('does not give it to a router that learned the shared address itself, though a switch below hears that router', () => {
    // R2 (lower address) is the one in waiting: it learned the shared address towards R1, which answers for it.
    // The access switch below R2 learned it on the port where it hears R2.
    const macs = new Map([['10.0.0.1', SHARED_MAC]]);
    const active = gear('10.0.0.3', 'R1', { ports: { down: undefined, lan: '10.0.0.3/24' }, routes: true, switches: true, hears: [['down', 'R2', '10.0.0.2', 'up']] });
    const waiting = gear('10.0.0.2', 'R2', { ports: { up: undefined, down: undefined, lan: '10.0.0.2/24' }, routes: true, switches: true, learned: [[SHARED_MAC, 'up']], hears: [['up', 'R1', '10.0.0.3', 'down'], ['down', 'SW3', '10.0.0.5', 'p1']] });
    const access = gear('10.0.0.5', 'SW3', { ports: { p1: undefined, Vlan1: '10.0.0.5/24' }, switches: true, learned: [[SHARED_MAC, 'p1']], hears: [['p1', 'R2', '10.0.0.2', 'down']] });
    for (const devices of orders([active, waiting, access])) expect(holder(devices, '10.0.0.1', macs)).toEqual(['R1']);
    // The switch below alone tells nothing: it hears the router on the way, not the one that answers.
    for (const devices of orders([{ ...waiting, fdb: [] }, active, access])) expect(holder(devices, '10.0.0.1', macs)).toEqual(['R2']);
  });

  it('gives an address answered with several MAC addresses to the router with the lowest address', () => {
    // Each router answers for the address with a MAC address of its own; a switch learned one of them towards R2.
    const macs = new Map([['10.0.0.1', '00:07:b4:00:01:02']]);
    const sw = gear('10.0.0.5', 'SW1', { ports: { p1: undefined, p2: undefined, Vlan1: '10.0.0.5/24' }, switches: true, learned: [['00:07:b4:00:01:02', 'p2']], hears: [['p1', 'R1', '10.0.0.2', 'lan'], ['p2', 'R2', '10.0.0.3', 'lan']] });
    for (const devices of orders([router('10.0.0.2', 'R1', '10.0.0.2'), router('10.0.0.3', 'R2', '10.0.0.3'), sw])) {
      expect(holder(devices, '10.0.0.1', macs)).toEqual(['R1']);
    }
  });

  it('gives each of several shared addresses to a router on its own network', () => {
    const macs = new Map([['10.0.0.1', SHARED_MAC], ['10.0.9.1', '00:00:5e:00:01:09'], ['10.0.0.254', '00:00:0C:07:AC:15']]);
    const both = gear('10.0.0.2', 'R1', { ports: { a: '10.0.0.2/24', b: '10.0.9.2/25' }, routes: true });
    const given = withSharedAddresses([both, router('10.0.0.3', 'R2', '10.0.0.3')], macs);
    expect(given.find((d) => d.sysName === 'R1')?.addresses).toEqual(expect.arrayContaining([{ ip: '10.0.0.1', prefix: 24, ifIndex: 1, assumed: true }, { ip: '10.0.0.254', prefix: 24, ifIndex: 1, assumed: true }, { ip: '10.0.9.1', prefix: 25, ifIndex: 2, assumed: true }]));
    expect(given.find((d) => d.sysName === 'R2')?.addresses).toHaveLength(1);
  });

  it('adds the address on the interface that is on its network, with the prefix that network has', () => {
    const [r1] = withSharedAddresses([router('10.0.0.2', 'R1', '10.0.0.2')], new Map([['10.0.0.1', SHARED_MAC]]));
    expect(r1?.addresses).toContainEqual({ ip: '10.0.0.1', prefix: 24, ifIndex: 2, assumed: true });
  });

  it('changes nothing when a router already lists the address, when none is on its network, or when the address is not a shared one', () => {
    const listed = router('10.0.0.2', 'R1', '10.0.0.2');
    listed.addresses?.push({ ip: '10.0.0.1', prefix: 24, ifIndex: 2 });
    const devices = [listed, router('10.0.0.3', 'R2', '10.0.0.3')];
    expect(withSharedAddresses(devices, new Map([['10.0.0.1', SHARED_MAC]]))).toEqual(devices);
    expect(withSharedAddresses(devices, new Map([['192.168.50.1', SHARED_MAC]]))).toEqual(devices);
    expect(withSharedAddresses(devices, new Map([['10.0.0.9', 'aa:00:00:00:00:09']]))).toEqual(devices);
    // The readings given are not altered: a device that gains an address is a copy.
    const plain = [router('10.0.0.2', 'R1', '10.0.0.2')];
    withSharedAddresses(plain, new Map([['10.0.0.1', SHARED_MAC]]));
    expect(plain[0]?.addresses).toHaveLength(1);
  });

  it('gives it only to a device that routes', () => {
    const sw = gear('10.0.0.2', 'SW1', { ports: { p1: undefined, Vlan1: '10.0.0.2/24' }, switches: true });
    expect(holder([sw, router('10.0.0.3', 'R2', '10.0.0.3')], '10.0.0.1', new Map([['10.0.0.1', SHARED_MAC]]))).toEqual(['R2']);
  });
});
