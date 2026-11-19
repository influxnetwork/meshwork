import { describe, expect, it } from 'vitest';
import type { Asset, GearDevice } from '@shared/types';
import { scannedRanges, unscannedNetworks } from '@shared/unscanned';
import { GATEWAY_ROW, NODE_SIZE, ROUTES_ROW, buildTopology, gatewayLine, layoutTree, type Topology } from '../../src/renderer/src/map-model';
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

  it('does not offer again a network that was scanned into this one and where nobody answered', () => {
    const r = gear('10.0.0.1', 'R1', { ports: { lan: '10.0.0.1/24', lab: '192.168.200.1/24', dmz: '10.0.9.1/24' }, routes: true });
    expect(unscannedNetworks([r], scannedRanges({ cidr: '10.0.0.0/24' }), []).map((n) => n.cidr)).toEqual(['10.0.9.0/24', '192.168.200.0/24']);
    expect(unscannedNetworks([r], scannedRanges({ cidr: '10.0.0.0/24', alsoScanned: '192.168.200.0/24' }), []).map((n) => n.cidr)).toEqual(['10.0.9.0/24']);
  });
});

describe('an extender that rewrites the addresses of the devices behind it', () => {
  const GW = 'aa:00:00:00:08:01';
  const network = { gatewayIp: '192.168.1.1', gatewayMac: GW, cidr: '192.168.1.0/24' };
  // The extender's real address ends 44:55:66: it relays every address as 46:55:66 plus the device's last three bytes.
  const [EXTENDER, SELF, LAPTOP, PLAYER, PHONE] = ['a0:b1:c2:44:55:66', '46:55:66:44:55:66', 'a0:b1:c2:11:22:33', 'd0:e1:f2:0a:0b:0c', 'a0:b1:c2:99:99:01'];
  const relayed = (real: string) => `46:55:66:${real.slice(9)}`;
  const PRINTER = relayed('a0:b1:c2:59:12:58');
  const STRANGER = '46:55:66:77:88:99';
  const inventory = (extender = true) => [
    asset('192.168.1.1', 'router', GW),
    asset('192.168.1.2', 'switch', 'aa:00:00:00:08:02'),
    asset('192.168.1.10', 'ap', 'aa:00:00:00:08:10'),
    ...(extender ? [asset('192.168.1.30', 'switch', EXTENDER)] : []),
    asset('192.168.1.31', 'laptop', LAPTOP),
    asset('192.168.1.32', 'tv', PLAYER),
    // The scan found the printer through the extender, so the inventory holds its rewritten address.
    asset('192.168.1.33', 'printer', PRINTER),
    asset('192.168.1.34', 'phone', PHONE),
  ];
  /** A switch that learned `behind` on p2; with `ap`, it hears an access point there. */
  const sw = (behind: string[], ap = true) =>
    gear('192.168.1.2', 'SW1', {
      ports: { p1: undefined, p2: undefined, p3: undefined, Vlan1: '192.168.1.2/24' },
      switches: true,
      mac: 'aa:00:00:00:08:02',
      learned: [[GW, 'p1'], ...behind.map((mac): [string, string] => [mac, 'p2'])],
      hears: ap ? [['p2', 'AP1', '192.168.1.10', 'eth0']] : [],
    });
  const everything = ['aa:00:00:00:08:10', SELF, relayed(LAPTOP), relayed(PLAYER), PRINTER, STRANGER, PHONE];
  /** The node a device hangs from, through its group: by address for inventory devices, by node id otherwise. */
  const above = (t: Topology, list: Asset[], who: string) => {
    const member = t.nodes.find((n) => n.parent && (n.id === who || list.find((a) => a.id === n.assetId)?.ip === who));
    return t.edges.find((e) => e.target === member?.parent)?.source;
  };

  it('is drawn under the access point it repeats, with the devices behind it under it', () => {
    const list = inventory();
    const t = draw(network, list, [sw(everything)]);
    const extender = t.nodes.find((n) => n.assetId === list.find((a) => a.ip === '192.168.1.30')?.id);
    expect(extender).toMatchObject({ kind: 'device', deviceType: 'ap' });
    expect(extender?.parent).toBeUndefined();
    expect(into(t, extender?.id as string)).toMatchObject([{ source: nodeOf(t, 'AP1'), inferred: false }]);
    // The laptop and the player by their real addresses, the printer by its rewritten one, and the address nobody has.
    for (const who of ['192.168.1.31', '192.168.1.32', '192.168.1.33', `mac:${STRANGER}`]) expect(above(t, list, who), who).toBe(extender?.id);
    // A device the access point serves itself stays under the access point.
    expect(above(t, list, '192.168.1.34')).toBe(nodeOf(t, 'AP1'));
    // No rewritten address is drawn as a device of its own beside the device it stands for.
    expect(t.nodes.filter((n) => [SELF, relayed(LAPTOP), relayed(PLAYER)].some((mac) => n.id === `mac:${mac}`))).toEqual([]);
    expect(t.nodes.filter((n) => n.label === 'Unmanaged segment')).toEqual([]);
  });

  it('hangs from the switch port when no access point was heard on it', () => {
    const list = inventory();
    const t = draw(network, list, [sw(everything.slice(1), false)]);
    const extender = t.nodes.find((n) => n.assetId === list.find((a) => a.ip === '192.168.1.30')?.id);
    expect(into(t, extender?.id as string)).toMatchObject([{ source: nodeOf(t, 'SW1'), sourcePort: 'p2', inferred: false }]);
    expect(above(t, list, '192.168.1.31')).toBe(extender?.id);
    // A device on the same port that the extender does not relay is one more device on a shared port.
    expect(t.nodes.find((n) => n.id === above(t, list, '192.168.1.34'))?.label).toBe('Unmanaged segment');
  });

  it('is one node with its devices under it when a switch also learned its real address, in any order of the inventory', () => {
    // The extender is cabled to p3 as well: the switch learned its real address there.
    const device = gear('192.168.1.2', 'SW1', {
      ports: { p1: undefined, p2: undefined, p3: undefined, Vlan1: '192.168.1.2/24' },
      switches: true,
      mac: 'aa:00:00:00:08:02',
      learned: [[GW, 'p1'], ...everything.map((mac): [string, string] => [mac, 'p2']), [EXTENDER, 'p3']],
      hears: [['p2', 'AP1', '192.168.1.10', 'eth0']],
    });
    const shapes = orders(inventory()).map((list) => {
      const t = draw(network, list, [device]);
      const extender = t.nodes.filter((n) => n.assetId === list.find((a) => a.ip === '192.168.1.30')?.id);
      expect(extender).toHaveLength(1);
      expect(extender[0]?.parent).toBeUndefined();
      expect(above(t, list, '192.168.1.31')).toBe(extender[0]?.id);
      // No group is drawn without a device in it.
      for (const g of t.nodes.filter((n) => n.kind === 'group')) expect(t.nodes.some((n) => n.parent === g.id), g.id).toBe(true);
      const ip = (id: string) => list.find((a) => a.id === id)?.ip ?? id.replace(/a\d+/g, (x) => list.find((a) => a.id === x)?.ip ?? x);
      return t.edges.map((e) => `${ip(e.source)}>${ip(e.target)}`).sort();
    });
    for (const s of shapes) expect(s).toEqual(shapes[0]);
  });

  it('is drawn without a device of the inventory when the scan did not find the extender itself', () => {
    const list = inventory(false);
    const t = draw(network, list, [sw(everything)]);
    const extender = t.nodes.find((n) => n.label === 'Wi-Fi extender');
    expect(extender).toMatchObject({ kind: 'device', deviceType: 'ap' });
    expect(into(t, extender?.id as string)).toMatchObject([{ source: nodeOf(t, 'AP1') }]);
    expect(above(t, list, '192.168.1.31')).toBe(extender?.id);
  });

  it('changes nothing when the addresses on the port do not show the pattern', () => {
    // One rewritten-looking address alone, and no address of the extender itself: not enough to tell.
    const list = inventory();
    const t = draw(network, list, [sw(['aa:00:00:00:08:10', relayed(LAPTOP), PHONE])]);
    expect(t.nodes.filter((n) => n.detail?.includes('extender'))).toEqual([]);
    expect(above(t, list, `mac:${relayed(LAPTOP)}`)).toBe(nodeOf(t, 'AP1'));
    expect(above(t, list, '192.168.1.34')).toBe(nodeOf(t, 'AP1'));
  });
});

