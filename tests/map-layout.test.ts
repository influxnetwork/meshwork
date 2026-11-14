import { describe, expect, it } from 'vitest';
import type { DeviceType } from '@shared/types';
import { BANK_MIN, WRAP_MIN, bankSiblings, connectionRows, layoutTree, neighbourType, type MapEdge, type MapNode, type Topology } from '../src/renderer/src/map-model';

const edge = (source: string, target: string, extra: Partial<MapEdge> = {}): MapEdge => ({ id: `${source}->${target}`, source, target, inferred: false, ...extra });

describe('bankSiblings', () => {
  const sw: MapNode = { id: 'sw', kind: 'device', managed: true, label: 'MDF' };
  const aps = Array.from({ length: 8 }, (_, i): MapNode => ({ id: `ap${i}`, kind: 'device', deviceType: 'ap', announced: true, label: `AP-${i}` }));
  const topo: Topology = {
    nodes: [{ id: 'internet', kind: 'internet' }, { id: 'gw', kind: 'gateway' }, sw, ...aps, { id: 'nas', kind: 'device', deviceType: 'storage' }],
    edges: [
      edge('internet', 'gw', { inferred: true }),
      edge('gw', 'sw'),
      ...aps.map((a, i) => edge('sw', a.id, { sourcePort: `gi${i + 11}`, poe: true, poeWatts: 5.6, vlan: { pvid: 10 } })),
      edge('sw', 'nas', { sourcePort: 'gi40' }),
    ],
    confirmed: true,
  };
  const typeOf = (n: MapNode) => (n.deviceType ?? 'unknown') as DeviceType;

  it('puts same-kind leaves into one group whose members keep their port, PoE and VLAN', () => {
    const t = bankSiblings(topo, typeOf);
    const bank = t.nodes.find((n) => n.id === 'bank:sw:ap');
    expect(bank).toMatchObject({ kind: 'group', title: 'Access points', count: 8 });
    expect(t.nodes.filter((n) => n.parent === 'bank:sw:ap')).toHaveLength(8);
    expect(t.nodes.find((n) => n.id === 'ap3')).toMatchObject({ parent: 'bank:sw:ap', port: 'gi14', poe: true, poeWatts: 5.6, vlan: 10 });
    // One cable to the group instead of eight; the lone NAS keeps its own.
    expect(t.edges.filter((e) => e.source === 'sw').map((e) => e.target).sort()).toEqual(['bank:sw:ap', 'nas']);
    expect(t.edges.find((e) => e.target === 'bank:sw:ap')).toMatchObject({ sourcePort: expect.stringContaining('gi11'), poe: true });
    // The group comes before its members, as the canvas needs.
    const order = t.nodes.map((n) => n.id);
    expect(order.indexOf('bank:sw:ap')).toBeLessThan(order.indexOf('ap0'));
  });

  it('leaves fewer than the minimum, managed devices and devices with children alone', () => {
    const few: Topology = { ...topo, nodes: topo.nodes.slice(0, 3 + BANK_MIN - 1), edges: topo.edges.slice(0, 2 + BANK_MIN - 1) };
    expect(bankSiblings(few, typeOf)).toBe(few);
    const withKids: Topology = { ...topo, nodes: [...topo.nodes, { id: 'phone', kind: 'device' }], edges: [...topo.edges, edge('ap0', 'phone')] };
    const t = bankSiblings(withKids, typeOf);
    expect(t.nodes.find((n) => n.id === 'ap0')?.parent).toBeUndefined();
    expect(t.nodes.find((n) => n.id === 'bank:sw:ap')?.count).toBe(7);
  });

  it('gives the group cable every VLAN its members carry, and members their tagged VLANs', () => {
    const trunk: Topology = {
      ...topo,
      edges: topo.edges.map((e, i) => (e.target.startsWith('ap') ? { ...e, vlan: { pvid: i % 2 ? 10 : 20, tagged: [69] } } : e)),
    };
    const t = bankSiblings(trunk, typeOf);
    expect(t.edges.find((e) => e.target === 'bank:sw:ap')?.vlan).toEqual({ pvid: undefined, tagged: [10, 20, 69] });
    expect(t.nodes.find((n) => n.id === 'ap0')?.tagged).toEqual([69]);
  });

  it('keeps an assumed member unconfirmed in the connections list, even in a confirmed group', () => {
    const mixed: Topology = { ...topo, edges: topo.edges.map((e) => (e.target === 'ap7' ? { ...e, inferred: true } : e)) };
    const rows = connectionRows(bankSiblings(mixed, typeOf), (n) => ({ name: n.label ?? n.id }));
    expect(rows.find((r) => r.id === 'ap0')).toMatchObject({ confirmed: true, switchPort: 'gi11' });
    expect(rows.find((r) => r.id === 'ap7')?.confirmed).toBe(false);
  });

  it('lets the group cable add up the traffic of its members, each keeping its own port', () => {
    const measured: Topology = { ...topo, edges: topo.edges.map((e, i) => (e.target.startsWith('ap') ? { ...e, traffic: { ip: '10.0.0.2', ifIndex: 10 + i } } : e)) };
    const t = bankSiblings(measured, typeOf);
    expect(t.edges.find((e) => e.target === 'bank:sw:ap')?.trafficPorts).toHaveLength(8);
    expect(t.nodes.find((n) => n.id === 'ap0')?.traffic).toEqual(measured.edges.find((e) => e.target === 'ap0')?.traffic);
  });

  it('hides the members of a folded group but keeps its count', () => {
    const t = bankSiblings(topo, typeOf, new Set(['bank:sw:ap']));
    expect(t.nodes.find((n) => n.id === 'bank:sw:ap')).toMatchObject({ collapsed: true, count: 8 });
    expect(t.nodes.some((n) => n.parent === 'bank:sw:ap')).toBe(false);
  });
});

