import { describe, expect, it } from 'vitest';
import type { Asset, DeviceType, GearSnapshot } from '@shared/types';
import { OID, advanceTraffic, macOf, missedTraffic, num, parseGear, rate, text, type GearWalks, type Varbind } from '../src/main/snmp-parse';
import { buildTopology, connectionCells, connectionRows, gatewayFromGear, gearRole, groupId, isPhysicalPort, neighbourType, shortPort, summarizePorts } from '../src/renderer/src/map-model';

const vb = (oid: string, value: unknown): Varbind => ({ oid, value });
const mac = (s: string) => s.split(':').map((h) => parseInt(h, 16));

/** A 4-port switch: port 1 to the router, 2 to an access point (LLDP, PoE), 3 a PC, 4 two devices. */
function walks(): GearWalks {
  const ports = [1, 2, 3, 4].map((n) => 100 + n);
  const fdb: [string, number][] = [
    ['aa:00:00:00:00:01', 101], // router
    ['aa:00:00:00:00:02', 102], // access point
    ['aa:00:00:00:00:21', 102], // wireless client behind the access point
    ['aa:00:00:00:00:03', 103], // PC alone on port 3
    ['aa:00:00:00:00:41', 104], // two devices on port 4
    ['aa:00:00:00:00:42', 104],
  ];
  return {
    system: [
      vb(OID.sysName, Buffer.from('core-sw')),
      vb(OID.sysDescr, Buffer.from('24-port managed switch')),
      vb(OID.sysUpTime, 360000),
      vb(OID.baseBridgeAddress, Buffer.from(mac('aa:00:00:00:00:99'))),
      vb(OID.stpPriority, 32768),
    ],
    ifName: ports.map((p) => vb(`${OID.ifName}.${p}`, Buffer.from(`gi${p - 100}`))),
    ifDescr: ports.map((p) => vb(`${OID.ifDescr}.${p}`, Buffer.from(`gigabitethernet${p - 100}`))),
    ifAlias: [vb(`${OID.ifAlias}.102`, Buffer.from('Lobby AP'))],
    ifOperStatus: ports.map((p) => vb(`${OID.ifOperStatus}.${p}`, 1)),
    ifHighSpeed: ports.map((p) => vb(`${OID.ifHighSpeed}.${p}`, 1000)),
    basePortIfIndex: [1, 2, 3, 4].map((n) => vb(`${OID.basePortIfIndex}.${n}`, 100 + n)),
    qFdbPort: [
      ...fdb.map(([m, p]) => vb(`${OID.qFdbPort}.1.${mac(m).join('.')}`, p - 100)),
      vb(`${OID.qFdbPort}.1.${mac('aa:00:00:00:00:99').join('.')}`, 0),
    ],
    qFdbStatus: [
      ...fdb.map(([m]) => vb(`${OID.qFdbStatus}.1.${mac(m).join('.')}`, 3)),
      vb(`${OID.qFdbStatus}.1.${mac('aa:00:00:00:00:99').join('.')}`, 4),
    ],
    dot1dFdbPort: [],
    dot1dFdbStatus: [],
    ipNetToMedia: [vb(`${OID.ipNetToMedia}.300000.10.9.0.1`, Buffer.from(mac('aa:00:00:00:00:01')))],
    ipAdEntIfIndex: [vb(`${OID.ipAdEntIfIndex}.10.9.0.250`, 300000)],
    ipAdEntNetMask: [vb(`${OID.ipAdEntNetMask}.10.9.0.250`, '255.255.255.0')],
    defaultRoutes: [vb(`${OID.inetCidrRouteIfIndexDefault}.2.0.0.1.4.10.9.0.1`, 300000)],
    // VLAN 1 untagged everywhere except port 3; VLAN 69 untagged on port 3 and tagged on port 2 (the AP).
    vlanStaticName: [vb(`${OID.vlanStaticName}.69`, Buffer.from('ISOLATED'))],
    vlanStaticEgress: [vb(`${OID.vlanStaticEgress}.69`, Buffer.from([0b0110_0000]))],
    vlanStaticUntagged: [vb(`${OID.vlanStaticUntagged}.69`, Buffer.from([0b0010_0000]))],
    vlanCurrentEgress: [vb(`${OID.vlanCurrentEgress}.0.1`, Buffer.from([0b1101_0000])), vb(`${OID.vlanCurrentEgress}.0.69`, Buffer.from([0]))],
    vlanCurrentUntagged: [vb(`${OID.vlanCurrentUntagged}.0.1`, Buffer.from([0b1101_0000]))],
    pvid: [1, 2, 3, 4].map((n) => vb(`${OID.pvid}.${n}`, n === 3 ? 69 : 1)),
    lldpLocPortId: ports.map((p) => vb(`${OID.lldpLocPortId}.${p}`, Buffer.from(`gi${p - 100}`))),
    lldpRem: [
      vb(`${OID.lldpRem}.4.0.102.1`, 4),
      vb(`${OID.lldpRem}.5.0.102.1`, Buffer.from(mac('aa:00:00:00:00:02'))),
      vb(`${OID.lldpRem}.6.0.102.1`, 5),
      vb(`${OID.lldpRem}.7.0.102.1`, Buffer.from('eth0')),
      vb(`${OID.lldpRem}.9.0.102.1`, Buffer.from('lobby-ap')),
      vb(`${OID.lldpRem}.10.0.102.1`, Buffer.from('Wireless access point')),
    ],
    lldpRemManAddr: [vb(`${OID.lldpRemManAddr}.0.102.1.1.4.10.9.0.2`, 2)],
    pethPortDetection: ports.map((p) => vb(`${OID.pethPortDetection}.1.${p}`, p === 102 ? 3 : 2)),
    pethMain: [vb(`${OID.pethMain}.2.1`, 180), vb(`${OID.pethMain}.4.1`, 7)],
    poePortMilliwatts: [vb(`${OID.poePortMilliwattsSb}.1.102`, 6150)],
  };
}

