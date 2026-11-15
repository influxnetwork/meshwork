import { describe, expect, it } from 'vitest';
import type { GearDevice, GearNeighbor } from '@shared/types';
import { describeMismatch, findLinkMismatches } from '@shared/link-mismatch';

const device = (ip: string, sysName: string, ports: { ifIndex: number; name: string; descr?: string; pvid?: number; duplex?: 'half' | 'full' }[], neighbors: GearNeighbor[] = []): GearDevice => ({
  ip,
  sysName,
  interfaces: ports.map((p) => ({ up: true, ...p })),
  neighbors,
  fdb: [],
  arp: [],
});

const cdp = (localIfIndex: number, localPort: string, peer: { ip: string; name: string; port: string }, extra: Partial<GearNeighbor> = {}): GearNeighbor => ({
  localIfIndex,
  localPort,
  sysName: peer.name,
  chassisId: peer.name,
  mgmtIp: peer.ip,
  remotePort: peer.port,
  protocols: ['cdp'],
  ...extra,
});

describe('link mismatches from CDP', () => {
  it('finds a native VLAN mismatch from what both ends announce, and reports the link once', () => {
    const core = device('198.51.100.2', 'CORE', [{ ifIndex: 4, name: 'Et0/3', descr: 'Ethernet0/3' }], [cdp(4, 'Et0/3', { ip: '198.51.100.4', name: 'ACC2', port: 'Ethernet0/0' }, { nativeVlan: 30 })]);
    const acc2 = device('198.51.100.4', 'ACC2', [{ ifIndex: 1, name: 'Et0/0', descr: 'Ethernet0/0' }], [cdp(1, 'Et0/0', { ip: '198.51.100.2', name: 'CORE', port: 'Ethernet0/3' }, { nativeVlan: 1 })]);
    const found = findLinkMismatches([core, acc2]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: 'nativeVlan',
      local: { name: 'CORE', ip: '198.51.100.2', port: 'Et0/3', value: '1' },
      remote: { name: 'ACC2', ip: '198.51.100.4', port: 'Et0/0', value: '30' },
    });
    expect(describeMismatch(found[0]!)).toBe('Native VLAN differs between CORE Et0/3 (VLAN 1) and ACC2 Et0/0 (VLAN 30)');
  });

  it("uses the port's own VLAN when the neighbour is not managed", () => {
    const sw = device('198.51.100.2', 'CORE', [{ ifIndex: 4, name: 'gi4', pvid: 10 }], [cdp(4, 'gi4', { ip: '198.51.100.9', name: 'edge', port: 'Gi0/1' }, { nativeVlan: 20 })]);
    expect(findLinkMismatches([sw])).toMatchObject([{ kind: 'nativeVlan', local: { value: '10' }, remote: { name: 'edge', value: '20' } }]);
  });

  it('finds a duplex mismatch', () => {
    const sw = device('198.51.100.2', 'CORE', [{ ifIndex: 4, name: 'gi4', duplex: 'full' }], [cdp(4, 'gi4', { ip: '198.51.100.9', name: 'edge', port: 'Fa0/1' }, { duplex: 'half' })]);
    const [m] = findLinkMismatches([sw]);
    expect(m).toMatchObject({ kind: 'duplex', local: { value: 'full' }, remote: { value: 'half' } });
    expect(describeMismatch(m!)).toBe('Duplex differs between CORE gi4 (full duplex) and edge Fa0/1 (half duplex)');
  });

  it('reports nothing when both ends agree or a value is unknown', () => {
    const core = device('198.51.100.2', 'CORE', [{ ifIndex: 4, name: 'Et0/3', descr: 'Ethernet0/3', duplex: 'full' }], [cdp(4, 'Et0/3', { ip: '198.51.100.4', name: 'ACC2', port: 'Ethernet0/0' }, { nativeVlan: 1, duplex: 'full' })]);
    const acc2 = device('198.51.100.4', 'ACC2', [{ ifIndex: 1, name: 'Et0/0', descr: 'Ethernet0/0' }], [cdp(1, 'Et0/0', { ip: '198.51.100.2', name: 'CORE', port: 'Ethernet0/3' }, { nativeVlan: 1 })]);
    const lone = device('198.51.100.5', 'ACC3', [{ ifIndex: 1, name: 'gi1' }], [cdp(1, 'gi1', { ip: '198.51.100.9', name: 'edge', port: 'Gi0/1' }, { nativeVlan: 20 })]);
    expect(findLinkMismatches([core, acc2, lone])).toEqual([]);
  });

  it('ignores neighbours heard only over LLDP, which carries neither value', () => {
    const sw = device('198.51.100.2', 'CORE', [{ ifIndex: 4, name: 'gi4', pvid: 10 }], [{ ...cdp(4, 'gi4', { ip: '198.51.100.9', name: 'edge', port: 'eth0' }), protocols: ['lldp'], nativeVlan: 20 }]);
    expect(findLinkMismatches([sw])).toEqual([]);
  });
});