describe('two routers that share the gateway address of a network', () => {
  const SHARED = '00:00:0c:07:ac:14';
  const network = { cidr: '172.20.0.0/24, 172.20.20.0/24' };
  /** A layer 3 switch with a management network on Vl1 and the shared network on Vl20; `uplink` and `downlink` are who it hears. */
  const l3 = (ip: string, name: string, vl20: string, hears: [string, string, string, string][]) =>
    gear(ip, name, { ports: { 'Et0/0': undefined, 'Et0/1': undefined, Vl1: `${ip}/24`, Vl20: `${vl20}/24` }, routes: true, switches: true, route: { nextHop: '172.20.0.1' }, hears });
  /** R1 above SW1, SW1 above SW2; both switches route 172.20.20.0/24 and one of them holds 172.20.20.1. */
  const site = (listedBy: 'SW1' | 'SW2' | 'nobody') => {
    const r1 = gear('172.20.0.1', 'R1', { ports: { 'Et0/0': '172.20.0.1/24', 'Et0/1': '10.0.0.130/24' }, routes: true, route: { nextHop: '10.0.0.1' }, hears: [['Et0/0', 'SW1', '172.20.0.2', 'Et0/0']] });
    const sw1 = l3('172.20.0.2', 'SW1', '172.20.20.2', [['Et0/0', 'R1', '172.20.0.1', 'Et0/0'], ['Et0/1', 'SW2', '172.20.0.3', 'Et0/0']]);
    const sw2 = l3('172.20.0.3', 'SW2', '172.20.20.3', [['Et0/0', 'SW1', '172.20.0.2', 'Et0/1']]);
    const lists = listedBy === 'SW1' ? sw1 : listedBy === 'SW2' ? sw2 : undefined;
    lists?.addresses?.push({ ip: '172.20.20.1', prefix: 24, ifIndex: 4 });
    return [r1, sw1, sw2];
  };
  const assets = () => [
    asset('172.20.0.1', 'router'),
    asset('172.20.0.2', 'switch'),
    asset('172.20.0.3', 'switch'),
    asset('172.20.20.1', 'router', SHARED),
    asset('172.20.20.2', 'switch'),
    asset('172.20.20.3', 'switch'),
    asset('172.20.20.50', 'computer'),
  ];
  /** The managed device the computer on the shared network hangs from, through its group. */
  const holderOfComputer = (t: Topology, list: Asset[]) => {
    const member = t.nodes.find((n) => n.parent && list.find((a) => a.id === n.assetId)?.ip === '172.20.20.50');
    return t.nodes.find((n) => n.id === t.edges.find((e) => e.target === member?.parent)?.source)?.label;
  };

  for (const listedBy of ['SW1', 'SW2', 'nobody'] as const) {
    it(`the shared address is not a device of its own, and the map is the same in any reading order (listed by ${listedBy})`, () => {
      const expected = listedBy === 'SW2' ? 'SW2' : 'SW1';
      for (const devices of orders(site(listedBy))) {
        const list = assets();
        const t = draw(network, list, devices);
        // Three devices drawn for seven addresses found: every address is one of theirs.
        expect(t.nodes.filter((n) => n.managed).map((n) => n.label).sort()).toEqual(['R1', 'SW1', 'SW2']);
        expect(t.nodes.filter((n) => !n.parent && n.kind !== 'group' && n.kind !== 'internet' && !n.managed)).toEqual([]);
        // A device with no known port on the shared network hangs from the router that holds the shared address.
        expect(holderOfComputer(t, list)).toBe(expected);
      }
    });
  }

  it('names the shared network once on the router that holds two addresses in it', () => {
    const t = draw(network, assets(), site('SW1'));
    const shared = (label: string) => (t.nodes.find((n) => n.label === label)?.routes ?? []).filter((r) => r.network === '172.20.20.0/24');
    // The address named is the router's own, not the one it shares.
    expect(shared('SW1')).toMatchObject([{ ip: '172.20.20.2' }]);
    expect(shared('SW2')).toMatchObject([{ ip: '172.20.20.3' }]);
  });
});