describe('SNMP decoding', () => {
  it('reads per-port PoE watts from the Catalyst power table too', () => {
    const d = parseGear('10.9.0.250', { ...walks(), poePortMilliwatts: [vb(`${OID.poePortMilliwattsCisco}.1.103`, 15400)] });
    expect(d.interfaces[2]).toMatchObject({ poe: true, poeWatts: 15.4 });
  });

  it('reads ports, learned addresses, LLDP neighbours and PoE', () => {
    const d = parseGear('10.9.0.250', walks());
    expect(d).toMatchObject({ sysName: 'core-sw', uptimeSec: 3600, mac: 'aa:00:00:00:00:99', stpPriority: 32768, poe: { budgetW: 180, usedW: 7 } });
    expect(d.interfaces.map((i) => i.name)).toEqual(['gi1', 'gi2', 'gi3', 'gi4']);
    expect(d.interfaces[1]).toMatchObject({ alias: 'Lobby AP', up: true, speedMbps: 1000, poe: true, poeWatts: 6.2 });
    // The switch's own address (status "self") is not a learned entry.
    expect(d.fdb).toHaveLength(6);
    expect(d.fdb.find((f) => f.mac === 'aa:00:00:00:00:03')?.ifIndex).toBe(103);
    expect(d.arp).toEqual([{ ip: '10.9.0.1', mac: 'aa:00:00:00:00:01' }]);
    expect(d.addresses).toEqual([{ ip: '10.9.0.250', prefix: 24, ifIndex: 300000 }]);
    expect(d.defaultRoute).toEqual({ nextHop: '10.9.0.1', ifIndex: 300000 });
    expect(d.vlans).toEqual([{ id: 1, name: undefined }, { id: 69, name: 'ISOLATED' }]);
    expect(d.interfaces.map((i) => [i.name, i.pvid, i.tagged])).toEqual([
      ['gi1', 1, undefined],
      ['gi2', 1, [69]],
      ['gi3', 69, undefined],
      ['gi4', 1, undefined],
    ]);
    expect(d.neighbors).toEqual([
      {
        protocols: ['lldp'],
        localIfIndex: 102,
        localPort: 'gi2',
        chassisMac: 'aa:00:00:00:00:02',
        chassisId: 'aa:00:00:00:00:02',
        remotePort: 'eth0',
        sysName: 'lobby-ap',
        sysDescr: 'Wireless access point',
        mgmtIp: '10.9.0.2',
      },
    ]);
  });

  it('reads which ports are bundled into one link, and leaves subinterfaces alone', () => {
    const w = walks();
    const [one, two, three, bundle] = [101, 102, 103, 50];
    const stack = (higher: number, lower: number) => vb(`${OID.ifStackStatus}.${higher}.${lower}`, 1);
    w.ifName.push(vb(`${OID.ifName}.${bundle}`, 'Po1'), vb(`${OID.ifName}.60`, 'Gi0/3.10'), vb(`${OID.ifName}.61`, 'Gi0/3.20'), vb(`${OID.ifName}.70`, 'Po2'));
    // Po1 over ports 1 and 2; two subinterfaces over port 3; Po2 over port 3 alone; every one over or under nothing.
    w.ifStack = [stack(0, bundle), stack(bundle, one), stack(bundle, two), stack(one, 0), stack(two, 0), stack(60, three), stack(61, three), stack(70, three), stack(three, 0)];
    const d = parseGear('192.0.2.2', w);
    const memberOf = (ifIndex: number) => d.interfaces.find((i) => i.ifIndex === ifIndex)?.memberOf;
    expect([memberOf(one), memberOf(two), memberOf(three), memberOf(bundle)]).toEqual([bundle, bundle, undefined, undefined]);
    expect(parseGear('192.0.2.2', walks()).interfaces.every((i) => i.memberOf === undefined)).toBe(true);
  });

  it('uses the port description when a neighbour names its port by MAC address', () => {
    const w = walks();
    w.lldpRem = w.lldpRem.map((v) =>
      v.oid.startsWith(`${OID.lldpRem}.6.`) ? vb(v.oid, 3) : v.oid.startsWith(`${OID.lldpRem}.7.`) ? vb(v.oid, Buffer.from(mac('aa:00:00:00:00:02'))) : v,
    );
    w.lldpRem.push(vb(`${OID.lldpRem}.8.0.102.1`, Buffer.from('bond0')));
    expect(parseGear('10.9.0.250', w).neighbors[0]?.remotePort).toBe('bond0');
  });

  it('reads MAC-table ports given by position when bridge ports use other numbers', () => {
    // Bridge ports 49153… map to the same interfaces; the MAC table says "port 2" for the second one,
    // and interface 1 is a VLAN interface that must not be taken for it.
    const w = walks();
    const ifs = [
      [1, 'Vlan-interface1'],
      [49153, 'gigabitEthernet 1/0/1'],
      [49154, 'gigabitEthernet 1/0/2'],
    ] as const;
    w.ifName = ifs.map(([i, n]) => vb(`${OID.ifName}.${i}`, Buffer.from(n)));
    w.ifDescr = [];
    w.basePortIfIndex = [49153, 49154].map((p) => vb(`${OID.basePortIfIndex}.${p}`, p));
    w.qFdbPort = [vb(`${OID.qFdbPort}.1.${mac('aa:00:00:00:00:01').join('.')}`, 1), vb(`${OID.qFdbPort}.1.${mac('aa:00:00:00:00:02').join('.')}`, 2)];
    w.qFdbStatus = [];
    const d = parseGear('10.9.0.250', w);
    expect(d.fdb.map((f) => d.interfaces.find((i) => i.ifIndex === f.ifIndex)?.name)).toEqual(['gigabitEthernet 1/0/1', 'gigabitEthernet 1/0/2']);
  });

  it('shortens long interface names', () => {
    expect(shortPort('gigabitEthernet 1/0/43')).toBe('Gi1/0/43');
    expect(shortPort('TenGigabitEthernet1/1/2')).toBe('Te1/1/2');
    expect(shortPort('Port-channel3')).toBe('Po3');
    expect(shortPort('gigabitEthernet 1/0/2–gigabitEthernet 1/0/3')).toBe('Gi1/0/2–Gi1/0/3');
    expect(shortPort('gi16')).toBe('gi16');
    expect(shortPort('Ethernet 3')).toBe('Eth3');
  });

  it('reads LLDP tables indexed without the time mark', () => {
    const w = walks();
    w.lldpRem = w.lldpRem.map((v) => vb(v.oid.replace(/\.0\.102\.1$/, '.102.1'), v.value));
    w.lldpRemManAddr = [vb(`${OID.lldpRemManAddr}.102.1.1.4.10.9.0.2`, 2)];
    const n = parseGear('10.9.0.250', w).neighbors[0];
    expect(n).toMatchObject({ localPort: 'gi2', sysName: 'lobby-ap', mgmtIp: '10.9.0.2', remotePort: 'eth0' });
  });

  it('reads a neighbour whose table names no local port and gives its address as text', () => {
    const w = walks();
    // Local port number 0, and the chassis address written out instead of given as six bytes.
    w.lldpRem = w.lldpRem.map((v) => {
      const oid = v.oid.replace(/\.0\.102\.1$/, '.0.0.1');
      return vb(oid, oid.startsWith(`${OID.lldpRem}.5.`) ? Buffer.from('AA:00:00:00:00:02') : v.value);
    });
    w.lldpRemManAddr = [];
    const n = parseGear('10.9.0.250', w).neighbors[0];
    // The port is the one where the switch learned that address.
    expect(n).toMatchObject({ chassisMac: 'aa:00:00:00:00:02', localIfIndex: 102, localPort: 'gi2', sysName: 'lobby-ap' });
  });

  it('decodes values the way SNMP libraries return them', () => {
    expect(num(Buffer.from([0x01, 0x00]))).toBe(256);
    expect(num(5n)).toBe(5);
    expect(text(Buffer.from([0xaa, 0x01, 0x02]))).toBeUndefined();
    expect(macOf('5C 15 C5 C0 13 A3 ')).toBe('5c:15:c5:c0:13:a3');
    expect(rate(1000, 2000, 2)).toBe(4000);
    // A counter that went backwards was reset, not a burst of traffic.
    expect(rate(5_000_000, 1_000, 1)).toBe(0);
  });
});

describe('traffic between counter readings', () => {
  const reading = (at: number, ...ports: [number, number, number][]) => ({ at, values: new Map(ports.map(([i, inO, outO]) => [i, { in: inO, out: outO }])) });

  it('has no rates on the first reading', () => {
    expect(advanceTraffic(undefined, reading(0, [1, 100, 100])).rates.size).toBe(0);
  });

  it('turns two readings into bits per second per port', () => {
    const first = advanceTraffic(undefined, reading(0, [1, 1000, 0], [2, 0, 0]));
    const next = advanceTraffic(first, reading(2000, [1, 2000, 500], [2, 0, 0]));
    expect(next.rates.get(1)).toEqual({ inBps: 4000, outBps: 2000 });
    expect(next.rates.get(2)).toEqual({ inBps: 0, outBps: 0 });
  });

  it('keeps the last rates while the device answers with counters it has not refreshed yet', () => {
    // Switches that refresh counters every few seconds answer twice with the same values.
    const first = advanceTraffic(undefined, reading(0, [1, 1000, 1000]));
    const busy = advanceTraffic(first, reading(5000, [1, 6000, 6000]));
    const cached = advanceTraffic(busy, reading(10_000, [1, 6000, 6000]));
    expect(cached.rates.get(1)).toEqual({ inBps: 8000, outBps: 8000 });
    // The next refresh is measured from the last reading that changed, over the whole span.
    const refreshed = advanceTraffic(cached, reading(12_000, [1, 13_000, 6000]));
    expect(refreshed.rates.get(1)).toEqual({ inBps: 8000, outBps: 0 });
  });

  it('keeps the last rate of a port whose counters were not refreshed while other ports were', () => {
    // Switches refresh each port's counters on their own schedule.
    const first = advanceTraffic(undefined, reading(0, [1, 0, 0], [2, 0, 0]));
    const both = advanceTraffic(first, reading(5000, [1, 5000, 0], [2, 5000, 0]));
    const one = advanceTraffic(both, reading(10_000, [1, 10_000, 0], [2, 5000, 0]));
    expect(one.rates.get(1)).toEqual({ inBps: 8000, outBps: 0 });
    expect(one.rates.get(2)).toEqual({ inBps: 8000, outBps: 0 });
    const caught = advanceTraffic(one, reading(15_000, [1, 15_000, 0], [2, 15_000, 0]));
    expect(caught.rates.get(2)).toEqual({ inBps: 8000, outBps: 0 });
  });

  it('reads unchanged counters as idle once they stay the same for too long', () => {
    const first = advanceTraffic(undefined, reading(0, [1, 0, 0]));
    const busy = advanceTraffic(first, reading(5000, [1, 5000, 0]));
    const idle = advanceTraffic(busy, reading(40_000, [1, 5000, 0]));
    expect(idle.rates.get(1)).toEqual({ inBps: 0, outBps: 0 });
  });

  it('shows no traffic for a device that missed a sample, and measures the next answer from its last reading', () => {
    const first = advanceTraffic(undefined, reading(0, [1, 0, 0]));
    const busy = advanceTraffic(first, reading(5000, [1, 5000, 0]));
    const missed = missedTraffic(busy);
    expect(missed?.rates.size).toBe(0);
    const back = advanceTraffic(missed, reading(10_000, [1, 15_000, 0]));
    expect(back.rates.get(1)).toEqual({ inBps: 16_000, outBps: 0 });
    expect(missedTraffic(undefined)).toBeUndefined();
  });
});

let seq = 0;
const asset = (ip: string, type: DeviceType, macAddr?: string): Asset => ({
  id: `d${++seq}`,
  networkId: 'n',
  firstSeen: '2026-01-01T00:00:00Z',
  lastSeen: '2026-01-01T00:00:00Z',
  lastRunId: 'r',
  isNew: false,
  ip,
  mac: macAddr,
  names: [],
  aliveVia: ['arp'],
  ports: [],
  type,
  typeConfidence: 0.9,
  evidence: [],
  risks: [],
});

