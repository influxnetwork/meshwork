import { describe, expect, it } from 'vitest';
import type { Asset, DeviceType } from '@shared/types';
import {
  placeCableLabels,
  searchMap,
  vlanLabel,
  type MapSearchEntry, GATEWAY_ID, INTERNET_ID, MEMBER_SIZE, attachLinks, buildTopology, facingSide, findGateway, groupId, ipKey, layoutTree, memberColumns, type Box } from '../src/renderer/src/map-model';

let seq = 0;
const asset = (ip: string, type: DeviceType, extra: Partial<Asset> = {}): Asset => ({
  id: `a${++seq}`,
  networkId: 'n1',
  firstSeen: '2026-01-01T00:00:00Z',
  lastSeen: '2026-01-01T00:00:00Z',
  lastRunId: 'r1',
  isNew: false,
  ip,
  names: [],
  aliveVia: ['tcp'],
  ports: [],
  type,
  typeConfidence: 0.9,
  evidence: [],
  risks: [],
  ...extra,
});

const all = { clients: true, collapsed: new Set<string>() };

describe('map gateway', () => {
  it('prefers the router MAC, then the gateway IP, then the lowest router', () => {
    const r1 = asset('10.0.0.1', 'router', { mac: 'aa:bb:cc:00:00:01' });
    const r2 = asset('10.0.0.254', 'firewall', { mac: 'aa:bb:cc:00:00:fe' });
    expect(findGateway({ gatewayMac: 'AA:BB:CC:00:00:FE' }, [r1, r2])?.id).toBe(r2.id);
    expect(findGateway({ gatewayIp: '10.0.0.254' }, [r1, r2])?.id).toBe(r2.id);
    expect(findGateway({}, [r2, r1])?.id).toBe(r1.id);
    expect(findGateway({}, [asset('10.0.0.9', 'phone')])).toBeUndefined();
  });

  it('draws a placeholder gateway when it is not in the inventory', () => {
    const t = buildTopology({ gatewayIp: '10.0.0.1' }, [asset('10.0.0.5', 'phone')], all);
    expect(t.nodes.find((n) => n.id === GATEWAY_ID)).toMatchObject({ kind: 'gateway', ip: '10.0.0.1' });
    expect(t.edges[0]).toMatchObject({ source: INTERNET_ID, target: GATEWAY_ID, inferred: true });
  });
});

describe('map topology', () => {
  const gw = asset('10.0.0.1', 'router');
  const sw = asset('10.0.0.56', 'switch');
  const ap = asset('10.0.0.178', 'ap');
  const pc2 = asset('10.0.0.20', 'laptop');
  const pc1 = asset('10.0.0.3', 'computer');
  const cam = asset('10.0.0.4', 'camera');
  const unknown = asset('10.0.0.48', 'unknown');
  const devices = [unknown, cam, pc2, ap, gw, sw, pc1];

  it('puts network gear under the gateway and groups the rest by kind', () => {
    const t = buildTopology({ gatewayIp: '10.0.0.1' }, devices, all);
    const under = (id: string) => t.edges.filter((e) => e.source === id).map((e) => e.target);
    expect(under(gw.id)).toEqual([sw.id, ap.id, groupId('computers'), groupId('cameras'), groupId('other')]);
    // Devices sit inside their group, ordered by address, without links of their own.
    expect(t.nodes.filter((n) => n.parent === groupId('computers')).map((n) => n.id)).toEqual([pc1.id, pc2.id]);
    expect(under(groupId('computers'))).toEqual([]);
    expect(t.nodes.find((n) => n.id === groupId('computers'))?.count).toBe(2);
  });

  it('hides end devices in the infrastructure view and in collapsed groups', () => {
    const gear = buildTopology({ gatewayIp: '10.0.0.1' }, devices, { clients: false, collapsed: new Set() });
    expect(gear.nodes.map((n) => n.id)).toEqual([INTERNET_ID, gw.id, sw.id, ap.id]);
    const folded = buildTopology({ gatewayIp: '10.0.0.1' }, devices, { clients: true, collapsed: new Set([groupId('computers')]) });
    const group = folded.nodes.find((n) => n.id === groupId('computers'));
    expect(group).toMatchObject({ collapsed: true, count: 2 });
    expect(folded.nodes.some((n) => n.id === pc1.id)).toBe(false);
  });
});

