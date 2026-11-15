import { describe, expect, it } from 'vitest';
import { buildTopology, layoutTree, type MapEdge, type Topology } from '../../src/renderer/src/map-model';
import { SCENARIOS, type Scenario } from './scenarios';

/** The map of a scenario, with helpers that name nodes the way the scenario does. */
function draw(id: string, options: { self?: string[]; clients?: boolean } = {}) {
  const s = SCENARIOS.find((x) => x.id === id) as Scenario;
  const topo: Topology = buildTopology(s.network, s.assets, { clients: options.clients ?? true, collapsed: new Set(), self: options.self }, s.devices.length ? { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: s.devices.length, devices: s.devices } : null);
  /** Node id of a managed device (by name) or of an inventory device (by address). */
  const node = (who: string): string => {
    const d = s.devices.find((x) => x.sysName === who);
    const ips = d ? [d.ip, ...(d.addresses ?? []).map((a) => a.ip)] : [who];
    const assetIds = new Set(s.assets.filter((a) => ips.includes(a.ip)).map((a) => a.id));
    const found = topo.nodes.find((n) => (n.assetId && assetIds.has(n.assetId)) || (n.ip && ips.includes(n.ip) && n.kind !== 'internet') || (d && n.label === who && n.managed));
    if (!found) throw new Error(`${who} is not on the map`);
    return found.id;
  };
  const exits = topo.nodes.filter((n) => n.kind === 'internet');
  /** The way out drawn above a device, with its link. */
  const exitOf = (who: string) => {
    const link = topo.edges.find((e) => e.target === node(who) && exits.some((x) => x.id === e.source));
    return link ? { node: exits.find((x) => x.id === link.source), link } : undefined;
  };
  const link = (a: string, b: string): MapEdge | undefined => topo.edges.find((e) => e.source === node(a) && e.target === node(b));
  /** The node a device without a known port hangs from, through its group. */
  const holderOf = (ip: string) => {
    const member = topo.nodes.find((n) => n.parent && s.assets.find((a) => a.id === n.assetId)?.ip === ip);
    return topo.edges.find((e) => e.target === member?.parent)?.source;
  };
  const clouds = topo.nodes.filter((n) => n.network).map((n) => n.network);
  return { topo, node, exits, exitOf, link, holderOf, clouds };
}