describe('map from switch data', () => {
  const router = asset('10.9.0.1', 'router', 'aa:00:00:00:00:01');
  const sw = asset('10.9.0.250', 'switch', 'aa:00:00:00:00:99');
  const ap = asset('10.9.0.2', 'unknown', 'aa:00:00:00:00:02');
  const phone = asset('10.9.0.21', 'phone', 'aa:00:00:00:00:21');
  const pc = asset('10.9.0.3', 'computer', 'aa:00:00:00:00:03');
  const tv1 = asset('10.9.0.41', 'tv', 'aa:00:00:00:00:41');
  const tv2 = asset('10.9.0.42', 'tv', 'aa:00:00:00:00:42');
  const stray = asset('10.9.0.77', 'laptop', 'aa:00:00:00:00:77');
  const all = [router, sw, ap, phone, pc, tv1, tv2, stray];
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 8, devices: [parseGear('10.9.0.250', walks())] };
  const topo = buildTopology({ gatewayIp: '10.9.0.1', gatewayMac: 'aa:00:00:00:00:01' }, all, { clients: true, collapsed: new Set() }, snapshot);
  const edge = (source: string, target: string) => topo.edges.find((e) => e.source === source && e.target === target);
  const parentOf = (id: string) => topo.nodes.find((n) => n.id === id)?.parent;

  it('hangs the switch from the gateway on the port where it learned the gateway', () => {
    expect(topo.confirmed).toBe(true);
    expect(edge(router.id, sw.id)).toMatchObject({ inferred: false, targetPort: 'gi1' });
    expect(topo.nodes.find((n) => n.id === sw.id)).toMatchObject({ managed: true, label: 'core-sw' });
  });

  it('carries VLANs on links, devices and the topology', () => {
    expect(topo.vlans).toEqual([{ id: 1, name: undefined }, { id: 69, name: 'ISOLATED' }]);
    // The access point's port is a trunk: VLAN 1 untagged, VLAN 69 tagged.
    expect(edge(sw.id, ap.id)?.vlan).toEqual({ pvid: 1, tagged: [69] });
    expect(topo.nodes.find((n) => n.id === pc.id)?.vlan).toBe(1);
  });

  it('draws the LLDP neighbour on its port with PoE, and its clients behind it', () => {
    expect(edge(sw.id, ap.id)).toMatchObject({ inferred: false, sourcePort: 'gi2', targetPort: 'eth0', poe: true, poeWatts: 6.2 });
    expect(topo.nodes.find((n) => n.id === ap.id)?.deviceType).toBe('ap');
    expect(parentOf(phone.id)).toBe(groupId('phones', ap.id));
  });

  it('marks devices behind an access point as wireless, and no others', () => {
    expect(topo.nodes.find((n) => n.id === phone.id)?.wireless).toBe(true);
    expect(topo.nodes.find((n) => n.id === pc.id)?.wireless).toBeUndefined();
    expect(topo.nodes.find((n) => n.id === tv1.id)?.wireless).toBeUndefined();
    expect(topo.nodes.find((n) => n.id === stray.id)?.wireless).toBeUndefined();
  });

  it('lists the switch ports of a group\'s devices on the cable to it', () => {
    expect(edge(sw.id, groupId('computers', sw.id))?.sourcePort).toBe('gi3');
    expect(summarizePorts(['gi15', 'gi13', 'gi14', 'gi23', 'gi2'])).toBe('gi2, gi13–gi15, gi23');
    expect(summarizePorts(['p1', 'p3', 'p5', 'p7', 'p9', 'p11'])).toBe('p1, p3, p5, p7 +2');
  });

  it('places a lone device on its port and several devices behind an unmanaged segment', () => {
    expect(parentOf(pc.id)).toBe(groupId('computers', sw.id));
    expect(topo.nodes.find((n) => n.id === pc.id)?.port).toBe('gi3');
    const segment = 'segment:10.9.0.250:104';
    expect(edge(sw.id, segment)).toMatchObject({ sourcePort: 'gi4', inferred: false });
    expect(parentOf(tv1.id)).toBe(groupId('media', segment));
    expect(parentOf(tv2.id)).toBe(groupId('media', segment));
  });

  it('draws a virtualization host on its port, with its virtual machines grouped under it', () => {
    const host = asset('10.9.0.200', 'unknown', 'a8:a1:59:00:00:01');
    const vms = ['bc:24:11:00:00:35', 'bc:24:11:00:00:36', 'bc:24:11:00:00:37'].map((m, i) => ({ ...asset(`10.9.0.${35 + i}`, 'unknown', m), vendor: 'Proxmox Server Solutions GmbH' }));
    const d = parseGear('10.9.0.250', walks());
    d.fdb = [
      ...d.fdb.filter((f) => f.ifIndex !== 104),
      { mac: 'a8:a1:59:00:00:01', ifIndex: 104, vendor: 'ASRock Incorporation' },
      ...vms.map((v) => ({ mac: v.mac as string, ifIndex: 104, vendor: 'Proxmox Server Solutions GmbH' })),
    ];
    const t = buildTopology({ gatewayIp: '10.9.0.1', gatewayMac: 'aa:00:00:00:00:01' }, [router, sw, ap, host, ...vms], { clients: true, collapsed: new Set() }, { ...snapshot, devices: [d] });
    expect(t.nodes.some((n) => n.id.startsWith('segment:'))).toBe(false);
    expect(t.edges.find((e) => e.source === sw.id && e.target === host.id)).toMatchObject({ sourcePort: 'gi4', inferred: false });
    const group = t.nodes.find((n) => n.id === groupId('computers', host.id));
    expect(group).toMatchObject({ title: 'Virtual machines', count: 3 });
    for (const v of vms) expect(t.nodes.find((n) => n.id === v.id)?.parent).toBe(groupId('computers', host.id));
  });

  it('keeps several physical devices on one port as an unmanaged segment', () => {
    expect(topo.nodes.some((n) => n.id === 'segment:10.9.0.250:104')).toBe(true);
  });

  it('keeps devices no switch has seen with the gateway, as assumed links', () => {
    expect(parentOf(stray.id)).toBe(groupId('computers'));
    expect(edge(router.id, groupId('computers'))?.inferred).toBe(true);
  });
});

describe('map from switch data without inventory MAC addresses', () => {
  // When the OS hides MAC addresses, the inventory has none: the switch's own ARP table and the
  // addresses it learned still place the gateway link and the devices behind each port.
  const bare = (ip: string, type: DeviceType) => asset(ip, type);
  const router = bare('10.9.0.1', 'router');
  const sw = bare('10.9.0.250', 'switch');
  const ap = bare('10.9.0.2', 'unknown');
  const device = parseGear('10.9.0.250', walks());
  device.fdb.push({ mac: '02:11:22:33:44:55', ifIndex: 102, vlan: 1 }, { mac: 'aa:00:00:00:00:66', ifIndex: 102, vlan: 1, vendor: 'Acme Phones' });
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 3, devices: [device] };
  const topo = buildTopology({ gatewayIp: '10.9.0.1' }, [router, sw, ap], { clients: true, collapsed: new Set() }, snapshot);
  const node = (id: string) => topo.nodes.find((n) => n.id === id);

  it('finds the gateway port from the switch ARP table', () => {
    expect(topo.edges.find((e) => e.source === router.id && e.target === sw.id)).toMatchObject({ inferred: false, targetPort: 'gi1' });
  });

  it('draws learned addresses behind the access point, named by vendor or as private', () => {
    expect(node('mac:aa:00:00:00:00:66')).toMatchObject({ label: 'Acme Phones', parent: groupId('other', ap.id) });
    expect(node('mac:02:11:22:33:44:55')).toMatchObject({ label: 'Private address', detail: '02:11:22:33:44:55' });
    // Network gear itself (the gateway and the access point) is not listed as an end device.
    expect(node('mac:aa:00:00:00:00:01')).toBeUndefined();
    expect(node('mac:aa:00:00:00:00:02')).toBeUndefined();
  });
});

describe('map when the gateway itself answers SNMP', () => {
  // Gateway (router) → core switch gi25; core switch gi27 ↔ access switch port48 (LLDP both ways).
  const iface = (ifIndex: number, name: string) => ({ ifIndex, name, up: true, speedMbps: 1000 });
  const gw = asset('10.8.0.1', 'router', 'bb:00:00:00:00:01');
  const core = asset('10.8.0.2', 'switch', 'bb:00:00:00:00:02');
  const access = asset('10.8.1.184', 'switch', 'bb:00:00:00:00:03');
  const pc = asset('10.8.0.50', 'computer', 'bb:00:00:00:00:50');
  const devices = [
    {
      ip: '10.8.0.1',
      sysName: 'edge-fw',
      interfaces: [iface(1, 'wan0'), iface(2, 'lan0')],
      neighbors: [{ localIfIndex: 2, localPort: 'lan0', chassisMac: 'bb:00:00:00:00:02', remotePort: 'gi25', mgmtIp: '10.8.0.2', sysName: 'core' }],
      fdb: [],
      arp: [],
    },
    {
      ip: '10.8.0.2',
      sysName: 'core',
      mac: 'bb:00:00:00:00:02',
      interfaces: [iface(25, 'gi25'), iface(27, 'gi27'), iface(5, 'gi5')],
      neighbors: [
        { localIfIndex: 25, localPort: 'gi25', mgmtIp: '10.8.0.1', sysName: 'edge-fw', remotePort: 'lan0' },
        { localIfIndex: 27, localPort: 'gi27', mgmtIp: '10.8.1.184', sysName: 'access', remotePort: 'port48' },
      ],
      fdb: [
        { mac: 'bb:00:00:00:00:01', ifIndex: 25 },
        { mac: 'bb:00:00:00:00:03', ifIndex: 27 },
        { mac: 'bb:00:00:00:00:50', ifIndex: 5 },
      ],
      arp: [],
    },
    {
      ip: '10.8.1.184',
      sysName: 'access',
      mac: 'bb:00:00:00:00:03',
      interfaces: [iface(48, 'port48')],
      neighbors: [{ localIfIndex: 48, localPort: 'port48', mgmtIp: '10.8.0.2', sysName: 'core', remotePort: 'gi27' }],
      fdb: [
        { mac: 'bb:00:00:00:00:01', ifIndex: 48 },
        { mac: 'bb:00:00:00:00:02', ifIndex: 48 },
      ],
      arp: [],
    },
  ];
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 4, devices };
  const topo = buildTopology({ gatewayIp: '10.8.0.1', gatewayMac: 'bb:00:00:00:00:01' }, [gw, core, access, pc], { clients: true, collapsed: new Set() }, snapshot);
  const links = (a: string, b: string) => topo.edges.filter((e) => (e.source === a && e.target === b) || (e.source === b && e.target === a));

  it('keeps the gateway as one node, marked as read over SNMP', () => {
    expect(topo.nodes.filter((n) => n.ip === '10.8.0.1' || n.assetId === gw.id)).toHaveLength(1);
    expect(topo.nodes.find((n) => n.id === gw.id)?.managed).toBe(true);
  });

  it('hangs the chain from the gateway with the ports at both ends', () => {
    expect(links(gw.id, core.id)).toEqual([expect.objectContaining({ source: gw.id, target: core.id, sourcePort: 'lan0', targetPort: 'gi25', inferred: false })]);
    expect(links(core.id, access.id)).toEqual([expect.objectContaining({ source: core.id, target: access.id, sourcePort: 'gi27', targetPort: 'port48' })]);
    expect(topo.nodes.find((n) => n.id === pc.id)?.parent).toBe(groupId('computers', core.id));
  });

  it('lists where each device is connected, with the path to the gateway', () => {
    const name = (n: { id: string; label?: string; ip?: string }) => [gw, core, access, pc].find((x) => x.id === n.id)?.hostname ?? n.label ?? n.ip ?? n.id;
    const rows = connectionRows(topo, (n) => ({ name: name(n), ip: [gw, core, access, pc].find((x) => x.id === n.id)?.ip }));
    const row = (id: string) => rows.find((r) => r.id === id);
    expect(row(pc.id)).toMatchObject({ connectedTo: { name: 'core' }, switch: { name: 'core', ip: '10.8.0.2' }, switchPort: 'gi5', path: 'core gi5 › edge-fw lan0', confirmed: true });
    expect(row(access.id)).toMatchObject({ connectedTo: { name: 'core' }, switchPort: 'gi27', path: 'core gi27 › edge-fw lan0' });
    expect(connectionCells(row(pc.id)!)).toEqual(expect.arrayContaining(['10.8.0.50', 'core', 'gi5', 'Switch data']));
    expect(row(gw.id)).toBeUndefined();
    // A link no switch has seen leaves the connection columns blank instead of guessing.
    const cells = connectionCells({ ...row(pc.id)!, confirmed: false });
    expect(cells.slice(5, 10)).toEqual(['', '', '', '', '']);
    expect(cells.at(-1)).toBe('Not known (no switch data)');
  });
});