/** Small deterministic random generator, so a failing shape can be replayed from its seed. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** A random network: switches several levels deep, devices and groups under them. */
function randomTopology(seed: number): Topology {
  const r = rng(seed);
  const nodes: MapNode[] = [{ id: 'internet', kind: 'internet' }, { id: 'gw', kind: 'gateway' }];
  const edges: MapEdge[] = [edge('internet', 'gw', { inferred: true })];
  let n = 0;
  const grow = (parent: string, depth: number) => {
    const kids = Math.floor(r() * (depth === 0 ? 14 : 9));
    for (let i = 0; i < kids; i++) {
      const id = `n${++n}`;
      const roll = r();
      if (roll < 0.2) {
        nodes.push({ id, kind: 'group', count: 0 });
        const members = 1 + Math.floor(r() * 30);
        for (let m = 0; m < members; m++) nodes.push({ id: `${id}m${m}`, kind: 'device', parent: id });
      } else nodes.push({ id, kind: 'device', managed: roll > 0.75 });
      edges.push(edge(parent, id, { sourcePort: `gi${i + 1}` }));
      if (roll > 0.75 && depth < 3) grow(id, depth + 1);
    }
  };
  grow('gw', 0);
  return { nodes, edges, confirmed: true };
}

describe('layout never overlaps', () => {
  it.each(Array.from({ length: 60 }, (_, i) => i + 1))('random network %i', (seed) => {
    const t = randomTopology(seed);
    const { positions, sizes } = layoutTree(t);
    const top = t.nodes.filter((n) => !n.parent);
    const boxes = top.map((n) => ({ id: n.id, ...(positions[n.id] as { x: number; y: number }), ...(sizes[n.id] as { w: number; h: number }) }));
    for (const b of boxes) expect(Number.isFinite(b.x) && Number.isFinite(b.y), `${b.id} has no position`).toBe(true);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(hit, `seed ${seed}: ${a.id} overlaps ${b.id}`).toBe(false);
      }
    // Members sit inside their group and do not overlap each other.
    for (const g of t.nodes.filter((x) => x.kind === 'group')) {
      const gs = sizes[g.id]!;
      const ms = t.nodes.filter((x) => x.parent === g.id).map((m) => ({ ...(positions[m.id] as { x: number; y: number }), ...(sizes[m.id] as { w: number; h: number }) }));
      for (const m of ms) expect(m.x >= 0 && m.y >= 0 && m.x + m.w <= gs.w + 0.5 && m.y + m.h <= gs.h + 0.5, `seed ${seed}: member outside ${g.id}`).toBe(true);
    }
  });
});

describe('staggered rows', () => {
  const many = (n: number): Topology => {
    const nodes: MapNode[] = [{ id: 'internet', kind: 'internet' }, { id: 'gw', kind: 'gateway' }, { id: 'sw', kind: 'device', managed: true }];
    const edges: MapEdge[] = [edge('internet', 'gw', { inferred: true }), edge('gw', 'sw')];
    for (let i = 0; i < n; i++) {
      nodes.push({ id: `d${i}`, kind: 'device' });
      edges.push(edge('sw', `d${i}`, { sourcePort: `gi${i + 1}` }));
    }
    return { nodes, edges, confirmed: true };
  };

  it('keeps a short row as one row', () => {
    const { positions } = layoutTree(many(6));
    expect(new Set(Array.from({ length: 6 }, (_, i) => positions[`d${i}`]?.y)).size).toBe(1);
  });

  it('splits many end devices into two rows, about half as wide, each back-row cable dropping through a gap', () => {
    const n = 14;
    const one = layoutTree(many(WRAP_MIN - 1)).positions;
    const { positions, sizes } = layoutTree(many(n));
    const ys = [...new Set(Array.from({ length: n }, (_, i) => positions[`d${i}`]?.y))];
    expect(ys).toHaveLength(2);
    // Port order is kept from left to right.
    const xs = Array.from({ length: n }, (_, i) => positions[`d${i}`]?.x as number);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
    const front = Array.from({ length: n }, (_, i) => `d${i}`).filter((_, i) => i % 2 === 0);
    const back = Array.from({ length: n }, (_, i) => `d${i}`).filter((_, i) => i % 2 === 1);
    for (const b of back) {
      const cx = (positions[b]?.x as number) + (sizes[b]?.w as number) / 2;
      for (const f of front) {
        const fx = positions[f]?.x as number;
        expect(cx > fx && cx < fx + (sizes[f]?.w as number), `${b}'s cable crosses ${f}`).toBe(false);
      }
    }
    const width = Math.max(...xs) + (sizes.d0?.w as number) - Math.min(...xs);
    expect(width).toBeLessThan(n * ((sizes.d0?.w as number) + 32) * 0.7);
    expect(one).toBeDefined();
  });
});

describe('neighbourType', () => {
  it('tells a UniFi OS gateway from an access point', () => {
    expect(neighbourType('gw-main', 'Debian GNU/Linux 11 (bullseye) Linux 4.19.152-ui-alpine #4.19.152 SMP aarch64')).toBe('router');
    expect(neighbourType('WAP-01', 'HPE Networking Instant On Access Point 2x2 Wi-Fi 6 Indoor (US) AP22')).toBe('ap');
  });
});
