import { describe, expect, it } from 'vitest';
import { byLastBytes, relaysOnPort as relaysWith } from '../src/shared/relayed-address';

/** The extenders on a port, from the addresses it learned and the MAC addresses of the inventory. */
const relaysOnPort = (learned: string[], known: string[]) => relaysWith(learned, byLastBytes(known));

// An extender whose real address ends 44:55:66 gives every address it relays the prefix 46:55:66
// (its own last three bytes, marked as locally administered) and keeps the device's last three.
const EXTENDER = 'a0:b1:c2:44:55:66';
const SELF = '46:55:66:44:55:66';
const LAPTOP = 'a0:b1:c2:11:22:33';
const PLAYER = 'd0:e1:f2:0a:0b:0c';
const relayed = (real: string) => `46:55:66:${real.slice(9)}`;

describe('addresses an extender rewrites', () => {
  it('finds the extender by its own rewritten address, and the device each rewritten address stands for', () => {
    const [relay, ...more] = relaysOnPort([SELF, relayed(LAPTOP), relayed(PLAYER), '46:55:66:77:88:99', 'a0:b1:c2:de:ad:01'], [EXTENDER, LAPTOP, PLAYER, 'a0:b1:c2:de:ad:01']);
    expect(more).toEqual([]);
    expect(relay).toMatchObject({ prefix: '46:55:66', self: SELF, realMac: EXTENDER });
    expect([...(relay?.alias ?? [])]).toEqual([[relayed(PLAYER), PLAYER], [relayed(LAPTOP), LAPTOP]]);
    // Every rewritten address is the extender's, also the one no inventory device matches.
    expect(relay?.members).toEqual([relayed(PLAYER), relayed(LAPTOP), SELF, '46:55:66:77:88:99'].sort());
  });

  it('marks the prefix as locally administered whatever the extender address has there', () => {
    // 0x82 already has the bit; 0x80 gets it.
    expect(relaysOnPort(['82:aa:01:82:aa:01'], [])[0]).toMatchObject({ prefix: '82:aa:01', self: '82:aa:01:82:aa:01' });
    expect(relaysOnPort(['82:aa:01:80:aa:01'], [])[0]).toMatchObject({ prefix: '82:aa:01', self: '82:aa:01:80:aa:01' });
  });

  it('is found without its own address when two rewritten addresses each stand for one inventory device', () => {
    const [relay] = relaysOnPort([relayed(LAPTOP), relayed(PLAYER)], [LAPTOP, PLAYER]);
    expect(relay).toMatchObject({ prefix: '46:55:66', self: undefined, realMac: undefined });
    expect(relay?.alias.size).toBe(2);
  });

  it('is not found from one matching address alone, nor from private addresses that only share a prefix', () => {
    expect(relaysOnPort([relayed(LAPTOP)], [LAPTOP, PLAYER])).toEqual([]);
    expect(relaysOnPort(['46:55:66:01:02:03', '46:55:66:04:05:06', '46:55:66:07:08:09'], [LAPTOP, PLAYER])).toEqual([]);
    // Addresses that are not locally administered are never rewritten ones.
    expect(relaysOnPort(['44:55:66:44:55:66', `44:55:66:${LAPTOP.slice(9)}`, `44:55:66:${PLAYER.slice(9)}`], [LAPTOP, PLAYER])).toEqual([]);
  });

  it('leaves a rewritten address without a device when two inventory devices end the same', () => {
    const twin = 'd0:e1:f2:11:22:33';
    const [relay] = relaysOnPort([SELF, relayed(LAPTOP), relayed(PLAYER)], [EXTENDER, LAPTOP, twin, PLAYER]);
    expect([...(relay?.alias ?? [])]).toEqual([[relayed(PLAYER), PLAYER]]);
    expect(relay?.members).toContain(relayed(LAPTOP));
  });

  it('does not take an inventory device that holds a rewritten address as the device another one stands for', () => {
    // The inventory may hold a device under its rewritten address: that address is its own member.
    const [relay] = relaysOnPort([SELF, relayed(LAPTOP)], [EXTENDER, relayed(LAPTOP)]);
    expect(relay?.alias.size).toBe(0);
    expect(relay?.members).toEqual([relayed(LAPTOP), SELF].sort());
  });

  it('tells two extenders on one port apart, and reads addresses in any letter case', () => {
    const other = 'a0:b1:c2:aa:bb:cc';
    const relays = relaysOnPort([SELF.toUpperCase(), 'AA:BB:CC:AA:BB:CC', relayed(LAPTOP)], [EXTENDER, other.toUpperCase(), LAPTOP]);
    expect(relays.map((r) => [r.prefix, r.realMac])).toEqual([['46:55:66', EXTENDER], ['aa:bb:cc', other]]);
  });
});