describe('map with a router that has several interfaces', () => {
  // Router: wan0 (public), lan0 (this network), opt1 (an isolated network). One switch hangs off
  // lan0 without LLDP; the router's side is known only from the router's own addresses.
  const iface = (ifIndex: number, name: string) => ({ ifIndex, name, up: true, speedMbps: 1000 });
  const gw = asset('10.7.0.1', 'router', 'cc:00:00:00:00:01');
  const sw = asset('10.7.0.2', 'switch', 'cc:00:00:00:00:02');
  const devices = [
    {
      ip: '10.7.0.1',
      sysName: 'edge',
      interfaces: [iface(1, 'wan0'), iface(2, 'lan0'), iface(3, 'opt1'), iface(9, 'lo0')],
      neighbors: [],
      fdb: [],
      arp: [],
      addresses: [
        { ip: '203.0.113.5', prefix: 30, ifIndex: 1 },
        { ip: '10.7.0.1', prefix: 24, ifIndex: 2 },
        { ip: '10.7.20.1', prefix: 24, ifIndex: 3 },
        { ip: '127.0.0.1', prefix: 8, ifIndex: 9 },
      ],
    },
    {
      ip: '10.7.0.2',
      sysName: 'office-sw',
      mac: 'cc:00:00:00:00:02',
      interfaces: [iface(10, 'port10')],
      neighbors: [],
      fdb: [{ mac: 'cc:00:00:00:00:01', ifIndex: 10 }],
      arp: [],
    },
  ];
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 2, devices };
  const topo = buildTopology({ gatewayIp: '10.7.0.1', gatewayMac: 'cc:00:00:00:00:01' }, [gw, sw], { clients: true, collapsed: new Set() }, snapshot);
  const edge = (source: string, target: string) => topo.edges.find((e) => e.source === source && e.target === target);

  it('shows the internet side on the public interface, with its traffic', () => {
    expect(edge('internet', gw.id)).toMatchObject({ inferred: false, targetPort: 'wan0', traffic: { ip: '10.7.0.1', ifIndex: 1 } });
  });

  it('names the router port that serves this network on its cables', () => {
    expect(edge(gw.id, sw.id)).toMatchObject({ sourcePort: 'lan0', targetPort: 'port10', inferred: false });
  });

  it('draws other networks on their own interfaces, but not loopback', () => {
    expect(topo.nodes.find((n) => n.id === 'net:10.7.20.0/24')).toMatchObject({ network: '10.7.20.0/24', label: '10.7.20.0/24' });
    expect(edge(gw.id, 'net:10.7.20.0/24')).toMatchObject({ sourcePort: 'opt1', traffic: { ip: '10.7.0.1', ifIndex: 3 } });
    expect(topo.nodes.some((n) => n.id.startsWith('net:127.'))).toBe(false);
  });

  it('puts VLAN subinterfaces on the cable of their physical port instead of drawing them apart', () => {
    const r = { ...devices[0]!, interfaces: [...devices[0]!.interfaces, iface(4, 'lan0.10'), iface(5, 'lan0.20'), iface(6, 'opt1.30')] };
    r.addresses = [...devices[0]!.addresses!, { ip: '10.7.10.1', prefix: 24, ifIndex: 4 }, { ip: '10.7.20.1', prefix: 24, ifIndex: 5 }, { ip: '10.7.30.1', prefix: 24, ifIndex: 6 }];
    r.addresses = r.addresses.filter((a) => a.ifIndex !== 3);
    const t = buildTopology({ gatewayIp: '10.7.0.1', gatewayMac: 'cc:00:00:00:00:01' }, [gw, sw], { clients: true, collapsed: new Set() }, { ...snapshot, devices: [r, devices[1]!] });
    const routes = [
      { vlan: 10, network: '10.7.10.0/24', ip: '10.7.10.1', port: 'lan0.10' },
      { vlan: 20, network: '10.7.20.0/24', ip: '10.7.20.1', port: 'lan0.20' },
    ];
    expect(t.nodes.some((n) => n.id === 'net:10.7.10.0/24' || n.id === 'net:10.7.20.0/24')).toBe(false);
    expect(t.edges.find((e) => e.source === gw.id && e.target === sw.id)).toMatchObject({ sourcePort: 'lan0', routes });
    expect(t.nodes.find((n) => n.id === gw.id)?.routes).toEqual(routes);
    // A subinterface on a port with no cable seen stays a network of its own.
    expect(t.nodes.some((n) => n.id === 'net:10.7.30.0/24')).toBe(true);
  });

  it('puts the network of a port where a neighbour is heard on that cable, not apart', () => {
    const heard = { localIfIndex: 3, localPort: 'opt1', sysName: 'lab-sw', chassisId: 'lab-sw', mgmtIp: '10.7.20.9', protocols: ['cdp' as const] };
    const t = buildTopology({ gatewayIp: '10.7.0.1', gatewayMac: 'cc:00:00:00:00:01' }, [gw, sw], { clients: true, collapsed: new Set() }, { ...snapshot, devices: [{ ...devices[0]!, neighbors: [heard] }, devices[1]!] });
    expect(t.nodes.some((n) => n.id === 'net:10.7.20.0/24')).toBe(false);
    expect(t.edges.find((e) => e.source === gw.id && e.sourcePort === 'opt1')?.routes).toEqual([{ vlan: undefined, network: '10.7.20.0/24', ip: '10.7.20.1', port: 'opt1' }]);
  });
});

describe('map of a remote network read over SNMP', () => {
  // Shape of a real office: firewall (forwards, default route via a modem on its "wan" port, an
  // unused port holding 0.0.0.0, a VPN tunnel), a core switch and an access switch whose neighbour
  // on port 2 announces only its port MAC. The scan was remote: no MACs, gateway unknown.
  const iface = (ifIndex: number, name: string, up = true) => ({ ifIndex, name, up, speedMbps: 1000 });
  const fw = asset('10.6.0.1', 'server');
  const core = asset('10.6.0.2', 'switch');
  const acc = asset('10.6.1.184', 'switch');
  const laptop = asset('10.6.1.164', 'laptop');
  const devices = [
    {
      ip: '10.6.0.1',
      sysName: 'fw',
      forwarding: true,
      defaultRoute: { nextHop: '10.20.0.1', ifIndex: 8 },
      interfaces: [iface(1, 'unused0', false), iface(2, 'lan0'), iface(8, 'wan1'), iface(13, 'tun_wg0')],
      addresses: [
        { ip: '0.0.0.0', prefix: 0, ifIndex: 1 },
        { ip: '10.6.0.1', prefix: 23, ifIndex: 2 },
        { ip: '10.20.0.82', prefix: 24, ifIndex: 8 },
        { ip: '10.0.8.1', prefix: 24, ifIndex: 13 },
      ],
      neighbors: [],
      fdb: [],
      arp: [{ ip: '10.6.1.164', mac: 'dd:00:00:00:01:64' }],
    },
    {
      ip: '10.6.0.2',
      sysName: 'core',
      forwarding: false,
      defaultRoute: { nextHop: '10.6.0.1' },
      interfaces: [iface(25, 'gi25'), iface(26, 'gi26')],
      neighbors: [
        { localIfIndex: 25, localPort: 'gi25', mgmtIp: '10.6.0.1', sysName: 'fw', remotePort: 'lan0' },
        { localIfIndex: 26, localPort: 'gi26', mgmtIp: '10.6.1.184', sysName: 'access', remotePort: 'Port 48' },
      ],
      fdb: [],
      arp: [],
    },
    {
      ip: '10.6.1.184',
      sysName: 'access',
      forwarding: false,
      defaultRoute: { nextHop: '10.6.0.1', ifIndex: 3 },
      interfaces: [iface(2, 'Port 2'), iface(48, 'Port 48')],
      neighbors: [{ localIfIndex: 2, localPort: 'Port 2', portMac: 'dd:00:00:00:01:64' }],
      fdb: [{ mac: 'dd:00:00:00:01:64', ifIndex: 2 }],
      arp: [],
    },
  ];
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 4, devices };
  const topo = buildTopology({}, [fw, core, acc, laptop], { clients: true, collapsed: new Set() }, snapshot);
  const edge = (source: string, target: string) => topo.edges.find((e) => e.source === source && e.target === target);

  it('finds the gateway from the switches default routes', () => {
    expect(gatewayFromGear(devices)).toBe('10.6.0.1');
    expect(topo.nodes.find((n) => n.id === fw.id)).toMatchObject({ kind: 'gateway', managed: true });
    expect(edge(fw.id, core.id)).toMatchObject({ sourcePort: 'lan0', targetPort: 'gi25' });
    expect(edge(core.id, acc.id)).toMatchObject({ sourcePort: 'gi26', targetPort: 'Port 48' });
  });

  it('puts the internet side on the default route, not on an unused port', () => {
    expect(edge('internet', fw.id)).toMatchObject({ targetPort: 'wan1', inferred: false });
    // The modem's network is the internet side, not a separate network; the tunnel is one.
    expect(topo.nodes.some((n) => n.network === '10.20.0.0/24')).toBe(false);
    expect(topo.nodes.find((n) => n.network === '10.0.8.0/24')?.detail).toMatch(/^VPN tunnel on tun_wg0/);
  });

  it('names an anonymous neighbour by the only address learned on its port', () => {
    const quiet = {
      ...devices[2]!,
      neighbors: [{ localIfIndex: 2, localPort: 'Port 2' }],
      fdb: [{ mac: 'dd:00:00:00:01:64', ifIndex: 2, vendor: 'Acme Access Points' }],
    };
    const t2 = buildTopology({}, [fw, core, acc, laptop], { clients: true, collapsed: new Set() }, { ...snapshot, devices: [devices[0]!, devices[1]!, quiet] });
    expect(t2.edges.find((e) => e.source === acc.id && e.target === laptop.id)).toMatchObject({ sourcePort: 'Port 2' });
  });

  it('knows a neighbour that only announces its port MAC, through the router ARP table', () => {
    expect(edge(acc.id, laptop.id)).toMatchObject({ sourcePort: 'Port 2', inferred: false });
    expect(topo.nodes.some((n) => n.label === 'Gateway')).toBe(false);
  });
});


