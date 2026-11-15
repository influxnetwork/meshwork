import { describe, expect, it } from 'vitest';
import { unscannedNetworks } from '@shared/unscanned';
import { gear } from './topologies/scenarios';

describe('networks the managed routers hold that were not scanned', () => {
  const core = gear('172.20.0.1', 'CORE', {
    ports: { 'Et1/0': '172.20.255.2/30', Vl10: '172.20.10.1/24', Vl20: '172.20.20.1/24', Vl99: '172.20.0.1/24', Tu0: '172.20.254.1/30' },
    routes: true,
    switches: true,
    route: { nextHop: '172.20.255.1' },
  });
  const branch = gear('172.20.30.1', 'BRANCH', { ports: { 'Et0/0': '198.51.100.2/30', 'Et0/1': '172.20.30.1/24', Tu0: '172.20.254.2/30' }, routes: true, route: { nextHop: '172.20.254.1' } });

  it('offers the network a default route leaves through first, with the next hop to look for', () => {
    const found = unscannedNetworks([core, branch], '172.20.0.0/24, 172.20.10.0/24', ['172.20.0.1', '172.20.10.11']);
    expect(found[0]).toEqual({ cidr: '172.20.255.0/30', device: 'CORE', port: 'Et1/0', nextHop: '172.20.255.1' });
    expect(found.slice(1).map((n) => n.cidr)).toEqual(['172.20.20.0/24', '172.20.30.0/24']);
  });

  it('leaves out scanned networks, links whose every address is a managed device, and public networks', () => {
    const cidrs = unscannedNetworks([core, branch], '172.20.0.0/24, 172.20.10.0/24, 172.20.20.0/24, 172.20.30.0/24, 172.20.255.0/30', []).map((n) => n.cidr);
    expect(cidrs).toEqual([]);
  });

  it('leaves out a network the inventory already has a device in, and one covered by a wider scanned range', () => {
    expect(unscannedNetworks([core], '172.20.0.0/16', [])).toEqual([]);
    const cidrs = unscannedNetworks([core], '172.20.0.0/24', ['172.20.20.12', '172.20.255.1']).map((n) => n.cidr);
    // The far end of the tunnel was not read, so its network may still hold an unknown device.
    expect(cidrs).toEqual(['172.20.10.0/24', '172.20.254.0/30']);
  });

  it('does not offer very large networks', () => {
    const r = gear('10.0.0.1', 'R1', { ports: { lan: '10.0.0.1/8', lab: '10.200.4.1/22' }, routes: true });
    expect(unscannedNetworks([r], '192.168.1.0/24', []).map((n) => n.cidr)).toEqual(['10.200.4.0/22']);
  });
});