describe('map layout', () => {
  it('places children below parents and never overlaps top-level nodes', () => {
    const many = Array.from({ length: 9 }, (_, i) => asset(`10.0.1.${i + 10}`, 'phone'));
    const cams = Array.from({ length: 3 }, (_, i) => asset(`10.0.1.${i + 40}`, 'camera'));
    const t = buildTopology({ gatewayIp: '10.0.1.1' }, [asset('10.0.1.1', 'router'), asset('10.0.1.2', 'switch'), ...many, ...cams], all);
    const { positions, sizes } = layoutTree(t);
    expect(Object.keys(positions)).toHaveLength(t.nodes.length);
    for (const e of t.edges) expect((positions[e.target]?.y ?? 0) > (positions[e.source]?.y ?? 0)).toBe(true);
    const top = t.nodes.filter((n) => !n.parent).map((n) => ({ ...positions[n.id]!, ...sizes[n.id]! }));
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = top[i]!;
        const b = top[j]!;
        expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
      }
    }
  });

  it('leaves room under a busy parent for every link to turn in its own lane', () => {
    const t = {
      nodes: [
        { id: INTERNET_ID, kind: 'internet' as const },
        { id: 'p', kind: 'device' as const },
        ...Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, kind: 'device' as const })),
      ],
      edges: [{ id: 'up', source: INTERNET_ID, target: 'p' }, ...Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, source: 'p', target: `k${i}` }))],
      confirmed: true,
    };
    const { positions, sizes } = layoutTree(t as never);
    const boxes = new Map<string, Box>(t.nodes.map((n) => [n.id, { ...positions[n.id]!, ...sizes[n.id]! }]));
    const at = attachLinks(boxes, t.edges);
    const turns = t.edges.slice(1).map((e) => at.get(e.id)!).filter((a) => a.sourceSide === 'bottom');
    const childTop = positions.k0!.y;
    // Every link turns at its own lane depth, clear of the children, instead of piling up against their tops.
    expect(turns.length).toBeGreaterThan(2);
    for (const a of turns) {
      expect(a.turn! - a.sy).toBe(22 + a.lane! * 22);
      expect(a.turn!).toBeLessThanOrEqual(childTop - 40);
    }
  });

  it('stacks devices inside their group and grows the group to fit', () => {
    const many = Array.from({ length: 12 }, (_, i) => asset(`10.0.2.${i + 10}`, 'phone'));
    const t = buildTopology({}, many, all);
    const { positions, sizes } = layoutTree(t);
    expect(memberColumns(12)).toBe(2);
    expect(new Set(many.map((a) => positions[a.id]?.x)).size).toBe(2);
    const group = sizes[groupId('phones')]!;
    for (const a of many) {
      const p = positions[a.id]!;
      expect(p.x >= 0 && p.y >= 0 && p.x + MEMBER_SIZE.w <= group.w && p.y + MEMBER_SIZE.h <= group.h).toBe(true);
    }
  });

  it('keeps small groups to one column and large ones to three', () => {
    expect(memberColumns(8)).toBe(1);
    expect(memberColumns(21)).toBe(3);
  });

  it('sorts addresses numerically', () => {
    expect(ipKey('10.0.0.9') < ipKey('10.0.0.10')).toBe(true);
    expect(ipKey('not an ip')).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('map link attachment', () => {
  const sw: Box = { x: 400, y: 200, w: 200, h: 50 };
  const box = (x: number, y: number): Box => ({ x, y, w: 200, h: 50 });

  it('uses the side of each node that faces the other', () => {
    expect(facingSide(sw, box(400, 400))).toBe('bottom');
    expect(facingSide(sw, box(400, 0))).toBe('top');
    expect(facingSide(sw, box(800, 210))).toBe('right');
    expect(facingSide(sw, box(0, 190))).toBe('left');
  });

  it('spreads links sharing a side in the order of their far ends', () => {
    const boxes = new Map<string, Box>([
      ['sw', sw],
      ['a', box(100, 400)],
      ['b', box(400, 400)],
      ['c', box(700, 400)],
    ]);
    const at = attachLinks(boxes, ['c', 'a', 'b'].map((t) => ({ id: t, source: 'sw', target: t })));
    const xs = ['a', 'b', 'c'].map((t) => at.get(t)?.sx ?? 0);
    expect(xs[0]! < xs[1]! && xs[1]! < xs[2]!).toBe(true);
    for (const t of ['a', 'b', 'c']) expect(at.get(t)).toMatchObject({ sy: 250, sourceSide: 'bottom', targetSide: 'top' });
  });

  it('gives links sharing a side their own lanes, without crossings', () => {
    const boxes = new Map<string, Box>([
      ['sw', sw],
      ['a', box(700, 450)],
      ['b', box(950, 450)],
    ]);
    const at = attachLinks(boxes, [
      { id: 'a', source: 'sw', target: 'a' },
      { id: 'b', source: 'sw', target: 'b' },
    ]);
    const a = at.get('a')!;
    const b = at.get('b')!;
    expect(a.turn).not.toBe(b.turn);
    // Both head right: the link leaving further right turns first, so the other passes below it.
    expect(b.sx > a.sx && (b.turn ?? 0) < (a.turn ?? 0)).toBe(true);
  });

  it('sends the outermost of many downward links out of the left and right sides', () => {
    const boxes = new Map<string, Box>([['sw', sw]]);
    const xs = [-500, -250, 0, 400, 700, 1000, 1250];
    xs.forEach((x, i) => boxes.set(`k${i}`, box(x, 450)));
    const at = attachLinks(boxes, xs.map((_, i) => ({ id: `k${i}`, source: 'sw', target: `k${i}` })));
    expect(at.get('k0')).toMatchObject({ sourceSide: 'left', targetSide: 'top' });
    expect(at.get('k0')!.turn).toBeUndefined();
    expect(at.get('k1')).toMatchObject({ sourceSide: 'left' });
    expect(at.get('k5')).toMatchObject({ sourceSide: 'right' });
    expect(at.get('k6')).toMatchObject({ sourceSide: 'right' });
    for (const k of ['k2', 'k3', 'k4']) expect(at.get(k)?.sourceSide).toBe('bottom');
    // The link going furthest leaves highest, so the two nest without crossing.
    expect(at.get('k0')!.sy).toBeLessThan(at.get('k1')!.sy);
    expect(at.get('k6')!.sy).toBeLessThan(at.get('k5')!.sy);
  });

  it('moves a link to the top or the side when its device is dragged there', () => {
    const boxes = new Map<string, Box>([
      ['sw', sw],
      ['up', box(400, -100)],
      ['right', box(900, 200)],
    ]);
    const at = attachLinks(boxes, [
      { id: 'up', source: 'sw', target: 'up' },
      { id: 'right', source: 'sw', target: 'right' },
    ]);
    expect(at.get('up')).toMatchObject({ sourceSide: 'top', sy: 200, targetSide: 'bottom' });
    expect(at.get('right')).toMatchObject({ sourceSide: 'right', sx: 600, targetSide: 'left', tx: 900 });
  });
});

describe('map search', () => {
  const entries: MapSearchEntry[] = [
    { id: 'a', name: 'nas-office', ip: '10.0.0.191', mac: 'b4:2e:99:aa:bb:cc', vendor: 'Synology' },
    { id: 'b', name: 'Printer', ip: '10.0.0.19', mac: '00:1b:a9:12:34:56', vendor: 'Brother', port: 'gi15' },
    { id: 'c', name: 'Unknown device', mac: 'f2:11:22:33:44:55' },
  ];
  const ids = (q: string) => searchMap(entries, q).map((e) => e.id);

  it('puts the exact IP address first', () => {
    expect(ids('10.0.0.19')).toEqual(['b', 'a']);
  });
  it('finds MAC addresses written with any separator', () => {
    expect(ids('b4:2e:99')).toEqual(['a']);
    expect(ids('B42E.99AA')).toEqual(['a']);
    expect(ids('f2-11-22-33-44-55')).toEqual(['c']);
    expect(ids('3344')).toEqual(['c']);
  });
  it('finds names, vendors and ports', () => {
    expect(ids('nas')).toEqual(['a']);
    expect(ids('brother')).toEqual(['b']);
    expect(ids('gi15')).toEqual(['b']);
    expect(ids('   ')).toEqual([]);
  });
});

describe('placeCableLabels', () => {
  const vertical = (d: number) => ({ x: 0, y: d });
  const horizontal = (d: number) => ({ x: d, y: 0 });
  const port = { w: 90, h: 18 };
  const mid = { w: 52, h: 20 };
  const clear = (a: { x: number; y: number }, sa: { w: number; h: number }, b: { x: number; y: number }, sb: { w: number; h: number }) =>
    Math.abs(a.x - b.x) >= (sa.w + sb.w) / 2 || Math.abs(a.y - b.y) >= (sa.h + sb.h) / 2;

  it('puts port names towards their own device on a long cable, the middle label halfway', () => {
    const p = placeCableLabels(400, vertical, { src: port, dst: port, mid });
    // 28% of the cable would be 112; the near edge stops 90 past the closest spot (15), so 105.
    expect(p.src?.y).toBeCloseTo(105);
    expect(p.dst?.y).toBeCloseTo(295);
    expect(p.mid).toEqual({ x: 0, y: 200 });
    // All on the line.
    expect([p.src?.x, p.dst?.x, p.mid?.x]).toEqual([0, 0, 0]);
  });

  it('keeps three labels apart on a short cable between two rows', () => {
    const p = placeCableLabels(76, vertical, { src: port, dst: port, mid });
    const { src, dst, mid: m } = p as Required<typeof p>;
    expect(clear(src, port, dst, port)).toBe(true);
    expect(clear(src, port, m, mid)).toBe(true);
    expect(clear(dst, port, m, mid)).toBe(true);
    // Port names stay on the cable and on their own side of it.
    expect(src.x).toBe(0);
    expect(dst.x).toBe(0);
    expect(src.y).toBeLessThan(dst.y);
  });

  it('slides wide port names towards their ends on a horizontal cable', () => {
    const p = placeCableLabels(300, horizontal, { src: port, dst: port, mid });
    const { src, dst, mid: m } = p as Required<typeof p>;
    expect(src.x).toBeLessThan(m.x);
    expect(m.x).toBeLessThan(dst.x);
    expect(clear(src, port, m, mid)).toBe(true);
    expect(clear(dst, port, m, mid)).toBe(true);
    expect([src.y, dst.y, m.y]).toEqual([0, 0, 0]);
  });

  it('reads points whose coordinates live on the prototype, as browser points do', () => {
    class BrowserPoint {
      #x: number;
      #y: number;
      constructor(x: number, y: number) {
        this.#x = x;
        this.#y = y;
      }
      get x() {
        return this.#x;
      }
      get y() {
        return this.#y;
      }
    }
    const p = placeCableLabels(400, (d) => new BrowserPoint(0, d), { src: port, dst: port, mid });
    expect(p.mid).toEqual({ x: 0, y: 200 });
    expect(p.src).toEqual({ x: 0, y: expect.closeTo(105) });
  });

  it('moves port names out with the cable but no further than a set distance', () => {
    expect(placeCableLabels(200, vertical, { src: port }).src?.y).toBeCloseTo(56);
    expect(placeCableLabels(1200, vertical, { src: port }).src?.y).toBeCloseTo(105);
  });

  it('slides a port name along its cable past another cable\'s label, staying on its own half', () => {
    const before = placeCableLabels(400, vertical, { src: port });
    const blocker = { x: -50, y: (before.src?.y ?? 0) - 12, w: 100, h: 24 };
    const after = placeCableLabels(400, vertical, { src: port }, [blocker]);
    expect(after.src?.x).toBe(0);
    expect(after.src!.y - port.h / 2).toBeGreaterThanOrEqual(blocker.y + blocker.h);
    expect(after.src!.y).toBeLessThan(200);
  });

  it('puts a port name beside its cable when every spot along it is taken', () => {
    const wall = { x: -60, y: 0, w: 52, h: 400 };
    const p = placeCableLabels(400, vertical, { src: port }, [wall]);
    expect(p.src!.x - port.w / 2).toBeGreaterThanOrEqual(wall.x + wall.w);
  });

  it('moves the middle label off another cable\'s label', () => {
    const blocker = { x: -40, y: 190, w: 80, h: 20 };
    const p = placeCableLabels(400, vertical, { mid }, [blocker]);
    const hit = Math.abs((p.mid?.y ?? 0) - 200) < (mid.h + blocker.h) / 2 + 6;
    expect(hit).toBe(false);
  });

  it('places nothing on a cable with no length', () => {
    expect(placeCableLabels(0, vertical, { src: port })).toEqual({});
  });
});

describe('vlanLabel', () => {
  it('shows an access port as its untagged VLAN', () => {
    expect(vlanLabel({ pvid: 10 })).toBe('U10');
  });

  it('leaves a port on the default VLAN unlabelled', () => {
    expect(vlanLabel({ pvid: 1 })).toBeUndefined();
    expect(vlanLabel(undefined)).toBeUndefined();
    expect(vlanLabel({})).toBeUndefined();
  });

  it('shows a trunk as untagged plus tagged VLANs, sorted', () => {
    expect(vlanLabel({ pvid: 1, tagged: [99, 10, 20] })).toBe('U1 T10,20,99');
  });

  it('collapses runs of three or more tagged VLANs into a range', () => {
    expect(vlanLabel({ pvid: 1, tagged: [10, 11, 12, 13, 20, 21, 99] })).toBe('U1 T10-13,20,21,99');
    expect(vlanLabel({ pvid: 1, tagged: Array.from({ length: 4093 }, (_, i) => i + 2) })).toBe('U1 T2-4094');
  });

  it('shows only tagged VLANs when the untagged one is not known', () => {
    expect(vlanLabel({ tagged: [20, 10] })).toBe('T10,20');
  });

  it('does not list the untagged VLAN again among the tagged ones', () => {
    expect(vlanLabel({ pvid: 10, tagged: [10, 20] })).toBe('U10 T20');
  });
});