describe('gateway from managed devices that route', () => {
  const dev = (ip: string, nextHop: string | undefined, forwarding: boolean) => ({
    ip,
    sysName: ip,
    forwarding,
    defaultRoute: nextHop ? { nextHop } : undefined,
    interfaces: [],
    neighbors: [],
    fdb: [],
    arp: [],
  });

  it('counts the default routes of layer 3 switches too, whatever order the devices answered in', () => {
    // Three switches with IP routing on point at R1 (.1); R1 points at the internet router.
    const routed = [dev('192.168.100.2', '192.168.100.1', true), dev('192.168.100.3', '192.168.100.1', true), dev('192.168.100.4', '192.168.100.1', true), dev('192.168.100.1', '10.0.0.1', true)];
    expect(gatewayFromGear(routed)).toBe('192.168.100.1');
    expect(gatewayFromGear([...routed].reverse())).toBe('192.168.100.1');
  });

  it("prefers a next hop that is one of the managed devices over the gateway's own upstream", () => {
    expect(gatewayFromGear([dev('10.6.0.1', '203.0.113.1', true), dev('10.6.0.2', '10.6.0.1', true)])).toBe('10.6.0.1');
    expect(gatewayFromGear([dev('10.6.0.2', '10.6.0.1', true), dev('10.6.0.1', '203.0.113.1', true)])).toBe('10.6.0.1');
  });

  it("ignores a router's upstream outside the scanned network: the router itself is the gateway", () => {
    // A firewall routes to its internet provider; the layer 2 switch has no default route.
    const field = [dev('172.31.154.225', undefined, false), dev('172.31.154.1', '203.0.113.129', true)];
    expect(gatewayFromGear(field, '172.31.154.0/23')).toBe('172.31.154.1');
    // Several networks listed for one map; a layer 3 switch pointing at an unmanaged firewall inside them still counts.
    expect(gatewayFromGear([dev('172.20.99.2', '172.20.99.1', true), dev('172.20.10.1', '10.0.0.1', true)], '172.20.10.0/24, 172.20.99.0/24')).toBe('172.20.99.1');
  });

  it('ignores a device pointing its default route at itself', () => {
    expect(gatewayFromGear([dev('10.6.0.1', '10.6.0.1', true), dev('10.6.0.2', '10.6.0.9', false)])).toBe('10.6.0.9');
  });

  it('falls back to the lowest-addressed routing device when none has a default route', () => {
    expect(gatewayFromGear([dev('10.6.0.9', undefined, true), dev('10.6.0.3', undefined, true), dev('10.6.0.5', undefined, false)])).toBe('10.6.0.3');
  });
});

describe("a switch's own port addresses", () => {
  it('reads the MAC address of each interface', () => {
    const w = { ...walks(), ifPhysAddress: [vb(`${OID.ifPhysAddress}.101`, Buffer.from(mac('aa:bb:cc:00:01:10'))), vb(`${OID.ifPhysAddress}.102`, Buffer.from([]))] };
    const d = parseGear('10.9.0.250', w);
    expect(d.interfaces.find((i) => i.ifIndex === 101)?.mac).toBe('aa:bb:cc:00:01:10');
    expect(d.interfaces.find((i) => i.ifIndex === 102)?.mac).toBeUndefined();
  });

  it('ignores all-zero, broadcast and multicast port addresses', () => {
    const w = {
      ...walks(),
      ifPhysAddress: [
        vb(`${OID.ifPhysAddress}.101`, Buffer.from(mac('00:00:00:00:00:00'))),
        vb(`${OID.ifPhysAddress}.102`, Buffer.from(mac('ff:ff:ff:ff:ff:ff'))),
        vb(`${OID.ifPhysAddress}.103`, Buffer.from(mac('01:80:c2:00:00:0e'))),
      ],
    };
    expect(parseGear('10.9.0.250', w).interfaces.some((i) => i.mac)).toBe(false);
  });

  it('does not draw a port address of a managed switch, learned back through a loop, as an unknown device', () => {
    const sw = {
      ip: '192.168.100.2',
      sysName: 'SW1',
      mac: 'cc:cc:00:00:00:02',
      interfaces: [
        { ifIndex: 3, name: 'Et0/2', up: true, mac: 'aa:bb:cc:00:01:20' },
        { ifIndex: 4, name: 'Et0/3', up: true, mac: 'aa:bb:cc:00:01:30' },
      ],
      neighbors: [],
      fdb: [{ mac: 'aa:bb:cc:00:01:30', ifIndex: 3 }],
      arp: [],
    };
    const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-11-07T00:00:00Z', probed: 1, devices: [sw] };
    const topo = buildTopology({}, [asset('192.168.100.2', 'switch')], { clients: true, collapsed: new Set() }, snapshot);
    expect(topo.nodes.find((n) => n.id === 'mac:aa:bb:cc:00:01:30')).toBeUndefined();
  });
});

describe('redundant links between switches', () => {
  // A ring: R1 (gateway) above SW1; SW1, SW2 and SW3 joined in a ring.
  const r1 = asset('192.168.100.1', 'router');
  const sw1 = asset('192.168.100.2', 'switch');
  const sw2 = asset('192.168.100.3', 'switch');
  const sw3 = asset('192.168.100.4', 'switch');
  const port = (ifIndex: number, name: string) => ({ ifIndex, name, up: true });
  const nb = (localIfIndex: number, localPort: string, mgmtIp: string, sysName: string, remotePort: string) => ({ localIfIndex, localPort, mgmtIp, sysName, remotePort });
  const gear = (ip: string, sysName: string, interfaces: ReturnType<typeof port>[], neighbors: ReturnType<typeof nb>[]) => ({
    ip,
    sysName,
    forwarding: true,
    defaultRoute: { nextHop: '192.168.100.1' },
    interfaces,
    neighbors,
    fdb: [],
    arp: [],
  });
  const devices = [
    gear('192.168.100.2', 'SW1', [port(1, 'Et0/0'), port(2, 'Et0/1'), port(5, 'Et1/0')], [nb(1, 'Et0/0', '192.168.100.1', 'R1', 'Et0/0'), nb(2, 'Et0/1', '192.168.100.3', 'SW2', 'Et0/0'), nb(5, 'Et1/0', '192.168.100.4', 'SW3', 'Et0/1')]),
    gear('192.168.100.3', 'SW2', [port(1, 'Et0/0'), port(2, 'Et0/1')], [nb(1, 'Et0/0', '192.168.100.2', 'SW1', 'Et0/1'), nb(2, 'Et0/1', '192.168.100.4', 'SW3', 'Et0/0')]),
    gear('192.168.100.4', 'SW3', [port(1, 'Et0/0'), port(2, 'Et0/1')], [nb(1, 'Et0/0', '192.168.100.3', 'SW2', 'Et0/1'), nb(2, 'Et0/1', '192.168.100.2', 'SW1', 'Et1/0')]),
  ];
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-11-07T00:00:00Z', probed: 4, devices };
  const topo = buildTopology({}, [r1, sw1, sw2, sw3], { clients: true, collapsed: new Set() }, snapshot);
  const has = (list: { source: string; target: string }[], x: string, y: string) => list.some((e) => (e.source === x && e.target === y) || (e.source === y && e.target === x));

  it('keeps the tree from the gateway as it was', () => {
    expect(has(topo.edges, r1.id, sw1.id)).toBe(true);
    expect(has(topo.edges, sw1.id, sw2.id)).toBe(true);
    expect(has(topo.edges, sw1.id, sw3.id)).toBe(true);
    expect(has(topo.edges, sw2.id, sw3.id)).toBe(false);
  });

  it('adds the cable that closes the ring as a redundant link, with both ports', () => {
    expect(topo.redundant).toHaveLength(1);
    const e = topo.redundant?.[0];
    expect(has([e!], sw2.id, sw3.id)).toBe(true);
    const portOf = (id: string) => (e?.source === id ? e.sourcePort : e?.targetPort);
    expect(portOf(sw2.id)).toBe('Et0/1');
    expect(portOf(sw3.id)).toBe('Et0/0');
  });

  it('draws no redundant links when the gear forms a plain tree', () => {
    const tree = buildTopology({}, [r1, sw1, sw2], { clients: true, collapsed: new Set() }, { ...snapshot, devices: devices.slice(0, 2).map((d) => ({ ...d, neighbors: d.neighbors.filter((n) => n.sysName !== 'SW3') })) });
    expect(tree.redundant ?? []).toEqual([]);
  });
});

