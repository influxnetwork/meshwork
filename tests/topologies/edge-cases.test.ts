import { describe, expect, it } from 'vitest';
import type { Asset, GearDevice } from '@shared/types';
import { unscannedNetworks } from '@shared/unscanned';
import { buildTopology, layoutTree, type Topology } from '../../src/renderer/src/map-model';
import { asset, gear } from './scenarios';

const draw = (network: { gatewayIp?: string; gatewayMac?: string; cidr?: string }, assets: Asset[], devices: GearDevice[]): Topology =>
  buildTopology(network, assets, { clients: true, collapsed: new Set() }, { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: devices.length, devices });
const nodeOf = (t: Topology, label: string) => t.nodes.find((n) => n.label === label)?.id as string;
const into = (t: Topology, id: string) => t.edges.filter((e) => e.target === id);
const orders = <T>(list: T[]): T[][] => [...list.map((_, i) => [...list.slice(i), ...list.slice(0, i)]), [...list].reverse()];
const shape = (t: Topology) => [...t.edges.map((e) => `${e.source}>${e.target}:${e.inferred}`), ...(t.peers ?? []).map((e) => `peer ${[e.source, e.target].sort().join('~')}`)].sort();

describe('maps that once drew a device twice or depended on reading order', () => {
  it('a firewall that is not managed, found by the scan and also heard as a neighbour, heads the map once', () => {
    const fw = asset('10.255.0.1', 'firewall');
    const core = gear('10.0.10.1', 'CORE', {
      ports: { 'Gi1/0/48': '10.255.0.2/30', Vl10: '10.0.10.1/24', Vl20: '10.0.20.1/24' },
      routes: true,
      switches: true,
      route: { nextHop: '10.255.0.1' },
      hears: [['Gi1/0/48', 'FW', '10.255.0.1', 'port1']],
    });
    const t = draw({ gatewayIp: '10.0.10.1', cidr: '10.0.10.0/24,10.255.0.0/30' }, [asset('10.0.10.1', 'switch'), fw], [core]);
    expect(into(t, fw.id).map((e) => e.source)).toEqual(['internet']);
    expect(t.edges.filter((e) => e.source === fw.id)).toMatchObject([{ targetPort: 'Gi1/0/48', inferred: false }]);
    expect(Object.keys(layoutTree(t).positions)).toEqual(expect.arrayContaining(t.nodes.map((n) => n.id)));
  });

  it('lays out a map whose links loop instead of never ending', () => {
    const t: Topology = {
      nodes: [{ id: 'internet', kind: 'internet' }, { id: 'a', kind: 'device' }, { id: 'b', kind: 'device' }],
      edges: [
        { id: 'internet->a', source: 'internet', target: 'a', inferred: true },
        { id: 'a->b', source: 'a', target: 'b', inferred: false },
        { id: 'b->a', source: 'b', target: 'a', inferred: false },
      ],
      confirmed: true,
    };
    expect(Object.keys(layoutTree(t).positions).sort()).toEqual(['a', 'b', 'internet']);
  });

  it('a neighbour heard by two switches, or on two ports of one, hangs from one port only', () => {
    const ap = asset('10.0.0.50', 'ap');
    const s1 = gear('10.0.0.2', 'S1', { ports: { p1: undefined, p2: undefined, Vlan1: '10.0.0.2/24' }, switches: true, hears: [['p2', 'AP', '10.0.0.50', 'eth0'], ['p1', 'AP', '10.0.0.50', 'eth1']] });
    const s2 = gear('10.0.0.3', 'S2', { ports: { p1: undefined, p2: undefined, Vlan1: '10.0.0.3/24' }, switches: true, hears: [['p2', 'AP', '10.0.0.50', 'eth0']] });
    const assets = [asset('10.0.0.1', 'router'), asset('10.0.0.2', 'switch'), asset('10.0.0.3', 'switch'), ap];
    for (const devices of orders([s1, s2])) {
      const t = draw({ gatewayIp: '10.0.0.1', cidr: '10.0.0.0/24' }, assets, devices);
      expect(into(t, ap.id)).toMatchObject([{ source: nodeOf(t, 'S1'), sourcePort: 'p1' }]);
      expect(new Set(t.edges.map((e) => e.id)).size).toBe(t.edges.length);
    }
  });

  it('a cable wins over a route whatever order the devices were read in', () => {
    const a = gear('10.7.0.1', 'A', { ports: { up: '192.168.0.2/24', lan: '10.7.0.1/24' }, routes: true, route: { nextHop: '192.168.0.1' }, hears: [['lan', 'X', '10.7.0.9', 'e0']] });
    const b = gear('10.8.0.1', 'B', { ports: { up: '192.168.0.3/24', lan: '10.8.0.1/24', far: '10.7.0.2/24' }, routes: true, route: { nextHop: '192.168.0.1' } });
    const x = gear('10.7.0.9', 'X', { ports: { e0: '10.7.0.9/24' }, routes: true, route: { nextHop: '10.7.0.2' }, hears: [['e0', 'A', '10.7.0.1', 'lan']] });
    const assets = [asset('192.168.0.1', 'router')];
    const expected = shape(draw({ gatewayIp: '192.168.0.1', cidr: '192.168.0.0/24' }, assets, [a, b, x]));
    for (const devices of orders([a, b, x])) {
      const t = draw({ gatewayIp: '192.168.0.1', cidr: '192.168.0.0/24' }, assets, devices);
      expect(shape(t)).toEqual(expected);
      expect(into(t, nodeOf(t, 'X'))).toMatchObject([{ source: nodeOf(t, 'A'), inferred: false }]);
    }
  });

  it('a switch joins the tree of the router it is plugged into, not the first one drawn', () => {
    const r1 = gear('10.1.0.1', 'R1', { ports: { wan: '203.0.113.2/30', lan: '10.1.0.1/24' }, routes: true, route: { nextHop: '203.0.113.1' }, hears: [['lan', 'S1', '10.1.0.2', 'p1']] });
    const r2 = gear('10.2.0.1', 'R2', { ports: { wan: '198.51.100.2/30', lan: '10.2.0.1/24' }, routes: true, route: { nextHop: '198.51.100.1' }, hears: [['lan', 'S2', '10.2.0.2', 'p1']] });
    const s1 = gear('10.1.0.2', 'S1', { ports: { p1: undefined, p2: undefined, Vlan1: '10.1.0.2/24' }, switches: true, hears: [['p1', 'R1', '10.1.0.1', 'lan'], ['p2', 'S2', '10.2.0.2', 'p2']] });
    const s2 = gear('10.2.0.2', 'S2', { ports: { p1: undefined, p2: undefined, Vlan1: '10.2.0.2/24' }, switches: true, hears: [['p1', 'R2', '10.2.0.1', 'lan'], ['p2', 'S1', '10.1.0.2', 'p2']] });
    const t = draw({ gatewayIp: '10.1.0.1', cidr: '10.1.0.0/24,10.2.0.0/24' }, [asset('10.1.0.1', 'router')], [r1, r2, s1, s2]);
    expect(into(t, nodeOf(t, 'S2'))).toMatchObject([{ source: nodeOf(t, 'R2') }]);
    expect(t.peers).toMatchObject([{ source: nodeOf(t, 'S1'), target: nodeOf(t, 'S2') }]);
  });

  it("keeps a router's VLAN networks on its cable when the router hangs below the switch", () => {
    const sw = gear('10.0.0.2', 'SW', { ports: { p1: undefined, p2: undefined, Vlan1: '10.0.0.2/24' }, switches: true, hears: [['p2', 'R2', '10.0.0.9', 'Gi0']], learned: [['aa:00:00:00:09:01', 'p1']] });
    const r2 = gear('10.0.0.9', 'R2', { ports: { Gi0: undefined, 'Gi0.1': '10.0.0.9/24', 'Gi0.10': '10.0.10.1/24' }, routes: true, route: { nextHop: '10.0.0.1' }, hears: [['Gi0', 'SW', '10.0.0.2', 'p2']] });
    const t = draw({ gatewayIp: '10.0.0.1', gatewayMac: 'aa:00:00:00:09:01', cidr: '10.0.0.0/24' }, [asset('10.0.0.1', 'router', 'aa:00:00:00:09:01')], [sw, r2]);
    const cable = t.edges.find((e) => e.source === nodeOf(t, 'SW') && e.target === nodeOf(t, 'R2'));
    expect(cable).toMatchObject({ routesAtTarget: true });
    // The subinterface its default route leaves through is its way out, not a network it serves.
    expect(cable?.routes?.map((r) => r.vlan)).toEqual([10]);
  });

  it("a next hop on the gateway's other address does not start a second tree", () => {
    const l3 = gear('192.168.0.9', 'L3', {
      ports: { p1: undefined, Vlan1: '192.168.0.9/24', Vlan5: '10.0.5.9/24' },
      routes: true,
      switches: true,
      route: { nextHop: '10.0.5.1' },
      learned: [['aa:00:00:00:0a:01', 'p1']],
    });
    const t = draw({ gatewayIp: '192.168.0.1', gatewayMac: 'aa:00:00:00:0a:01', cidr: '192.168.0.0/24' }, [asset('192.168.0.1', 'router', 'aa:00:00:00:0a:01'), asset('192.168.0.9', 'switch')], [l3]);
    expect(t.roots).toEqual(['internet']);
    expect(t.peers).toBeUndefined();
  });

  it('does not offer a network that a scanned range of addresses covers', () => {
    const r = gear('10.0.0.1', 'R1', { ports: { lan: '10.0.0.1/24', lab: '192.168.200.1/24', dmz: '10.0.9.1/24' }, routes: true });
    expect(unscannedNetworks([r], '10.0.0.1-10.0.0.254, 192.168.200.0-192.168.200.255', []).map((n) => n.cidr)).toEqual(['10.0.9.0/24']);
  });
});
