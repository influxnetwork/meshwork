import { describe, expect, it } from 'vitest';
import type { GearDevice } from '../src/shared/types';
import { guessServerMac, locateByLldp, locateMac, networkVlans, transitPorts, unknownEdgeMacs } from '../src/shared/rogue';

const GW = 'aa:aa:aa:aa:aa:01';
const CORE = 'cc:cc:cc:cc:cc:01';
const EDGE = 'ee:ee:ee:ee:ee:01';
const ROGUE = '50:c7:bf:00:00:99';
const PC = '11:11:11:11:11:11';
const PHONE = '22:22:22:22:22:22';
const HUB_A = '33:33:33:33:33:01';

/** Core switch: port 1 to the gateway, port 2 to the edge switch (LLDP). Edge switch: port 24 up to the core. */
function network(extraEdge: { mac: string; ifIndex: number }[] = []): GearDevice[] {
  const core: GearDevice = {
    ip: '10.10.0.2',
    sysName: 'Core-SW',
    mac: CORE,
    interfaces: [
      { ifIndex: 1, name: 'gi1', up: true },
      { ifIndex: 2, name: 'gi2', up: true },
    ],
    neighbors: [{ localIfIndex: 2, localPort: 'gi2', chassisMac: EDGE }],
    fdb: [
      { mac: GW, ifIndex: 1 },
      { mac: EDGE, ifIndex: 2 },
      { mac: PC, ifIndex: 2 },
      ...extraEdge.map((e) => ({ mac: e.mac, ifIndex: 2 })),
    ],
    arp: [],
  };
  const edge: GearDevice = {
    ip: '10.10.0.3',
    sysName: 'Edge-SW',
    mac: EDGE,
    interfaces: [
      { ifIndex: 5, name: 'gi5', up: true },
      { ifIndex: 14, name: 'gi14', alias: 'Desk 3B', up: true },
      { ifIndex: 24, name: 'gi24', up: true },
    ],
    neighbors: [{ localIfIndex: 24, localPort: 'gi24', chassisMac: CORE }],
    fdb: [{ mac: GW, ifIndex: 24 }, { mac: CORE, ifIndex: 24 }, { mac: PC, ifIndex: 5 }, ...extraEdge],
    arp: [],
  };
  return [core, edge];
}

describe('transitPorts', () => {
  it('marks LLDP links and ports facing the gateway', () => {
    const t = transitPorts(network(), GW);
    expect([...t].sort()).toEqual(['10.10.0.2|1', '10.10.0.2|2', '10.10.0.3|24']);
  });
});

describe('locateMac', () => {
  it('finds the edge port, not the uplinks', () => {
    const where = locateMac(network([{ mac: ROGUE, ifIndex: 14 }]), ROGUE, GW);
    expect(where).toMatchObject({ switchName: 'Edge-SW', port: 'gi14', portAlias: 'Desk 3B', unmanaged: false, beyond: false });
  });

  it('says when the port has an unmanaged switch behind it', () => {
    const where = locateMac(network([{ mac: ROGUE, ifIndex: 14 }, { mac: HUB_A, ifIndex: 14 }]), ROGUE, GW);
    expect(where).toMatchObject({ port: 'gi14', unmanaged: true });
  });

  it('matches MACs regardless of case', () => {
    expect(locateMac(network([{ mac: ROGUE, ifIndex: 14 }]), ROGUE.toUpperCase(), GW)?.port).toBe('gi14');
  });

  it('reports the closest port when the MAC is only seen on links between gear', () => {
    const devices = network();
    devices[0]!.fdb.push({ mac: ROGUE, ifIndex: 1 });
    devices[0]!.fdb = devices[0]!.fdb.filter((f) => f.mac !== GW);
    devices[0]!.neighbors.push({ localIfIndex: 1, localPort: 'gi1', chassisMac: 'dd:dd:dd:dd:dd:01' });
    const where = locateMac(devices, ROGUE, GW);
    expect(where).toMatchObject({ switchName: 'Core-SW', port: 'gi1', beyond: true, gatewayPort: false });
  });

  it('says when the server hangs off the gateway port', () => {
    const devices = network();
    devices[0]!.fdb.push({ mac: ROGUE, ifIndex: 1 });
    expect(locateMac(devices, ROGUE, GW)).toMatchObject({ port: 'gi1', gatewayPort: true, beyond: false, unmanaged: false });
  });

  it('is undefined for a MAC no switch learned', () => {
    expect(locateMac(network(), ROGUE, GW)).toBeUndefined();
  });
});