describe('parallel cables between two switches', () => {
  const r1 = asset('192.168.100.1', 'router');
  const core = asset('192.168.100.2', 'switch');
  const acc = asset('192.168.100.3', 'switch');
  const port = (ifIndex: number, name: string, stp?: 'blocking' | 'forwarding') => ({ ifIndex, name, up: true, stp });
  const nb = (localIfIndex: number, localPort: string, mgmtIp: string, sysName: string, remotePort: string) => ({ localIfIndex, localPort, mgmtIp, sysName, remotePort });
  const gear = (ip: string, sysName: string, interfaces: ReturnType<typeof port>[], neighbors: ReturnType<typeof nb>[]) => ({
    ip,
    sysName,
    forwarding: true,
    defaultRoute: { nextHop: '192.168.100.1' },
    interfaces,
    neighbors,
    fdb: [],
    arp: [],
  });
  // CORE Et0/1 to ACC Et0/0 and CORE Et0/2 to ACC Et0/1; spanning tree blocks ACC Et0/1. ACC names
  // CORE's ports the long way (as CDP does).
  const devices = [
    gear('192.168.100.2', 'CORE', [port(1, 'Et0/0'), port(2, 'Et0/1'), port(3, 'Et0/2')], [
      nb(1, 'Et0/0', '192.168.100.1', 'R1', 'Et0/0'),
      nb(2, 'Et0/1', '192.168.100.3', 'ACC', 'Et0/0'),
      nb(3, 'Et0/2', '192.168.100.3', 'ACC', 'Et0/1'),
    ]),
    gear('192.168.100.3', 'ACC', [port(1, 'Et0/0', 'forwarding'), port(2, 'Et0/1', 'blocking')], [
      nb(1, 'Et0/0', '192.168.100.2', 'CORE', 'Ethernet0/1'),
      nb(2, 'Et0/1', '192.168.100.2', 'CORE', 'Ethernet0/2'),
    ]),
  ];
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-11-14T00:00:00Z', probed: 3, devices };
  const topo = buildTopology({}, [r1, core, acc], { clients: true, collapsed: new Set() }, snapshot);

  it('draws each cable on its own, the one spanning tree blocks as redundant', () => {
    const tree = topo.edges.filter((e) => e.source === core.id && e.target === acc.id);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ sourcePort: 'Et0/1', targetPort: 'Et0/0' });
    expect(topo.redundant).toHaveLength(1);
    const r = topo.redundant![0]!;
    const portOf = (id: string) => (r.source === id ? r.sourcePort : r.targetPort);
    expect(portOf(core.id)).toBe('Et0/2');
    expect(portOf(acc.id)).toBe('Et0/1');
    expect(r).toMatchObject({ stp: 'blocked', blockedPort: { node: acc.id, port: 'Et0/1' } });
  });

  it('draws both cables when only one side reports them', () => {
    const one = buildTopology({}, [r1, core, acc], { clients: true, collapsed: new Set() }, { ...snapshot, devices: [devices[0]!, { ...devices[1]!, neighbors: [] }] });
    expect(one.edges.filter((e) => e.source === core.id && e.target === acc.id)).toHaveLength(1);
    expect(one.redundant).toHaveLength(1);
  });
});

describe('spanning tree port states', () => {
  it('reads the state of each bridge port onto its interface', () => {
    const w = { ...walks(), stpPortState: [vb(`${OID.stpPortState}.1`, 5), vb(`${OID.stpPortState}.2`, 2), vb(`${OID.stpPortState}.3`, 1)] };
    const d = parseGear('10.9.0.250', w);
    const stp = (ifIndex: number) => d.interfaces.find((i) => i.ifIndex === ifIndex)?.stp;
    expect([stp(101), stp(102), stp(103), stp(104)]).toEqual(['forwarding', 'blocking', 'disabled', undefined]);
  });

  const r1 = asset('192.168.100.1', 'router');
  const sw1 = asset('192.168.100.2', 'switch');
  const sw2 = asset('192.168.100.3', 'switch');
  const sw3 = asset('192.168.100.4', 'switch');
  type Stp = 'blocking' | 'forwarding';
  const port = (ifIndex: number, name: string, stp?: Stp) => ({ ifIndex, name, up: true, stp });
  const nb = (localIfIndex: number, localPort: string, mgmtIp: string, sysName: string, remotePort: string) => ({ localIfIndex, localPort, mgmtIp, sysName, remotePort });
  const ring = (states: Record<string, Stp>, reported = true) => {
    const s = (key: string) => (reported ? (states[key] ?? 'forwarding') : undefined);
    const gear = (ip: string, sysName: string, interfaces: ReturnType<typeof port>[], neighbors: ReturnType<typeof nb>[]) => ({ ip, sysName, forwarding: true, defaultRoute: { nextHop: '192.168.100.1' }, interfaces, neighbors, fdb: [], arp: [] });
    const devices = [
      gear('192.168.100.2', 'SW1', [port(1, 'Et0/0', s('SW1 Et0/0')), port(2, 'Et0/1', s('SW1 Et0/1')), port(5, 'Et1/0', s('SW1 Et1/0'))], [nb(1, 'Et0/0', '192.168.100.1', 'R1', 'Et0/0'), nb(2, 'Et0/1', '192.168.100.3', 'SW2', 'Et0/0'), nb(5, 'Et1/0', '192.168.100.4', 'SW3', 'Et0/1')]),
      gear('192.168.100.3', 'SW2', [port(1, 'Et0/0', s('SW2 Et0/0')), port(2, 'Et0/1', s('SW2 Et0/1'))], [nb(1, 'Et0/0', '192.168.100.2', 'SW1', 'Et0/1'), nb(2, 'Et0/1', '192.168.100.4', 'SW3', 'Et0/0')]),
      gear('192.168.100.4', 'SW3', [port(1, 'Et0/0', s('SW3 Et0/0')), port(2, 'Et0/1', s('SW3 Et0/1'))], [nb(1, 'Et0/0', '192.168.100.3', 'SW2', 'Et0/1'), nb(2, 'Et0/1', '192.168.100.2', 'SW1', 'Et1/0')]),
    ];
    return buildTopology({}, [r1, sw1, sw2, sw3], { clients: true, collapsed: new Set() }, { networkId: 'n', collectedAt: '2026-11-07T00:00:00Z', probed: 4, devices });
  };
  const pair = (e: { source: string; target: string } | undefined, x: string, y: string) => !!e && ((e.source === x && e.target === y) || (e.source === y && e.target === x));

  it('marks the port spanning tree blocks on the redundant link', () => {
    const topo = ring({ 'SW3 Et0/0': 'blocking' });
    const e = topo.redundant?.[0];
    expect(pair(e, sw2.id, sw3.id)).toBe(true);
    expect(e?.stp).toBe('blocked');
    expect(e?.blockedPort).toEqual({ node: sw3.id, port: 'Et0/0' });
  });

  it('draws the tree the network really uses: the blocked cable is the redundant one', () => {
    const topo = ring({ 'SW1 Et1/0': 'blocking' });
    expect(pair(topo.redundant?.[0], sw1.id, sw3.id)).toBe(true);
    expect(topo.edges.some((e) => pair(e, sw2.id, sw3.id))).toBe(true);
    expect(topo.redundant?.[0]?.blockedPort).toEqual({ node: sw1.id, port: 'Et1/0' });
  });

  it('makes no claim about a ring where no port reads blocked: other spanning tree instances are not visible', () => {
    expect(ring({}).redundant?.[0]?.stp).toBeUndefined();
  });

  it('maps spanning tree states through the bridge port table only, never by position', () => {
    // Bridge ports 10..13 are interfaces 101..104. Port 2 is not in the table: read by position it
    // would land on interface 102, which is the MAC-table workaround and wrong for spanning tree.
    const w = {
      ...walks(),
      basePortIfIndex: [10, 11, 12, 13].map((n) => vb(`${OID.basePortIfIndex}.${n}`, 91 + n)),
      stpPortState: [vb(`${OID.stpPortState}.2`, 2)],
    };
    expect(parseGear('10.9.0.250', w).interfaces.some((i) => i.stp)).toBe(false);
  });

  it('says nothing about spanning tree when the switches do not report it', () => {
    const e = ring({}, false).redundant?.[0];
    expect(pair(e, sw2.id, sw3.id)).toBe(true);
    expect(e?.stp).toBeUndefined();
    expect(e?.blockedPort).toBeUndefined();
  });
});

