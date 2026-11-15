import { describe, expect, it } from 'vitest';
import { buildTopology, layoutTree, type Topology } from '../../src/renderer/src/map-model';
import { SCENARIOS, type Scenario } from './scenarios';

const draw = (s: Scenario, devices = s.devices, clients = true): Topology =>
  buildTopology(s.network, s.assets, { clients, collapsed: new Set() }, devices.length ? { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: devices.length, devices } : null);

/** Every link of a map as text, sorted, so two maps can be compared whatever order they were built in. */
const links = (t: Topology) =>
  [
    ...t.edges.map((e) => `tree ${e.source} ${e.sourcePort ?? '-'} > ${e.targetPort ?? '-'} ${e.target} ${e.inferred ? 'assumed' : 'seen'}`),
    ...(t.redundant ?? []).map((e) => `redundant ${[e.source, e.target].sort().join(' ')}`),
    ...(t.peers ?? []).map((e) => `peer ${[e.source, e.target].sort().join(' ')}`),
  ].sort();

/** The devices of a scenario in every rotation, and reversed. */
const orders = <T>(list: T[]): T[][] => [...list.map((_, i) => [...list.slice(i), ...list.slice(0, i)]), [...list].reverse()];

describe.each(SCENARIOS)('$id: what holds for every map', (s) => {
  for (const clients of [true, false]) {
    const t = draw(s, s.devices, clients);
    const view = clients ? 'with devices' : 'network gear only';
    const roots = t.roots?.length ? t.roots : ['internet'];
    const cards = t.nodes.filter((n) => !n.parent);

    it(`${view}: every card hangs from exactly one place, and the trees reach all of them`, () => {
      for (const n of cards) {
        const incoming = t.edges.filter((e) => e.target === n.id);
        expect(incoming, `${n.id} (${n.label ?? n.ip ?? n.kind})`).toHaveLength(roots.includes(n.id) ? 0 : 1);
      }
      const reached = new Set(roots);
      const queue = [...roots];
      for (let id = queue.shift(); id; id = queue.shift()) {
        for (const e of t.edges) if (e.source === id && !reached.has(e.target)) queue.push((reached.add(e.target), e.target));
      }
      expect(cards.filter((n) => !reached.has(n.id)).map((n) => n.id)).toEqual([]);
      const at = layoutTree(t).positions;
      expect(t.nodes.filter((n) => !at[n.id]).map((n) => n.id)).toEqual([]);
    });

    it(`${view}: no node, link or pair of devices is drawn twice`, () => {
      const ids = t.nodes.map((n) => n.id);
      expect(ids.length).toBe(new Set(ids).size);
      const all = [...t.edges, ...(t.redundant ?? []), ...(t.peers ?? [])];
      expect(all.length).toBe(new Set(all.map((e) => e.id)).size);
      // A link between trees joins two different trees, and is not also a tree link.
      const pair = (e: { source: string; target: string }) => [e.source, e.target].sort().join('|');
      const tree = new Set(t.edges.map(pair));
      expect((t.peers ?? []).filter((e) => tree.has(pair(e))).map((e) => e.id)).toEqual([]);
      for (const e of all) expect(ids, e.id).toEqual(expect.arrayContaining([e.source, e.target]));
    });
  }

  it('the order the devices answered in does not change the map', () => {
    const expected = links(draw(s));
    for (const devices of orders(s.devices)) expect(links(draw(s, devices)), devices.map((d) => d.sysName).join(',')).toEqual(expected);
  });
});