describe('this computer, when the scan did not find it', () => {
  /** The map of one router whose default route leads to `nextHop`, drawn from the computer at `self`. */
  const from = (self: string, assets: Asset[], nextHop = '10.0.0.1', ports: Record<string, string | undefined> = { 'Et0/0': '172.20.0.1/24', 'Et0/1': '10.0.0.130/24', 'Et0/2': '172.20.5.1/24' }) => {
    const r1 = gear('172.20.0.1', 'R1', { ports, routes: true, route: { nextHop } });
    const t = buildTopology({ cidr: '172.20.0.0/24' }, assets, { clients: true, collapsed: new Set(), self: [self] }, { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 1, devices: [r1] });
    const link = t.edges.find((e) => e.target === 'self');
    return { t, link, holder: t.nodes.find((n) => n.id === link?.source) };
  };

  it('is beside the router, under the next hop that was not read, when it is on the network the router leaves through', () => {
    const { t, link, holder } = from('10.0.0.72', [asset('172.20.0.1', 'router')]);
    expect(t.nodes.find((n) => n.self)).toMatchObject({ id: 'self', label: 'This computer', ip: '10.0.0.72' });
    expect(holder).toMatchObject({ kind: 'internet', label: 'Upstream', ip: '10.0.0.1' });
    expect(link?.inferred).toBe(true);
    // The router still hangs from that next hop by the port its route leaves through.
    expect(into(t, nodeOf(t, 'R1'))).toMatchObject([{ source: holder?.id, targetPort: 'Et0/1' }]);
  });

  it('is under the modem or firewall the scan found on that network, when the route leads to it', () => {
    const modem = asset('10.0.0.1', 'router');
    const { holder } = from('10.0.0.72', [asset('172.20.0.1', 'router'), modem]);
    expect(holder?.assetId).toBe(modem.id);
  });

  it('stays under the router when it is on one of the networks the router serves', () => {
    const { t, holder } = from('172.20.5.9', [asset('172.20.0.1', 'router')]);
    expect(holder?.id).toBe(nodeOf(t, 'R1'));
  });

  it('stays under the router when the next hop is on another of its networks', () => {
    // The route leaves through 192.168.9.0/24; the computer is on 10.0.0.0/24, a network the router serves.
    const { t, holder } = from('10.0.0.72', [asset('172.20.0.1', 'router')], '192.168.9.1', { 'Et0/0': '172.20.0.1/24', 'Et0/1': '10.0.0.130/24', 'Et0/2': '192.168.9.2/24' });
    expect(holder?.id).toBe(nodeOf(t, 'R1'));
    expect(t.nodes.find((n) => n.kind === 'internet')).toMatchObject({ label: 'Upstream', ip: '192.168.9.1' });
  });

  it('is under the gateway of the scanned network it is on, with the other devices of that network, when a router on it leaves through that gateway', () => {
    // The gateway of the scanned network is another device on it; R1 routes through it. The computer is one more device of that network.
    const r1 = gear('172.20.0.1', 'R1', { ports: { 'Et0/0': '172.20.0.1/24' }, routes: true, route: { nextHop: '172.20.0.254' } });
    const t = buildTopology({ gatewayIp: '172.20.0.254', cidr: '172.20.0.0/24' }, [asset('172.20.0.1', 'router'), asset('172.20.0.254', 'router')], { clients: true, collapsed: new Set(), self: ['172.20.0.50'] }, { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 1, devices: [r1] });
    const gatewayId = t.nodes.find((n) => n.kind === 'gateway')?.id;
    expect(t.edges.find((e) => e.target === 'self')?.source).toBe(gatewayId);
    // A device of that network the scan found hangs from the same node.
    const other = asset('172.20.0.60', 'computer');
    const withOther = buildTopology({ gatewayIp: '172.20.0.254', cidr: '172.20.0.0/24' }, [asset('172.20.0.1', 'router'), asset('172.20.0.254', 'router'), other], { clients: true, collapsed: new Set(), self: ['172.20.0.50'] }, { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 1, devices: [r1] });
    const holderOfOther = withOther.edges.find((e) => e.target === withOther.nodes.find((n) => n.assetId === other.id)?.parent)?.source;
    expect(holderOfOther).toBe(withOther.nodes.find((n) => n.kind === 'gateway')?.id);
    expect(withOther.edges.find((e) => e.target === 'self')?.source).toBe(holderOfOther);
  });

  it('a neighbour that gives only the MAC address of one of its ports, or only its name, is the managed device that holds it', () => {
    const upper = () => gear('10.0.0.2', 'SW1', { ports: { p1: undefined, p2: undefined, Vlan1: '10.0.0.2/24' }, switches: true, hears: [['p2', 'SW2', '10.0.0.3', 'e1']] });
    const lower = (identify: (n: GearDevice['neighbors'][number]) => void) => {
      const d = gear('10.0.0.3', 'SW2', { ports: { e1: undefined, e2: undefined, br: '10.0.0.3/24' }, switches: true, hears: [['e1', 'SW1', '10.0.0.2', 'p2']] });
      const n = d.neighbors[0] as GearDevice['neighbors'][number];
      n.mgmtIp = undefined;
      n.chassisId = undefined;
      identify(n);
      return d;
    };
    const byPortMac = (n: GearDevice['neighbors'][number]) => { n.chassisMac = 'aa:00:00:00:02:02'; };
    const byName = () => undefined;
    for (const identify of [byPortMac, byName]) {
      const sw1 = upper();
      (sw1.interfaces.find((i) => i.name === 'p2') as (typeof sw1.interfaces)[number]).mac = 'aa:00:00:00:02:02';
      for (const devices of orders([sw1, lower(identify)])) {
        const t = draw({ gatewayIp: '10.0.0.1', cidr: '10.0.0.0/24' }, [asset('10.0.0.1', 'router'), asset('10.0.0.2', 'switch'), asset('10.0.0.3', 'switch')], devices);
        expect(t.nodes.filter((n) => n.label === 'SW1' || n.label === 'SW2')).toHaveLength(2);
        expect(t.edges.filter((e) => e.source === nodeOf(t, 'SW1') && e.target === nodeOf(t, 'SW2'))).toHaveLength(1);
        expect(t.edges.filter((e) => e.source === nodeOf(t, 'SW2'))).toEqual([]);
      }
    }
  });

  it('a neighbour that announces itself as a router is drawn as a switch when other devices are learned through it', () => {
    const type = (learned: [string, string][], assets: Asset[]) => {
      const sw = gear('10.0.0.2', 'SW1', { ports: { p1: undefined, p2: undefined, Vlan1: '10.0.0.2/24' }, switches: true, learned, hears: [['p2', 'EDGE', '10.0.0.8', 'e0']] });
      (sw.neighbors[0] as GearDevice['neighbors'][number]).capabilities = ['router'];
      const t = draw({ gatewayIp: '10.0.0.1', cidr: '10.0.0.0/24' }, [asset('10.0.0.1', 'router'), asset('10.0.0.2', 'switch'), ...assets], [sw]);
      return t.nodes.find((n) => n.label === 'EDGE')?.deviceType;
    };
    const own = asset('10.0.0.8', 'unknown', 'aa:00:00:00:00:08');
    const pc = asset('10.0.0.18', 'computer', 'aa:00:00:00:00:18');
    // A computer is learned on the port where the neighbour was heard: its frames cross the neighbour unrouted.
    expect(type([['aa:00:00:00:00:08', 'p2'], ['aa:00:00:00:00:18', 'p2']], [own, pc])).toBe('switch');
    // Only its own address, or also one that routers share: it is the router it says it is.
    expect(type([['aa:00:00:00:00:08', 'p2']], [own, pc])).toBe('router');
    expect(type([['aa:00:00:00:00:08', 'p2'], ['00:00:0c:07:ac:01', 'p2']], [own, asset('10.0.0.254', 'unknown', '00:00:0c:07:ac:01')])).toBe('router');
  });

  it('the cables of a link bundle between two switches are drawn as one link on the bundle', () => {
    const core = (ip: string, name: string, other: string, otherIp: string) => {
      const d = gear(ip, name, { ports: { up: undefined, a: undefined, b: undefined, Po1: undefined, Vlan1: `${ip}/24` }, switches: true, hears: [['up', 'R1', '10.0.0.1', name === 'C1' ? 'p1' : 'p2'], ['a', other, otherIp, 'a'], ['b', other, otherIp, 'b']] });
      const po = d.interfaces.find((i) => i.name === 'Po1') as (typeof d.interfaces)[number];
      for (const i of d.interfaces) if (i.name === 'a' || i.name === 'b') i.memberOf = po.ifIndex;
      return d;
    };
    const r1 = gear('10.0.0.1', 'R1', { ports: { p1: undefined, p2: undefined, lan: '10.0.0.1/24' }, routes: true, hears: [['p1', 'C1', '10.0.0.2', 'up'], ['p2', 'C2', '10.0.0.3', 'up']] });
    for (const devices of orders([r1, core('10.0.0.2', 'C1', 'C2', '10.0.0.3'), core('10.0.0.3', 'C2', 'C1', '10.0.0.2')])) {
      const t = buildTopology({ gatewayIp: '10.0.0.1', cidr: '10.0.0.0/24' }, [asset('10.0.0.1', 'router'), asset('10.0.0.2', 'switch'), asset('10.0.0.3', 'switch')], { clients: true, collapsed: new Set() }, { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 3, devices });
      const joining = [...t.edges, ...(t.redundant ?? [])].filter((e) => [e.source, e.target].sort().join() === [nodeOf(t, 'C1'), nodeOf(t, 'C2')].sort().join());
      expect(joining).toHaveLength(1);
      expect(joining[0]).toMatchObject({ sourcePort: 'Po1', targetPort: 'Po1', bundle: { cables: 2, sourcePorts: ['a', 'b'], targetPorts: ['a', 'b'] } });
    }
    // Two cables that are no bundle stay two links.
    const plain = (ip: string, name: string, other: string, otherIp: string) => gear(ip, name, { ports: { up: undefined, a: undefined, b: undefined, Vlan1: `${ip}/24` }, switches: true, hears: [['up', 'R1', '10.0.0.1', name === 'C1' ? 'p1' : 'p2'], ['a', other, otherIp, 'a'], ['b', other, otherIp, 'b']] });
    const t = buildTopology({ gatewayIp: '10.0.0.1', cidr: '10.0.0.0/24' }, [asset('10.0.0.1', 'router'), asset('10.0.0.2', 'switch'), asset('10.0.0.3', 'switch')], { clients: true, collapsed: new Set() }, { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 3, devices: [r1, plain('10.0.0.2', 'C1', 'C2', '10.0.0.3'), plain('10.0.0.3', 'C2', 'C1', '10.0.0.2')] });
    expect((t.redundant ?? []).filter((e) => !e.bundle)).toHaveLength(2);
  });

  it('a switch heard on the port a router leaves through stands above that router, under what its route leads to', () => {
    const r1 = gear('172.20.0.1', 'R1', { ports: { 'Et0/0': '172.20.0.1/24', 'Et0/1': '10.0.0.130/24' }, routes: true, route: { nextHop: '10.0.0.1' }, hears: [['Et0/1', 'HOME-SW', '10.0.0.9', 'gi9']] });
    const snapshot = { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 1, devices: [r1] };
    // The network the route leaves through was not scanned: the way out is a node of its own.
    const t = buildTopology({ cidr: '172.20.0.0/24' }, [asset('172.20.0.1', 'router')], { clients: true, collapsed: new Set(), self: ['10.0.0.72'] }, snapshot);
    const sw = t.nodes.find((n) => n.label === 'HOME-SW')?.id as string;
    const up = t.nodes.find((n) => n.kind === 'internet')?.id as string;
    const r = nodeOf(t, 'R1');
    expect(t.edges.filter((e) => e.target === r)).toMatchObject([{ source: sw, sourcePort: 'gi9', targetPort: 'Et0/1', inferred: false }]);
    expect(t.edges.filter((e) => e.target === sw)).toMatchObject([{ source: up, inferred: true }]);
    expect(t.edges.find((e) => e.target === 'self')?.source).toBe(up);
    // It was scanned and the next hop found: the switch stands between that device and the router.
    const hop = asset('10.0.0.1', 'router');
    const scanned = buildTopology({ cidr: '172.20.0.0/24, 10.0.0.0/24' }, [asset('172.20.0.1', 'router'), hop], { clients: true, collapsed: new Set() }, snapshot);
    const sw2 = scanned.nodes.find((n) => n.label === 'HOME-SW')?.id as string;
    expect(scanned.edges.filter((e) => e.target === nodeOf(scanned, 'R1')).map((e) => e.source)).toEqual([sw2]);
    expect(scanned.edges.filter((e) => e.target === sw2).map((e) => e.source)).toEqual([scanned.nodes.find((n) => n.assetId === hop.id)?.id]);
    // Two routers hear it on the port they leave through: it stands above the one with the lowest address, in any reading order.
    const edge = (ip: string, name: string, lan: string) => gear(lan, name, { ports: { 'Et0/0': `${lan}/24`, 'Et0/1': `${ip}/24` }, routes: true, route: { nextHop: '10.0.0.1' }, hears: [['Et0/1', 'HOME-SW', '10.0.0.9', name === 'A' ? 'gi9' : 'gi8']] });
    for (const devices of orders([edge('10.0.0.130', 'A', '172.20.0.1'), edge('10.0.0.131', 'B', '172.20.9.1')])) {
      const two = buildTopology({ cidr: '172.20.0.0/24, 172.20.9.0/24' }, [asset('172.20.0.1', 'router'), asset('172.20.9.1', 'router')], { clients: true, collapsed: new Set() }, { ...snapshot, probed: 2, devices });
      const home = two.nodes.find((n) => n.label === 'HOME-SW')?.id as string;
      expect(two.edges.filter((e) => e.source === home).map((e) => e.target)).toEqual([nodeOf(two, 'A')]);
      expect(two.edges.filter((e) => e.target === home)).toHaveLength(1);
    }
    // A neighbour heard on any other port still hangs below the router.
    const inside = gear('172.20.0.1', 'R1', { ports: { 'Et0/0': '172.20.0.1/24', 'Et0/1': '10.0.0.130/24' }, routes: true, route: { nextHop: '10.0.0.1' }, hears: [['Et0/0', 'AP', '172.20.0.9', 'eth0']] });
    const below = buildTopology({ cidr: '172.20.0.0/24' }, [asset('172.20.0.1', 'router')], { clients: true, collapsed: new Set() }, { ...snapshot, devices: [inside] });
    expect(below.edges.find((e) => e.target === below.nodes.find((n) => n.label === 'AP')?.id)?.source).toBe(nodeOf(below, 'R1'));
  });

  it('is under the same next hop whatever order two routers, one behind the other, were read in', () => {
    const a = gear('172.20.0.1', 'A', { ports: { 'Et0/0': '172.20.0.1/24', 'Et0/1': '10.0.0.130/24' }, routes: true, route: { nextHop: '10.0.0.1' }, hears: [['Et0/0', 'B', '172.20.0.2', 'Et0/0']] });
    const b = gear('172.20.0.2', 'B', { ports: { 'Et0/0': '172.20.0.2/24', 'Et0/1': '172.20.9.1/24' }, routes: true, route: { nextHop: '172.20.0.1' }, hears: [['Et0/0', 'A', '172.20.0.1', 'Et0/0']] });
    for (const devices of orders([a, b])) {
      const t = buildTopology({ cidr: '172.20.0.0/24' }, [asset('172.20.0.1', 'router'), asset('172.20.0.2', 'router')], { clients: true, collapsed: new Set(), self: ['10.0.0.72'] }, { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 2, devices });
      const holder = t.nodes.find((n) => n.id === t.edges.find((e) => e.target === 'self')?.source);
      expect(holder).toMatchObject({ kind: 'internet', ip: '10.0.0.1' });
    }
  });

  it('stays under the router when its way out is a public next hop', () => {
    const { t, holder } = from('203.0.113.6', [asset('172.20.0.1', 'router')], '203.0.113.1', { 'Et0/0': '172.20.0.1/24', 'Et0/1': '203.0.113.2/29' });
    expect(holder?.id).toBe(nodeOf(t, 'R1'));
  });
});