describe('a managed device with several addresses', () => {
  // Router on a stick: R1 routes VLANs 10, 20 and 99 on subinterfaces; CORE hears it over LLDP by its VLAN 10 address.
  const r1 = asset('172.20.99.1', 'router');
  const r1v10 = asset('172.20.10.1', 'router');
  const r1v20 = asset('172.20.20.1', 'router');
  const core = asset('172.20.99.2', 'switch');
  const devices = [
    {
      ip: '172.20.99.1',
      sysName: 'R1',
      forwarding: true,
      interfaces: [{ ifIndex: 1, name: 'Et0/0', up: true }],
      addresses: [
        { ip: '172.20.10.1', prefix: 24, ifIndex: 5 },
        { ip: '172.20.20.1', prefix: 24, ifIndex: 6 },
        { ip: '172.20.99.1', prefix: 24, ifIndex: 7 },
      ],
      neighbors: [{ localIfIndex: 1, localPort: 'Et0/0', mgmtIp: '172.20.99.2', sysName: 'CORE', remotePort: 'Et0/0' }],
      fdb: [],
      arp: [],
    },
    {
      ip: '172.20.99.2',
      sysName: 'CORE',
      forwarding: true,
      defaultRoute: { nextHop: '172.20.99.1' },
      interfaces: [{ ifIndex: 1, name: 'Et0/0', up: true }],
      neighbors: [{ localIfIndex: 1, localPort: 'Et0/0', mgmtIp: '172.20.10.1', sysName: 'R1', remotePort: 'Et0/0' }],
      fdb: [],
      arp: [],
    },
  ];
  const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-11-07T00:00:00Z', probed: 2, devices };
  const topo = buildTopology({}, [r1, r1v10, r1v20, core], { clients: true, collapsed: new Set() }, snapshot);

  it('recognises the gateway by any of its addresses, also when it was read on another one', () => {
    const readOnVlan20 = { ...devices[0]!, ip: '172.20.20.1' };
    const t = buildTopology({}, [r1, r1v10, r1v20, core], { clients: true, collapsed: new Set() }, { ...snapshot, devices: [readOnVlan20, devices[1]!] });
    expect(t.nodes.find((n) => n.kind === 'gateway')?.assetId).toBe(r1.id);
    expect(t.edges.find((e) => e.target === core.id)?.source).toBe(r1.id);
    expect(t.nodes.some((n) => n.assetId === r1v20.id)).toBe(false);
  });

  it('draws it once, whichever of its addresses the scan or a neighbour used', () => {
    expect(topo.nodes.some((n) => n.id === r1v10.id || n.assetId === r1v10.id)).toBe(false);
    expect(topo.nodes.some((n) => n.id === r1v20.id || n.assetId === r1v20.id)).toBe(false);
    expect(topo.edges.filter((e) => e.target === core.id)).toHaveLength(1);
    expect(topo.edges.find((e) => e.target === core.id)?.source).toBe(r1.id);
  });
});

describe('role of a managed device', () => {
  const dev = (forwarding: boolean, fdb: number, bridgePorts?: number) => ({
    ip: '10.0.0.2',
    forwarding,
    bridgePorts,
    interfaces: [],
    neighbors: [],
    fdb: Array.from({ length: fdb }, (_, i) => ({ mac: `aa:00:00:00:00:${String(i).padStart(2, '0')}`, ifIndex: 1 })),
    arp: [],
  });

  it('calls a routing device with bridge ports a layer 3 switch, even when its MAC table reads empty', () => {
    expect(gearRole(dev(true, 0, 4), false)).toBe('Switch (L3)');
    expect(gearRole(dev(true, 3), false)).toBe('Switch (L3)');
  });

  it('calls a routing device without bridge ports or learned addresses a router, and the gateway the gateway', () => {
    expect(gearRole(dev(true, 0), false)).toBe('Router');
    expect(gearRole(dev(true, 0, 4), true)).toBe('Gateway');
    expect(gearRole(dev(false, 0, 4), false)).toBe('Switch');
  });

  it('counts the bridge ports a switch reports', () => {
    expect(parseGear('10.9.0.250', walks()).bridgePorts).toBe(4);
  });
});

describe('what LLDP neighbours say they are', () => {
  it('reads the system capabilities a neighbour has enabled', () => {
    const w = walks();
    w.lldpRem = [...w.lldpRem, vb(`${OID.lldpRem}.12.0.102.1`, Buffer.from([0x28, 0x00]))];
    expect(parseGear('10.9.0.250', w).neighbors[0]?.capabilities).toEqual(['bridge', 'router']);
  });

  it('types a neighbour from its capabilities when its description is not recognised', () => {
    // Some access switches (Aruba CX 6000) announce bridge + router; their model string is not known.
    expect(neighbourType('SW-CORE-01', 'Aruba R8N89A  PL.10.13.1030', ['bridge', 'router'])).toBe('switch');
    expect(neighbourType('lobby', 'Some device', ['bridge', 'wlanAccessPoint'])).toBe('ap');
    expect(neighbourType('desk-01', 'Some device', ['bridge', 'telephone'])).toBe('phone');
    expect(neighbourType('edge', 'Some device', ['router'])).toBe('router');
    expect(neighbourType('pc', 'Some device', ['station'])).toBe('unknown');
  });

  it('keeps a recognised description, and capabilities never turn a firewall into a plain router or switch', () => {
    expect(neighbourType('WAP-01', 'HPE Networking Instant On Access Point 2x2 Wi-Fi 6 Indoor (US) AP22', ['bridge'])).toBe('ap');
    expect(neighbourType('gw-main', 'Debian GNU/Linux 11 (bullseye) Linux 4.19.152-ui-alpine #4.19.152 SMP aarch64', ['bridge', 'router'])).toBe('router');
  });
});

describe('physical ports', () => {
  it('recognises port names across makers, including member/slot/port numbering', () => {
    for (const name of ['1/1/1', '1/1/28', 'igc0', 'ix3', 'Ethernet0/3', 'Et0/1', 'GigabitEthernet0/1', 'gi24', 'ge-0/0/1', 'ether1', 'Port 7'])
      expect(isPhysicalPort(name), name).toBe(true);
  });

  it('does not count VLAN subinterfaces, VLAN interfaces, tunnels or loopbacks as ports', () => {
    for (const name of ['igc0.10', 'Gi0/0.20', 'Et0/0.99', 'vlan1', 'Vlan99', 'tun_wg0', 'ovpnc1', 'lo0', 'Null0'])
      expect(isPhysicalPort(name), name).toBe(false);
  });
});

describe('VLANs from the IEEE 802.1Q bridge tables', () => {
  // An AOS-CX switch publishes VLAN names and port VLANs only in IEEE8021-Q-BRIDGE-MIB
  // (index component.vlan and component.port), with the classic Q-BRIDGE tables empty.
  const ieee = () => ({
    ...walks(),
    vlanStaticName: [],
    vlanStaticEgress: [],
    vlanStaticUntagged: [],
    vlanCurrentEgress: [],
    vlanCurrentUntagged: [],
    pvid: [],
    ieeeVlanStaticName: [vb(`${OID.ieeeVlanStaticName}.1.10`, Buffer.from('USERS')), vb(`${OID.ieeeVlanStaticName}.1.20`, Buffer.from('VOICE'))],
    ieeePvid: [1, 2, 3, 4].map((n) => vb(`${OID.ieeePvid}.1.${n}`, n === 3 ? 10 : 1)),
    ieeeVlanStaticEgress: [vb(`${OID.ieeeVlanStaticEgress}.1.20`, Buffer.from([0b0100_0000]))],
    ieeeVlanStaticUntagged: [vb(`${OID.ieeeVlanStaticUntagged}.1.20`, Buffer.from([0]))],
  });

  it('reads VLAN names, the VLAN of each port and tagged VLANs', () => {
    const d = parseGear('10.9.0.250', ieee());
    expect(d.vlans).toEqual(expect.arrayContaining([{ id: 10, name: 'USERS' }, { id: 20, name: 'VOICE' }]));
    expect(d.interfaces.find((i) => i.ifIndex === 103)?.pvid).toBe(10);
    expect(d.interfaces.find((i) => i.ifIndex === 101)?.pvid).toBe(1);
    expect(d.interfaces.find((i) => i.ifIndex === 102)?.tagged).toEqual([20]);
  });

  it('prefers the classic tables when a switch publishes both', () => {
    const w = { ...walks(), ieeePvid: [1, 2, 3, 4].map((n) => vb(`${OID.ieeePvid}.1.${n}`, 999)) };
    expect(parseGear('10.9.0.250', w).interfaces.find((i) => i.ifIndex === 103)?.pvid).toBe(69);
  });
});

describe('ARP entries from the newer IP-MIB table', () => {
  it('reads IPv4 entries of ipNetToPhysical when the classic ARP table is empty', () => {
    // Index: ifIndex.addressType.length.address; IPv4 is type 1, length 4. IPv6 entries are left out.
    const w = {
      ...walks(),
      ipNetToMedia: [],
      ipNetToPhysical: [
        vb(`${OID.ipNetToPhysical}.300000.1.4.10.9.0.1`, Buffer.from(mac('aa:00:00:00:00:01'))),
        vb(`${OID.ipNetToPhysical}.300000.2.16.254.128.0.0.0.0.0.0.0.0.0.0.0.0.0.1`, Buffer.from(mac('aa:00:00:00:00:02'))),
      ],
    };
    expect(parseGear('10.9.0.250', w).arp).toEqual([{ ip: '10.9.0.1', mac: 'aa:00:00:00:00:01' }]);
  });
});

