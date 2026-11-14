import { describe, expect, it } from 'vitest';
import type { GearDevice, GearNeighbor } from '../src/shared/types';
import { describeLoop, findLoops } from '../src/shared/loops';

const SELF = 'f0:c1:7f:00:00:01';
const OTHER = 'aa:bb:cc:00:00:02';

function sw(neighbors: GearNeighbor[]): GearDevice {
  return {
    ip: '10.0.0.56',
    sysName: 'Core-SW',
    mac: SELF,
    interfaces: [
      { ifIndex: 1, name: 'gi1', descr: 'GigabitEthernet1', up: true },
      { ifIndex: 21, name: 'gi21', descr: 'GigabitEthernet21', up: true },
      { ifIndex: 24, name: 'gi24', up: true },
    ],
    neighbors,
    fdb: [],
    arp: [],
    addresses: [{ ip: '10.0.0.56', prefix: 24, ifIndex: 100 }],
  };
}

describe('findLoops', () => {
  it('flags a switch that hears itself on two ports', () => {
    const d = sw([
      { localIfIndex: 21, localPort: 'gi21', chassisMac: SELF, remotePort: 'gi1' },
      { localIfIndex: 1, localPort: 'gi1', chassisMac: SELF.toUpperCase(), remotePort: 'gi21' },
      { localIfIndex: 24, localPort: 'gi24', chassisMac: OTHER, sysName: 'AP' },
    ]);
    expect(findLoops([d])).toEqual([{ switchIp: '10.0.0.56', switchName: 'Core-SW', ports: ['gi1', 'gi21'] }]);
  });

  it('names the sending port from its description when only one side is reported', () => {
    const d = sw([{ localIfIndex: 21, localPort: 'gi21', chassisMac: SELF, remotePort: 'GigabitEthernet1' }]);
    expect(findLoops([d])[0]?.ports).toEqual(['gi1', 'gi21']);
  });

  it('recognises itself by management address when no chassis MAC is given', () => {
    const d = sw([{ localIfIndex: 21, localPort: 'gi21', chassisId: 'x', mgmtIp: '10.0.0.56' }]);
    expect(findLoops([d])[0]?.ports).toEqual(['gi21']);
  });

  it('recognises itself by management address when its LLDP chassis MAC differs from its bridge address', () => {
    // A switch whose bridge address differs from its LLDP chassis ID: bridge address cc:cc:00:00:00:02, LLDP chassis aa:bb:cc:00:01:00.
    const d = sw([
      { localIfIndex: 21, localPort: 'gi21', chassisMac: 'aa:bb:cc:00:01:00', mgmtIp: '10.0.0.56', sysName: 'Core-SW', remotePort: 'gi1' },
      { localIfIndex: 1, localPort: 'gi1', chassisMac: 'aa:bb:cc:00:01:00', mgmtIp: '10.0.0.56', sysName: 'Core-SW', remotePort: 'gi21' },
    ]);
    expect(findLoops([d])[0]?.ports).toEqual(['gi1', 'gi21']);
  });

  it('does not take a stack member or redundant pair sharing its management address for itself', () => {
    const d = sw([{ localIfIndex: 24, localPort: 'gi24', chassisMac: OTHER, mgmtIp: '10.0.0.56', sysName: 'Core-SW-2', remotePort: 'gi1' }]);
    expect(findLoops([d])).toEqual([]);
  });

  it('does not flag a neighbour with another chassis MAC and another management address', () => {
    const d = sw([{ localIfIndex: 24, localPort: 'gi24', chassisMac: OTHER, mgmtIp: '10.0.0.57', remotePort: 'gi1' }]);
    expect(findLoops([d])).toEqual([]);
  });

  it('does not flag other gear, even with the same name', () => {
    const d = sw([
      { localIfIndex: 24, localPort: 'gi24', chassisMac: OTHER, sysName: 'Core-SW' },
      { localIfIndex: 21, localPort: 'gi21', mgmtIp: '10.0.0.57' },
    ]);
    expect(findLoops([d])).toEqual([]);
  });

  it('describes the joined ports', () => {
    expect(describeLoop({ switchIp: 'x', ports: ['gi1', 'gi21'] })).toBe('gi1 and gi21 are connected to each other through other gear');
    expect(describeLoop({ switchIp: 'x', ports: ['gi1', 'gi2', 'gi3'] })).toBe('gi1, gi2 and gi3 are connected to each other through other gear');
  });
});

describe('loops from the MAC table', () => {
  it('flags a switch that learned the address of one of its own ports on another port', () => {
    const d = sw([]);
    d.interfaces = [
      { ifIndex: 1, name: 'gi1', up: true, mac: 'f0:c1:7f:00:00:11' },
      { ifIndex: 21, name: 'gi21', up: true, mac: 'f0:c1:7f:00:00:31' },
      { ifIndex: 24, name: 'gi24', up: true, mac: 'f0:c1:7f:00:00:41' },
    ];
    d.fdb = [
      { mac: 'f0:c1:7f:00:00:31', ifIndex: 1 },
      { mac: OTHER, ifIndex: 24 },
    ];
    expect(findLoops([d])).toEqual([{ switchIp: '10.0.0.56', switchName: 'Core-SW', ports: ['gi1', 'gi21'] }]);
  });

  it('ignores an address shared by several of its interfaces: it cannot tell which port sent it', () => {
    const d = sw([]);
    d.interfaces = [
      { ifIndex: 1, name: 'gi1', up: true, mac: 'f0:c1:7f:00:00:01' },
      { ifIndex: 2, name: 'gi2', up: true, mac: 'f0:c1:7f:00:00:01' },
      { ifIndex: 100, name: 'Vlan1', up: true, mac: 'f0:c1:7f:00:00:01' },
    ];
    d.fdb = [{ mac: 'f0:c1:7f:00:00:01', ifIndex: 1 }];
    expect(findLoops([d])).toEqual([]);
  });

  it('does not flag a switch whose MAC table holds only other devices', () => {
    const d = sw([]);
    d.interfaces = [{ ifIndex: 1, name: 'gi1', up: true, mac: 'f0:c1:7f:00:00:11' }];
    d.fdb = [{ mac: OTHER, ifIndex: 1 }];
    expect(findLoops([d])).toEqual([]);
  });
});