describe('unknownEdgeMacs and guessServerMac', () => {
  it('ignores gear, known devices and uplinks', () => {
    const now = network([{ mac: ROGUE, ifIndex: 14 }]);
    expect(unknownEdgeMacs(now, new Set([PC]), undefined, GW)).toEqual({ fresh: [], rest: [ROGUE] });
  });

  it('puts addresses missing from the previous reading first', () => {
    const before = network([{ mac: PHONE, ifIndex: 6 }]);
    const now = network([{ mac: PHONE, ifIndex: 6 }, { mac: ROGUE, ifIndex: 14 }]);
    const c = unknownEdgeMacs(now, new Set([PC]), before, GW);
    expect(c).toEqual({ fresh: [ROGUE], rest: [PHONE] });
    expect(guessServerMac(c)).toBe(ROGUE);
  });

  it('does not guess between several candidates', () => {
    expect(guessServerMac({ fresh: [], rest: [ROGUE, PHONE] })).toBeUndefined();
    expect(guessServerMac({ fresh: [ROGUE, PHONE], rest: [] })).toBeUndefined();
    expect(guessServerMac({ fresh: [], rest: [ROGUE] })).toBe(ROGUE);
  });
});

describe('VLANs and moved devices', () => {
  it("prefers the port in the diagnosed network's VLAN", () => {
    const devices = network();
    const edge = devices[1]!;
    edge.fdb = edge.fdb.map((f) => ({ ...f, vlan: 1 }));
    edge.fdb.push({ mac: ROGUE, ifIndex: 5, vlan: 69 }, { mac: ROGUE, ifIndex: 14, vlan: 1 });
    const vlans = networkVlans(devices, undefined, GW);
    expect([...(vlans ?? [])]).toEqual([1]);
    expect(locateMac(devices, ROGUE, GW, { vlans })?.port).toBe('gi14');
  });

  it('counts an address that moved to another port as new', () => {
    const before = network([{ mac: ROGUE, ifIndex: 5 }, { mac: PHONE, ifIndex: 6 }]);
    const now = network([{ mac: ROGUE, ifIndex: 14 }, { mac: PHONE, ifIndex: 6 }]);
    const c = unknownEdgeMacs(now, new Set([PC]), before, GW);
    expect(c).toEqual({ fresh: [ROGUE], rest: [PHONE] });
    expect(locateMac(now, ROGUE, GW, { before })?.port).toBe('gi14');
  });
});

describe('edge cases', () => {
  it('places a server that is itself managed gear on its own port', () => {
    const devices = network();
    // The edge switch announces an access point over LLDP on gi14; the access point runs a DHCP server.
    const AP = '44:44:44:44:44:44';
    devices[1]!.neighbors.push({ localIfIndex: 14, localPort: 'gi14', chassisMac: AP });
    devices[1]!.fdb.push({ mac: AP, ifIndex: 14 });
    devices[0]!.fdb.push({ mac: AP, ifIndex: 2 });
    expect(transitPorts(devices, GW).has('10.10.0.3|14')).toBe(true);
    expect(locateMac(devices, AP, GW)).toMatchObject({ switchName: 'Edge-SW', port: 'gi14', beyond: false });
  });

  it('does not call one device in two VLANs an unmanaged switch', () => {
    const devices = network([{ mac: ROGUE, ifIndex: 14 }]);
    devices[1]!.fdb.push({ mac: ROGUE, ifIndex: 14, vlan: 69 });
    expect(locateMac(devices, ROGUE, GW)).toMatchObject({ port: 'gi14', unmanaged: false });
  });

  it("falls back to the VLAN most of the network's devices are in", () => {
    const devices = network();
    devices[1]!.fdb = devices[1]!.fdb.map((f) => ({ ...f, vlan: f.mac === PC ? 10 : 1 }));
    devices[1]!.fdb.push({ mac: PHONE, ifIndex: 6, vlan: 10 });
    expect([...(networkVlans(devices, undefined, undefined, [PC, PHONE]) ?? [])]).toEqual([10]);
  });
});

describe('locateByLldp', () => {
  const withRouter = (n: Partial<GearDevice['neighbors'][number]>): GearDevice[] => {
    const devs = network();
    devs[1]!.neighbors.push({ localIfIndex: 14, localPort: 'gi14', ...n });
    return devs;
  };

  it('finds a server that announced its address on a port', () => {
    const r = locateByLldp(withRouter({ mgmtIp: '192.168.0.1', chassisMac: ROGUE, sysName: 'Router' }), '192.168.0.1');
    expect(r?.where).toMatchObject({ switchName: 'Edge-SW', port: 'gi14', portAlias: 'Desk 3B', unmanaged: false, beyond: false });
    expect(r?.mac).toBe(ROGUE);
    expect(r?.nodeId).toBe(`lldp:${ROGUE}`);
  });

  it('matches by MAC when the announced address differs', () => {
    const r = locateByLldp(withRouter({ mgmtIp: '172.16.0.1', chassisMac: ROGUE }), '192.168.0.1', ROGUE.toUpperCase());
    expect(r?.where.port).toBe('gi14');
  });

  it('finds nothing for a device that did not announce itself', () => {
    expect(locateByLldp(network(), '192.168.0.1', ROGUE)).toBeUndefined();
  });

  it('names the node by chassis id when there is no MAC', () => {
    const r = locateByLldp(withRouter({ mgmtIp: '192.168.0.1', chassisId: 'router-1' }), '192.168.0.1');
    expect(r?.mac).toBeUndefined();
    expect(r?.nodeId).toBe('lldp:router-1');
  });
});