describe('CDP neighbours', () => {
  /** CDP cache rows, indexed by local ifIndex and device index. */
  const cdp = (ifIndex: number, dev: number, cols: Record<number, unknown>) =>
    Object.entries(cols).map(([c, v]) => vb(`${OID.cdpCache}.${c}.${ifIndex}.${dev}`, v));
  const caps = (bits: number) => Buffer.from([bits >>> 24, (bits >>> 16) & 0xff, (bits >>> 8) & 0xff, bits & 0xff]);
  const router = (ifIndex = 103) =>
    cdp(ifIndex, 7, {
      3: 1,
      4: Buffer.from([10, 9, 0, 10]),
      5: Buffer.from('Cisco IOS Software, Linux Software (I86BI_LINUX-ADVENTERPRISEK9-M), Version 15.4'),
      6: Buffer.from('edge-r2'),
      7: Buffer.from('Ethernet0/0'),
      8: Buffer.from('Linux Unix'),
      9: caps(0x01 | 0x20),
      11: 99,
      12: 3,
    });

  it('reads a neighbour announced only over CDP on the port it was heard on', () => {
    const w = walks();
    w.cdpCache = router();
    const n = parseGear('10.9.0.250', w).neighbors.find((x) => x.protocols?.includes('cdp'));
    expect(n).toMatchObject({
      localIfIndex: 103,
      localPort: 'gi3',
      sysName: 'edge-r2',
      mgmtIp: '10.9.0.10',
      remotePort: 'Ethernet0/0',
      platform: 'Linux Unix',
      capabilities: ['router'],
      nativeVlan: 99,
      duplex: 'full',
      protocols: ['cdp'],
    });
    expect(n?.sysDescr).toContain('Version 15.4');
  });

  it('marks LLDP neighbours with the protocol they came from', () => {
    expect(parseGear('10.9.0.250', walks()).neighbors[0]?.protocols).toEqual(['lldp']);
  });

  it('drops the serial number some devices append to their CDP device ID', () => {
    const w = walks();
    w.cdpCache = cdp(103, 1, { 6: Buffer.from('dc-core-01(FDO21120ABC)'), 9: caps(0x08) });
    expect(parseGear('10.9.0.250', w).neighbors.find((x) => x.localIfIndex === 103)?.sysName).toBe('dc-core-01');
  });

  it('maps CDP capabilities to the LLDP ones the map already understands', () => {
    const w = walks();
    w.cdpCache = [
      ...cdp(103, 1, { 6: Buffer.from('access-sw'), 9: caps(0x08 | 0x20) }),
      ...cdp(104, 2, { 6: Buffer.from('SEP0011220000AA'), 9: caps(0x80 | 0x10) }),
      ...cdp(101, 3, { 6: Buffer.from('lobby-wap'), 9: caps(0x02) }),
      // Routers announce source-route bridging next to routing; that does not make them switches.
      ...cdp(101, 4, { 6: Buffer.from('edge-r1'), 9: caps(0x01 | 0x04) }),
    ];
    const byName = new Map(parseGear('10.9.0.250', w).neighbors.map((n) => [n.sysName, n.capabilities]));
    expect(byName.get('access-sw')).toEqual(['bridge']);
    expect(byName.get('SEP0011220000AA')).toEqual(['telephone', 'station']);
    expect(byName.get('lobby-wap')).toEqual(['bridge']);
    expect(byName.get('edge-r1')).toEqual(['router']);
  });

  it('keeps one neighbour when a device announces itself over both LLDP and CDP', () => {
    const w = walks();
    w.cdpCache = cdp(102, 4, {
      3: 1,
      4: Buffer.from([10, 9, 0, 2]),
      6: Buffer.from('lobby-ap.example.net'),
      7: Buffer.from('GigabitEthernet0'),
      8: Buffer.from('cisco AIR-AP-EXAMPLE'),
      11: 1,
    });
    const onPort = parseGear('10.9.0.250', w).neighbors.filter((n) => n.localIfIndex === 102);
    expect(onPort).toHaveLength(1);
    // LLDP's own reading is kept; CDP adds what LLDP does not carry.
    expect(onPort[0]).toMatchObject({ sysName: 'lobby-ap', remotePort: 'eth0', platform: 'cisco AIR-AP-EXAMPLE', nativeVlan: 1, protocols: ['lldp', 'cdp'] });
  });

  it('joins CDP with the LLDP entry for the same remote port, and keeps the capabilities of both', () => {
    const w = walks();
    // A router announces itself over LLDP once per subinterface; CDP names its physical port.
    const lldp = (entry: number, port: string) => [
      vb(`${OID.lldpRem}.7.0.103.${entry}`, Buffer.from(port)),
      vb(`${OID.lldpRem}.9.0.103.${entry}`, Buffer.from('edge-r1')),
      vb(`${OID.lldpRem}.12.0.103.${entry}`, Buffer.from([0x08])),
    ];
    w.lldpRem.push(...lldp(2, 'Gi0/0.20'), ...lldp(3, 'Gi0/0'));
    w.cdpCache = cdp(103, 9, { 6: Buffer.from('edge-r1'), 7: Buffer.from('GigabitEthernet0/0'), 9: caps(0x01 | 0x08), 12: 3 });
    const onPort = parseGear('10.9.0.250', w).neighbors.filter((n) => n.localIfIndex === 103);
    expect(onPort).toHaveLength(2);
    expect(onPort.find((n) => n.remotePort === 'Gi0/0')).toMatchObject({ protocols: ['lldp', 'cdp'], duplex: 'full', capabilities: ['bridge', 'router'] });
    expect(onPort.find((n) => n.remotePort === 'Gi0/0.20')?.protocols).toEqual(['lldp']);
  });

  it('keeps two different devices on one port as two neighbours', () => {
    const w = walks();
    w.cdpCache = cdp(102, 4, { 3: 1, 4: Buffer.from([10, 9, 0, 77]), 6: Buffer.from('desk-phone') });
    expect(parseGear('10.9.0.250', w).neighbors.filter((n) => n.localIfIndex === 102)).toHaveLength(2);
  });

  it('draws a device heard only over CDP on its switch port, typed from what it announces', () => {
    const w = walks();
    w.cdpCache = router();
    const snapshot: GearSnapshot = { networkId: 'n', collectedAt: '2026-01-01T00:00:00Z', probed: 2, devices: [parseGear('10.9.0.250', w)] };
    const gw = asset('10.9.0.1', 'router', 'aa:00:00:00:00:01');
    const sw = asset('10.9.0.250', 'switch', 'aa:00:00:00:00:99');
    const topo = buildTopology({ gatewayIp: '10.9.0.1', gatewayMac: 'aa:00:00:00:00:01' }, [gw, sw], { clients: true, collapsed: new Set() }, snapshot);
    const node = topo.nodes.find((n) => n.label === 'edge-r2');
    expect(node).toMatchObject({ ip: '10.9.0.10', deviceType: 'router', announced: true, announcedVia: 'CDP' });
    expect(topo.edges.find((e) => e.source === sw.id && e.target === node?.id)).toMatchObject({ inferred: false, sourcePort: 'gi3', targetPort: 'Eth0/0' });
  });

  it("reads each port's duplex", () => {
    const w = walks();
    w.dot3Duplex = [vb(`${OID.dot3Duplex}.101`, 3), vb(`${OID.dot3Duplex}.103`, 2), vb(`${OID.dot3Duplex}.104`, 1)];
    const d = parseGear('10.9.0.250', w);
    expect(d.interfaces.find((i) => i.ifIndex === 101)?.duplex).toBe('full');
    expect(d.interfaces.find((i) => i.ifIndex === 103)?.duplex).toBe('half');
    expect(d.interfaces.find((i) => i.ifIndex === 104)?.duplex).toBeUndefined();
  });
});

describe('VLANs from Cisco tables', () => {
  /** A switch that publishes no 802.1Q tables: VLANs come from VTP and VLAN membership. */
  const cisco = (): GearWalks => {
    const w = walks();
    w.vlanStaticName = [];
    w.vlanStaticEgress = [];
    w.vlanStaticUntagged = [];
    w.vlanCurrentEgress = [];
    w.vlanCurrentUntagged = [];
    w.pvid = [];
    // VLANs 1, 10, 20 and 99, plus the legacy ones every Cisco switch lists.
    w.ciscoVlanName = [
      [1, 'default'],
      [10, 'USERS'],
      [20, 'VOICE'],
      [99, 'MGMT'],
      [1002, 'fddi-default'],
      [1005, 'trnet-default'],
    ].map(([v, n]) => vb(`${OID.ciscoVlanName}.1.${v}`, Buffer.from(String(n))));
    // gi1 trunks with native VLAN 1 and allows everything; gi2 trunks with native 99 and allows 10, 20 and 99.
    const all = Buffer.alloc(128, 0xff);
    const some = Buffer.alloc(128);
    some[1] = 0x20; // VLAN 10
    some[2] = 0x08; // VLAN 20
    some[12] = 0x10; // VLAN 99
    w.ciscoTrunkStatus = [vb(`${OID.ciscoTrunkStatus}.101`, 1), vb(`${OID.ciscoTrunkStatus}.102`, 1), vb(`${OID.ciscoTrunkStatus}.103`, 2), vb(`${OID.ciscoTrunkStatus}.104`, 2)];
    w.ciscoTrunkNative = [vb(`${OID.ciscoTrunkNative}.101`, 1), vb(`${OID.ciscoTrunkNative}.102`, 99), vb(`${OID.ciscoTrunkNative}.103`, 1), vb(`${OID.ciscoTrunkNative}.104`, 1)];
    w.ciscoTrunkVlans = [vb(`${OID.ciscoTrunkVlans1k}.101`, all), vb(`${OID.ciscoTrunkVlans1k}.102`, some), vb(`${OID.ciscoTrunkVlans2k}.101`, all)];
    // gi3 is an access port in VLAN 10; gi4 in VLAN 20.
    w.ciscoAccessVlan = [vb(`${OID.ciscoAccessVlan}.103`, 10), vb(`${OID.ciscoAccessVlan}.104`, 20)];
    return w;
  };

  it('reads VLAN names without the legacy VLANs', () => {
    expect(parseGear('10.9.0.250', cisco()).vlans).toEqual([
      { id: 1, name: 'default' },
      { id: 10, name: 'USERS' },
      { id: 20, name: 'VOICE' },
      { id: 99, name: 'MGMT' },
    ]);
  });

  it('reads trunks as native plus the allowed VLANs that exist on the switch, and access ports as their VLAN', () => {
    const d = parseGear('10.9.0.250', cisco());
    expect(d.interfaces.map((i) => [i.name, i.pvid, i.tagged])).toEqual([
      ['gi1', 1, [10, 20, 99]],
      ['gi2', 99, [10, 20]],
      ['gi3', 10, undefined],
      ['gi4', 20, undefined],
    ]);
  });

  it('is not used when the switch publishes the 802.1Q tables', () => {
    const w = walks();
    w.ciscoVlanName = [vb(`${OID.ciscoVlanName}.1.300`, Buffer.from('OTHER'))];
    w.ciscoAccessVlan = [vb(`${OID.ciscoAccessVlan}.103`, 300)];
    const d = parseGear('10.9.0.250', w);
    expect(d.vlans?.map((v) => v.id)).toEqual([1, 69]);
    expect(d.interfaces.find((i) => i.name === 'gi3')?.pvid).toBe(69);
  });
});