describe('a cable only one end of which heard the other', () => {
  const GW = 'aa:00:00:00:06:01';
  const [A, C, PC] = ['aa:00:00:00:06:02', 'aa:00:00:00:06:03', 'aa:00:00:00:06:20'];
  const network = { gatewayIp: '192.168.1.1', gatewayMac: GW, cidr: '192.168.1.0/24' };
  const assets = () => [asset('192.168.1.1', 'router', GW), asset('192.168.1.2', 'switch', A), asset('192.168.1.3', 'switch', C), asset('192.168.1.20', 'computer', PC)];
  const ports = (ip: string) => ({ p1: undefined, p2: undefined, p3: undefined, Vlan1: `${ip}/24` });
  /** A is plugged into the gateway on p1 and into C on p2; C has the computer on p3. `hears` is who heard whom. */
  const pair = (hears: { a?: [string, string, string, string][]; c?: [string, string, string, string][] }) => [
    gear('192.168.1.2', 'A', { ports: ports('192.168.1.2'), switches: true, mac: A, learned: [[GW, 'p1'], [C, 'p2'], [PC, 'p2']], hears: hears.a }),
    gear('192.168.1.3', 'C', { ports: ports('192.168.1.3'), switches: true, mac: C, learned: [[GW, 'p1'], [A, 'p1'], [PC, 'p3']], hears: hears.c }),
  ];
  /** The map must be the one both ends hearing each other gives: gateway, A, C in a row and the computer on C. */
  const expectRow = (devices: GearDevice[]) => {
    for (const list of orders(devices)) {
      const all = assets();
      const t = draw(network, all, list);
      expect(into(t, nodeOf(t, 'A')).map((e) => e.source)).toEqual([t.nodes.find((n) => n.kind === 'gateway')?.id]);
      expect(into(t, nodeOf(t, 'C'))).toMatchObject([{ source: nodeOf(t, 'A'), sourcePort: 'p2', targetPort: 'p1' }]);
      expect(t.redundant ?? []).toEqual([]);
      expect(t.nodes.filter((n) => n.label === 'Unmanaged segment')).toEqual([]);
      const member = t.nodes.find((n) => n.parent && all.find((a) => a.id === n.assetId)?.ip === '192.168.1.20');
      expect(t.edges.find((e) => e.target === member?.parent)?.source).toBe(nodeOf(t, 'C'));
    }
  };

  it('both ends heard each other: the row the other cases must match', () => {
    expectRow(pair({ a: [['p2', 'C', '192.168.1.3', 'p1']], c: [['p1', 'A', '192.168.1.2', 'p2']] }));
  });

  it('only the upper switch heard the lower one, which named its port', () => {
    expectRow(pair({ a: [['p2', 'C', '192.168.1.3', 'p1']] }));
  });

  it('only the lower switch heard the upper one, which named its port', () => {
    expectRow(pair({ c: [['p1', 'A', '192.168.1.2', 'p2']] }));
  });

  it('the port was announced as an address, not a name: the addresses each end learned tell the port', () => {
    expectRow(pair({ a: [['p2', 'C', '192.168.1.3', 'aa:00:00:00:06:f1']] }));
    expectRow(pair({ c: [['p1', 'A', '192.168.1.2', 'aa:00:00:00:06:f2']] }));
  });

  it('a name that two ports of the device answer to tells nothing: the addresses learned tell the port', () => {
    // "Po1" and "Port 1" shorten to the same name; the lower switch really is on Port 1.
    const twins = { 'Port 1': undefined, Po1: undefined, p3: undefined, Vlan1: '192.168.1.3/24' };
    const a = gear('192.168.1.2', 'A', { ports: ports('192.168.1.2'), switches: true, mac: A, learned: [[GW, 'p1'], [C, 'p2'], [PC, 'p2']], hears: [['p2', 'C', '192.168.1.3', 'Port 1']] });
    for (const names of [twins, { Po1: undefined, 'Port 1': undefined, p3: undefined, Vlan1: '192.168.1.3/24' }]) {
      const c = gear('192.168.1.3', 'C', { ports: names, switches: true, mac: C, learned: [[GW, 'Port 1'], [A, 'Port 1'], [PC, 'p3']] });
      for (const list of orders([a, c])) {
        const t = draw(network, assets(), list);
        expect(into(t, nodeOf(t, 'C'))).toMatchObject([{ source: nodeOf(t, 'A'), sourcePort: 'p2', targetPort: 'Port 1' }]);
        expect(t.redundant ?? []).toEqual([]);
      }
    }
  });

  it('a name the device has on none of its ports, with nothing learned from the neighbour, leaves the map as it was drawn', () => {
    const a = gear('192.168.1.2', 'A', { ports: ports('192.168.1.2'), switches: true, mac: A, learned: [[GW, 'p1'], [C, 'p2']], hears: [['p2', 'C', '192.168.1.3', 'uplink']] });
    const c = gear('192.168.1.3', 'C', { ports: ports('192.168.1.3'), switches: true, mac: C, learned: [[PC, 'p3']] });
    for (const list of orders([a, c])) {
      const t = draw(network, assets(), list);
      expect(into(t, nodeOf(t, 'C'))).toMatchObject([{ source: nodeOf(t, 'A'), sourcePort: 'p2' }]);
    }
  });

  it('a managed gateway that heard neither of the two switches that heard it gets each on the port they named', () => {
    const B = 'aa:00:00:00:06:04';
    const g = gear('192.168.1.1', 'CORE', { ports: { g1: undefined, g2: undefined, g3: undefined, Vlan1: '192.168.1.1/24' }, routes: true, switches: true, mac: GW });
    const a = gear('192.168.1.2', 'A', { ports: ports('192.168.1.2'), switches: true, mac: A, learned: [[GW, 'p1']], hears: [['p1', 'CORE', '192.168.1.1', 'g2']] });
    const b = gear('192.168.1.4', 'B', { ports: ports('192.168.1.4'), switches: true, mac: B, learned: [[GW, 'p1']], hears: [['p1', 'CORE', '192.168.1.1', 'g3']] });
    for (const list of orders([g, a, b])) {
      const t = draw(network, [...assets(), asset('192.168.1.4', 'switch', B)], list);
      expect(into(t, nodeOf(t, 'A'))).toMatchObject([{ source: nodeOf(t, 'CORE'), sourcePort: 'g2', targetPort: 'p1' }]);
      expect(into(t, nodeOf(t, 'B'))).toMatchObject([{ source: nodeOf(t, 'CORE'), sourcePort: 'g3', targetPort: 'p1' }]);
    }
  });
});