describe('topologies the map draws', () => {
  it('flat: one way out, on the port the router gives for its default route', () => {
    const m = draw('flat');
    expect(m.exits).toHaveLength(1);
    expect(m.exitOf('R1')?.link).toMatchObject({ inferred: false, targetPort: 'wan' });
    expect(m.link('R1', 'SW1')).toMatchObject({ sourcePort: 'lan', targetPort: 'p1' });
    expect(m.topo.roots).toEqual(['internet']);
  });

  it('nothing managed: the gateway under an assumed internet', () => {
    const m = draw('unread-gateway');
    expect(m.exits).toHaveLength(1);
    expect(m.exitOf('192.168.1.1')?.link.inferred).toBe(true);
    expect(m.holderOf('192.168.1.20')).toBe(m.node('192.168.1.1'));
  });

  it('subinterfaces: the way out is found from the next hop when the router does not give its port', () => {
    const m = draw('stick');
    expect(m.exitOf('R1')?.link).toMatchObject({ inferred: false, targetPort: 'Et0/0' });
    expect(m.clouds).toEqual([]);
  });

  it('core behind a firewall: the firewall heads the map, the core hangs from it by its uplink', () => {
    const m = draw('core-firewall');
    expect(m.exits).toHaveLength(1);
    expect(m.exitOf('10.255.0.1')?.link.inferred).toBe(true);
    expect(m.link('10.255.0.1', 'CORE')).toMatchObject({ inferred: false, targetPort: 'Gi1/0/48' });
    expect(m.topo.nodes.find((n) => n.id === m.node('10.255.0.1'))?.parent).toBeUndefined();
    expect(m.clouds).toEqual([]);
    expect(m.topo.nodes.find((n) => n.id === m.node('CORE'))).toMatchObject({ deviceType: 'switch', typeRead: true });
    expect(m.topo.nodes.find((n) => n.id === m.node('CORE'))?.routes?.map((r) => r.vlan)).toEqual([10, 20]);
  });

  it('two sites: each router keeps its own way out and its own devices, joined side by side', () => {
    const m = draw('two-sites');
    expect(m.exits).toHaveLength(2);
    expect(m.exitOf('EDGE-A')?.link).toMatchObject({ inferred: false, targetPort: 'Et0/0' });
    expect(m.exitOf('EDGE-B')?.link).toMatchObject({ inferred: false, targetPort: 'Et0/0' });
    expect(m.link('EDGE-A', 'EDGE-B')).toBeUndefined();
    expect(m.link('EDGE-B', 'EDGE-A')).toBeUndefined();
    expect(m.topo.peers).toMatchObject([{ source: m.node('EDGE-A'), target: m.node('EDGE-B'), sourcePort: 'Et0/2', targetPort: 'Et0/2' }]);
    expect(m.link('EDGE-A', 'SW-A')).toBeDefined();
    expect(m.link('EDGE-B', 'SW-B')).toBeDefined();
    expect(m.holderOf('172.20.10.11')).toBe(m.node('EDGE-A'));
    expect(m.holderOf('172.20.110.11')).toBe(m.node('EDGE-B'));
    expect(m.topo.roots).toHaveLength(2);
    // The two routers sit at the same height, each under its own way out.
    const at = layoutTree(m.topo).positions;
    expect(at[m.node('EDGE-A')]?.y).toBe(at[m.node('EDGE-B')]?.y);
    expect(at[m.node('EDGE-A')]?.x).toBeLessThan(at[m.node('EDGE-B')]?.x as number);
    expect(m.topo.nodes.find((n) => n.id === m.node('EDGE-A'))?.deviceType).toBe('router');
  });

  it('branches through the main site: one way out, branches hang from the main router by their tunnel', () => {
    const m = draw('hub-spoke');
    expect(m.exits).toHaveLength(1);
    expect(m.exitOf('HUB')?.link).toMatchObject({ inferred: false, targetPort: 'wan' });
    expect(m.link('HUB', 'SPOKE1')).toMatchObject({ inferred: false, sourcePort: 'Tunnel0', targetPort: 'Tunnel0', tunnel: true });
    expect(m.link('HUB', 'SPOKE2')).toMatchObject({ inferred: false });
    // A network of a branch where the scan found nothing is still shown, behind its router.
    expect(m.clouds).toEqual(['10.3.0.0/24']);
    expect(m.holderOf('10.2.0.20')).toBe(m.node('SPOKE1'));
  });

  it('two sites over a tunnel: two ways out, the tunnel joins the routers', () => {
    const m = draw('site-vpn');
    expect(m.exits).toHaveLength(2);
    expect(m.topo.peers).toMatchObject([{ source: m.node('RA'), target: m.node('RB'), sourcePort: 'Tu0', targetPort: 'Tu0', tunnel: true }]);
    expect(m.link('RA', 'RB')).toBeUndefined();
    expect(m.clouds).toEqual([]);
    expect(m.holderOf('10.2.0.20')).toBe(m.node('RB'));
  });

  it("provider link: each site's way out is named by its next hop, not called the internet", () => {
    const m = draw('provider-wan');
    expect(m.exits).toHaveLength(2);
    expect(m.exitOf('R1')?.node).toMatchObject({ label: 'Upstream', ip: '10.254.1.1' });
    expect(m.exitOf('R2')?.node).toMatchObject({ label: 'Upstream', ip: '10.254.2.1' });
    expect(m.exitOf('R1')?.link).toMatchObject({ inferred: false, targetPort: 'wan' });
    expect(m.link('R1', 'R2')).toBeUndefined();
    expect(m.clouds).toEqual(['10.2.0.0/24']);
  });

  it('modem in front of the router: the modem heads the map', () => {
    const m = draw('double-nat');
    expect(m.exits).toHaveLength(1);
    expect(m.exitOf('192.168.1.1')?.link.inferred).toBe(true);
    expect(m.link('192.168.1.1', 'R1')).toMatchObject({ inferred: false, targetPort: 'wan' });
    expect(m.clouds).toEqual([]);
  });

  it('no default route: the internet stays assumed, other networks stay drawn', () => {
    const m = draw('no-internet');
    expect(m.exitOf('R1')?.link.inferred).toBe(true);
    expect(m.clouds).toEqual(['10.0.5.0/24']);
  });

  it('scanned from outside: the way out is the next hop that was not read', () => {
    const m = draw('scanned-from-outside');
    expect(m.exitOf('R1')?.node).toMatchObject({ label: 'Upstream', ip: '172.16.0.1' });
    expect(m.exitOf('R1')?.link).toMatchObject({ inferred: false, targetPort: 'up' });
    expect(m.clouds).toEqual([]);
  });

  it('main site: the firewall the scan found heads the map; core, access switch and branch hang by what was read', () => {
    const m = draw('main-site');
    expect(m.exits).toHaveLength(1);
    expect(m.exitOf('172.20.255.1')?.link.inferred).toBe(true);
    expect(m.link('172.20.255.1', 'CORE')).toMatchObject({ inferred: false, targetPort: 'Et1/0' });
    expect(m.link('CORE', 'ACC1')).toMatchObject({ inferred: false, sourcePort: 'Et0/0', targetPort: 'Et0/0' });
    expect(m.link('CORE', 'BRANCH')).toMatchObject({ inferred: false, sourcePort: 'Tu0', targetPort: 'Tu0', tunnel: true });
    expect(m.topo.redundant).toBeUndefined();
    expect(m.topo.edges.filter((e) => e.target === m.node('ACC1'))).toHaveLength(1);
    expect(m.holderOf('172.20.30.11')).toBe(m.node('BRANCH'));
    expect(m.holderOf('172.20.10.11')).toBe(m.node('CORE'));
  });

  describe('this computer', () => {
    it('is marked on its own card when the scan found it', () => {
      const m = draw('flat', { self: ['192.168.1.20'] });
      expect(m.topo.nodes.filter((n) => n.self).map((n) => n.id)).toEqual([m.node('192.168.1.20')]);
    });

    it('hangs from the device heard on the port that carries its network, when it was not scanned', () => {
      const m = draw('two-sites', { self: ['10.0.0.50'] });
      const self = m.topo.nodes.find((n) => n.self);
      expect(self).toMatchObject({ id: 'self', label: 'This computer', ip: '10.0.0.50' });
      const holder = m.topo.edges.find((e) => e.target === 'self');
      expect(m.topo.nodes.find((n) => n.id === holder?.source)?.label).toBe('home-sw');
      expect(holder?.inferred).toBe(true);
    });

    it('hangs from the gateway of its network when devices are not drawn', () => {
      const m = draw('unread-gateway', { self: ['192.168.1.20'], clients: false });
      expect(m.topo.edges.find((e) => e.target === 'self')?.source).toBe(m.node('192.168.1.1'));
    });

    it('is left out when nothing on the map holds its network', () => {
      const m = draw('scanned-from-outside', { self: ['192.168.50.9'] });
      expect(m.topo.nodes.some((n) => n.self)).toBe(false);
    });
  });

  it.todo('virtual gateway: the two routers are drawn as a pair, not under an address no device owns');
});