describe('switches that announce no neighbours', () => {
  const GW = 'aa:00:00:00:05:01';
  const network = { gatewayIp: '192.168.1.1', gatewayMac: GW, cidr: '192.168.1.0/24' };
  /** A switch with ports p1 to p3 that hears nobody; `learned` is the address learned on each port. */
  const quiet = (ip: string, name: string, mac: string, learned: [string, string][]) =>
    gear(ip, name, { ports: { p1: undefined, p2: undefined, p3: undefined, Vlan1: `${ip}/24` }, switches: true, mac, learned });
  const A = 'aa:00:00:00:05:02';
  const B = 'aa:00:00:00:05:03';
  const PC = 'aa:00:00:00:05:20';
  const assets = () => [asset('192.168.1.1', 'router', GW), asset('192.168.1.2', 'switch', A), asset('192.168.1.3', 'switch', B), asset('192.168.1.20', 'computer', PC)];
  /** The node a device of the inventory hangs from, through its group. */
  const holder = (t: Topology, list: Asset[], ip: string) => {
    const member = t.nodes.find((n) => n.parent && list.find((a) => a.id === n.assetId)?.ip === ip);
    return t.edges.find((e) => e.target === member?.parent)?.source;
  };

  it('two switches whose tables each put the other below stay on the gateway, in any order', () => {
    const a = quiet('192.168.1.2', 'A', A, [[GW, 'p1'], [B, 'p2']]);
    const b = quiet('192.168.1.3', 'B', B, [[GW, 'p1'], [A, 'p2']]);
    for (const devices of orders([a, b])) {
      const list = assets();
      const t = draw(network, list, devices);
      const gateway = t.nodes.find((n) => n.kind === 'gateway')?.id;
      expect(into(t, nodeOf(t, 'A')).map((e) => e.source)).toEqual([gateway]);
      expect(into(t, nodeOf(t, 'B')).map((e) => e.source)).toEqual([gateway]);
    }
  });

  it('a switch whose address nobody learned stays on the gateway, and a computer goes on the port with the fewest addresses', () => {
    // A learned the computer together with another address on p2; B has it alone on p3.
    const a = quiet('192.168.1.2', 'A', A, [[GW, 'p1'], [PC, 'p2'], ['aa:00:00:00:05:21', 'p2']]);
    const b = quiet('192.168.1.3', 'B', B, [[GW, 'p1'], [PC, 'p3']]);
    for (const devices of orders([a, b])) {
      const list = assets();
      const t = draw(network, list, devices);
      const gateway = t.nodes.find((n) => n.kind === 'gateway')?.id;
      expect(into(t, nodeOf(t, 'B')).map((e) => e.source)).toEqual([gateway]);
      expect(holder(t, list, '192.168.1.20')).toBe(nodeOf(t, 'B'));
    }
  });

  it('a switch that did not learn the gateway takes no switch below it', () => {
    // A cannot tell which of its ports leads up, so the address of B it learned says nothing.
    const a = quiet('192.168.1.2', 'A', A, [[B, 'p1']]);
    const b = quiet('192.168.1.3', 'B', B, [[GW, 'p1'], [A, 'p1']]);
    for (const devices of orders([a, b])) {
      const t = draw(network, assets(), devices);
      expect(into(t, nodeOf(t, 'B')).map((e) => e.source)).toEqual([t.nodes.find((n) => n.kind === 'gateway')?.id]);
    }
  });

  it('a port that already has a cable to a neighbour that announced itself takes no second switch', () => {
    const C = 'aa:00:00:00:05:04';
    const a = gear('192.168.1.2', 'A', { ports: { p1: undefined, p2: undefined, p3: undefined, Vlan1: '192.168.1.2/24' }, switches: true, mac: A, learned: [[GW, 'p1'], [B, 'p2']], hears: [['p2', 'C', '192.168.1.4', 'p1']] });
    const b = quiet('192.168.1.3', 'B', B, [[GW, 'p1'], [A, 'p1']]);
    const c = gear('192.168.1.4', 'C', { ports: { p1: undefined, p2: undefined, p3: undefined, Vlan1: '192.168.1.4/24' }, switches: true, mac: C, learned: [[GW, 'p1']], hears: [['p1', 'A', '192.168.1.2', 'p2']] });
    for (const devices of orders([a, b, c])) {
      const t = draw(network, [...assets(), asset('192.168.1.4', 'switch', C)], devices);
      expect(into(t, nodeOf(t, 'C'))).toMatchObject([{ source: nodeOf(t, 'A'), sourcePort: 'p2' }]);
      expect(into(t, nodeOf(t, 'B')).map((e) => e.source)).toEqual([t.nodes.find((n) => n.kind === 'gateway')?.id]);
    }
  });

  it('two switches below one, on two ports or behind the same port, both hang from it in any order', () => {
    const C = 'aa:00:00:00:05:04';
    for (const [portB, portC] of [['p2', 'p3'], ['p2', 'p2']] as const) {
      const a = quiet('192.168.1.2', 'A', A, [[GW, 'p1'], [B, portB], [C, portC]]);
      const b = quiet('192.168.1.3', 'B', B, [[GW, 'p1'], [A, 'p1'], [C, 'p1']]);
      const c = quiet('192.168.1.4', 'C', C, [[GW, 'p1'], [A, 'p1'], [B, 'p1']]);
      for (const devices of orders([a, b, c])) {
        const t = draw(network, [...assets(), asset('192.168.1.4', 'switch', C)], devices);
        expect(into(t, nodeOf(t, 'B'))).toMatchObject([{ source: nodeOf(t, 'A'), sourcePort: portB, targetPort: 'p1' }]);
        expect(into(t, nodeOf(t, 'C'))).toMatchObject([{ source: nodeOf(t, 'A'), sourcePort: portC, targetPort: 'p1' }]);
      }
    }
  });

  it('a managed gateway that switches gives the port each switch is on', () => {
    const g = gear('192.168.1.1', 'CORE', { ports: { g1: undefined, g2: undefined, Vlan1: '192.168.1.1/24' }, routes: true, switches: true, mac: GW, learned: [[A, 'g2']] });
    const a = quiet('192.168.1.2', 'A', A, [[GW, 'p1'], [PC, 'p3']]);
    for (const devices of orders([g, a])) {
      const t = draw(network, assets(), devices);
      expect(into(t, nodeOf(t, 'A'))).toMatchObject([{ source: nodeOf(t, 'CORE'), sourcePort: 'g2', targetPort: 'p1', inferred: false }]);
    }
  });

  it('an address that is the network or broadcast address of a link a router holds is not drawn as a device', () => {
    const r1 = gear('172.20.255.1', 'R1', { ports: { 'Et0/1': '10.0.0.130/24', 'Et0/0': '172.20.255.1/30', 'Et0/2': '172.20.255.5/30' }, routes: true, route: { nextHop: '10.0.0.1', port: 'Et0/1' } });
    const answering = [asset('172.20.255.1', 'router'), asset('172.20.255.2'), asset('172.20.255.3'), asset('172.20.255.4'), asset('172.20.255.5'), asset('172.20.255.6')];
    const t = draw({ gatewayIp: '172.20.255.1', cidr: '172.20.255.0/29' }, answering, [r1]);
    const drawn = (ip: string) => t.nodes.some((n) => n.assetId === answering.find((a) => a.ip === ip)?.id);
    expect(drawn('172.20.255.3')).toBe(false);
    expect(drawn('172.20.255.4')).toBe(false);
    expect(drawn('172.20.255.2')).toBe(true);
    expect(drawn('172.20.255.6')).toBe(true);
    // A device with a MAC address of its own on such an address (the router's network is wider than it says) stays.
    const host = asset('172.20.255.4', 'computer', 'aa:00:00:00:09:04');
    expect(draw({ gatewayIp: '172.20.255.1', cidr: '172.20.255.0/29' }, [asset('172.20.255.1', 'router'), host], [r1]).nodes.some((n) => n.assetId === host.id)).toBe(true);
  });

  it('a gateway address that routers share, scanned on the switch that holds it: the switch is shown by its own address and names the network once', () => {
    const shared = asset('172.20.0.1', 'router', '00:00:0c:07:ac:01');
    const own = asset('172.20.0.2', 'switch', 'aa:00:00:00:0a:02');
    for (const first of [true, false]) {
      const core = gear('172.20.0.2', 'CORE1', {
        ports: { 'Et1/0': '172.20.255.2/30', Vlan1: '172.20.0.2/24', Vlan20: '172.20.20.2/24' },
        routes: true,
        switches: true,
        mac: 'aa:00:00:00:0a:02',
        route: { nextHop: '172.20.255.1', port: 'Et1/0' },
      });
      const held = { ip: '172.20.0.1', prefix: 24, ifIndex: 2 };
      core.addresses = first ? [held, ...(core.addresses ?? [])] : [...(core.addresses ?? []), held];
      core.arp = [{ ip: '172.20.0.1', mac: '00:00:0c:07:ac:01' }];
      const t = draw({ gatewayIp: '172.20.0.1', gatewayMac: '00:00:0c:07:ac:01', cidr: '172.20.0.0/24,172.20.20.0/24' }, [shared, own], [core]);
      const gateway = t.nodes.filter((n) => n.kind === 'gateway');
      expect(gateway).toMatchObject([{ label: 'CORE1', assetId: own.id, ip: '172.20.0.1' }]);
      expect(t.nodes.filter((n) => n.assetId === shared.id || n.assetId === own.id)).toHaveLength(1);
      expect(gateway[0]?.routes?.map((r) => `${r.vlan}:${r.network}:${r.ip}`)).toEqual(['1:172.20.0.0/24:172.20.0.2', '20:172.20.20.0/24:172.20.20.2']);
      // The switch that lists the shared address answers for it: its card says so, on a row of its own.
      expect(gateway[0]?.gateways).toEqual([{ ip: '172.20.0.1', protocol: 'HSRP', network: '172.20.0.0/24', vlan: 1, port: 'Vlan1', active: true }]);
      expect(gatewayLine(gateway[0]?.gateways ?? [])).toBe('HSRP active · 172.20.0.1');
      // Its card is not singled out as the gateway: the other router holding a shared address is its equal.
      expect(gateway[0]?.sharedGateway).toBe(true);
      expect(layoutTree(t).sizes[gateway[0]?.id as string]?.h).toBe(NODE_SIZE.device.h + ROUTES_ROW + GATEWAY_ROW);
      // A second switch that lists the shared address too does not take the node over.
      const other = asset('172.20.0.3', 'switch', 'aa:00:00:00:0a:03');
      const core2 = gear('172.20.0.3', 'CORE2', { ports: { Vlan1: '172.20.0.3/24', Vlan20: '172.20.20.3/24' }, routes: true, switches: true, mac: 'aa:00:00:00:0a:03' });
      core2.addresses = [...(core2.addresses ?? []), { ip: '172.20.0.1', prefix: 24, ifIndex: 1 }];
      const both = draw({ gatewayIp: '172.20.0.1', gatewayMac: '00:00:0c:07:ac:01', cidr: '172.20.0.0/24,172.20.20.0/24' }, [shared, own, other], [core, core2]);
      expect(both.nodes.filter((n) => n.kind === 'gateway')).toMatchObject([{ label: 'CORE1', assetId: own.id }]);
      // Two switches listing the address: it is not said who answers for it. Nor when the interface is down.
      expect(both.nodes.flatMap((n) => n.gateways ?? []).every((g) => !g.active)).toBe(true);
      const down = { ...core, interfaces: core.interfaces.map((i) => (i.name === 'Vlan1' ? { ...i, up: false } : i)) };
      expect(draw({ gatewayIp: '172.20.0.1', gatewayMac: '00:00:0c:07:ac:01', cidr: '172.20.0.0/24,172.20.20.0/24' }, [shared, own], [down]).nodes.flatMap((n) => n.gateways ?? [])).toMatchObject([{ active: false }]);
    }
  });

  it('a shared gateway address that no router lists: shown on the router it is given to, without saying that router answers for it', () => {
    const r1 = gear('10.0.0.2', 'R1', { ports: { wan: '203.0.113.2/30', lan: '10.0.0.2/24' }, routes: true, route: { nextHop: '203.0.113.1' } });
    const r2 = gear('10.0.0.3', 'R2', { ports: { wan: '198.51.100.2/30', lan: '10.0.0.3/24' }, routes: true, route: { nextHop: '198.51.100.1' } });
    const t = draw({ gatewayIp: '10.0.0.1', gatewayMac: '00:00:5e:00:01:0a', cidr: '10.0.0.0/24' }, [asset('10.0.0.1', 'router', '00:00:5e:00:01:0a'), asset('10.0.0.2', 'router'), asset('10.0.0.3', 'router')], [r1, r2]);
    expect(t.nodes.flatMap((n) => n.gateways ?? [])).toEqual([{ ip: '10.0.0.1', protocol: 'VRRP', network: '10.0.0.0/24', port: 'lan', active: false }]);
    expect(nodeOf(t, 'R1')).toBe(t.nodes.find((n) => n.gateways)?.id);
    expect(gatewayLine([{ ip: '10.0.0.1', protocol: 'VRRP', network: '10.0.0.0/24', active: false }])).toBe('VRRP · 10.0.0.1');
    expect(gatewayLine([{ ip: '10.0.0.1', protocol: 'HSRP', network: '10.0.0.0/24', active: true }, { ip: '10.0.20.1', protocol: 'HSRP', network: '10.0.20.0/24', active: true }])).toBe('HSRP active · 10.0.0.1 +1');
  });

  it('devices on the network a router leaves through, with that network scanned too: under what the route leads to, beside the router, not under it', () => {
    const r1 = gear('172.20.255.1', 'R1', { ports: { 'Et0/1': '10.0.0.130/24', 'Et0/0': '172.20.255.1/30' }, routes: true, route: { nextHop: '10.0.0.1', port: 'Et0/1' } });
    const home = asset('10.0.0.1', 'router');
    const laptop = asset('10.0.0.72', 'computer');
    const printer = asset('10.0.0.50', 'printer');
    const inside = asset('172.20.255.2');
    const t = draw({ cidr: '172.20.255.0/30,10.0.0.0/24' }, [asset('172.20.255.1', 'router'), home, laptop, printer, inside], [r1]);
    const holder = (a: Asset) => t.edges.find((e) => e.target === t.nodes.find((n) => n.assetId === a.id)?.parent)?.source;
    expect(holder(laptop)).toBe(home.id);
    expect(holder(printer)).toBe(home.id);
    expect(holder(inside)).toBe(nodeOf(t, 'R1'));
    expect(into(t, nodeOf(t, 'R1')).map((e) => e.source)).toEqual([home.id]);
  });

  it('devices in a VLAN a switch routes, when its default route leaves through that VLAN: they stay under the switch', () => {
    const core = gear('10.0.10.2', 'CORE', {
      ports: { p1: undefined, Vlan10: '10.0.10.2/24', Vlan20: '10.0.20.1/24' },
      routes: true,
      switches: true,
      route: { nextHop: '10.0.10.1', port: 'Vlan10' },
    });
    const firewall = asset('10.0.10.1', 'firewall');
    const client = asset('10.0.10.50', 'computer');
    const t = draw({ cidr: '10.0.10.0/24,10.0.20.0/24' }, [asset('10.0.10.2', 'switch'), firewall, client], [core]);
    expect(t.edges.find((e) => e.target === t.nodes.find((n) => n.assetId === client.id)?.parent)?.source).toBe(nodeOf(t, 'CORE'));
  });
});
