import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredHost } from '@shared/types';
import { countAddresses, describeTargets, expandRanges, intToIp, ipToInt, parseTargets, parseToken } from '../src/scanner/targets';
import { parsePortList, serviceName, TOP_PORTS } from '../src/scanner/ports';
import { tcpProbe, buildNbstatQuery, normalizeMac, parseArp, parseNbstat, parseNbstatReply, parsePingOutput, parsePingSeries, parseNdp, parseNetshNeighbors6, ipv6Scope, addressesByMac } from '../src/scanner/probes';
import { classify, evaluateRisks, VendorDb } from '../src/scanner/analysis';
import { countPortChecks, identifyInterfaces, macGaps, MIN_PORT_WAIT_MS, networkIdentity, parseDefaultGateways, PortWait, portChecks, subnetOf } from '../src/scanner/engine';
import { compareVersions, parseCsv, parseIeeeCsv } from '../src/main/vendor-format';
import { assetsToCsv, defaultNetworkName, Inventory, sortByIp } from '../src/main/inventory';
import { fromHelper, generationOf, netshNeedsLocation, parseNetshInterface, parseNetshNetworks, percentToDbm } from '../src/main/wifi-format';

function host(partial: Partial<DiscoveredHost>): DiscoveredHost {
  return { ip: '192.0.2.10', names: [], aliveVia: ['tcp'], ports: [], type: 'unknown', typeConfidence: 0, evidence: [], risks: [], ...partial };
}
const ports = (...p: number[]) => p.map((port) => ({ port, service: serviceName(port) }));

describe('targets', () => {
  it('parses single addresses, ranges, shorthand ranges and CIDR blocks', () => {
    expect(parseToken('10.0.0.5')).toEqual({ start: ipToInt('10.0.0.5'), end: ipToInt('10.0.0.5') });
    expect(countAddresses([parseToken('10.0.0.1-10.0.0.50')])).toBe(50);
    expect(countAddresses([parseToken('10.0.0.10-20')])).toBe(11);
    expect(countAddresses([parseToken('192.168.1.0/24')])).toBe(254);
    expect(countAddresses([parseToken('192.168.1.7/32')])).toBe(1);
    expect(intToIp(parseToken('localhost').start)).toBe('127.0.0.1');
  });

  it('skips network and broadcast addresses of a CIDR block', () => {
    expect([...expandRanges([parseToken('10.1.2.0/30')])]).toEqual(['10.1.2.1', '10.1.2.2']);
  });

  it('normalises a CIDR given with a host address', () => {
    expect(intToIp(parseToken('10.9.8.77/24').start)).toBe('10.9.8.1');
  });

  it('merges overlapping inputs and reports invalid ones', () => {
    const { ranges, errors } = parseTargets('10.0.0.0/24; 10.0.0.10-10.0.0.20, 999.1.1.1 10.0.1.1');
    expect(countAddresses(ranges)).toBe(255);
    expect(errors).toHaveLength(1);
  });

  it('rejects ranges that end before they start and oversized scans', () => {
    expect(() => parseToken('10.0.0.50-10.0.0.1')).toThrow();
    expect(describeTargets('10.0.0.0/8').tooLarge).toBe(true);
    expect(describeTargets('10.0.0.0/16').tooLarge).toBe(false);
  });
});

describe('ports', () => {
  it('parses custom lists with ranges and removes duplicates', () => {
    expect(parsePortList('22, 80,443 8000-8002,80')).toEqual([22, 80, 443, 8000, 8001, 8002]);
    expect(() => parsePortList('0')).toThrow();
    expect(() => parsePortList('70000')).toThrow();
    expect(() => parsePortList('abc')).toThrow();
  });

  it('keeps the common list free of duplicates', () => {
    expect(new Set(TOP_PORTS).size).toBe(TOP_PORTS.length);
  });
});

describe('probe parsers', () => {
  it('reads ARP tables from macOS and Windows output', () => {
    const mac = parseArp(
      '? (192.0.2.1) at a4:2b:b0:c0:17:a7 on en0 ifscope [ethernet]\n? (192.0.2.9) at (incomplete) on en0\n? (192.0.2.7) at 0:c:29:1:2:3 on en0',
    );
    expect(mac.get('192.0.2.1')).toBe('a4:2b:b0:c0:17:a7');
    expect(mac.get('192.0.2.7')).toBe('00:0c:29:01:02:03');
    expect(mac.has('192.0.2.9')).toBe(false);
    const win = parseArp('  192.0.2.20          3c-2a-f4-c0-11-a1     dynamic\n  192.0.2.255         ff-ff-ff-ff-ff-ff     static');
    expect(win.get('192.0.2.20')).toBe('3c:2a:f4:c0:11:a1');
    expect(win.has('192.0.2.255')).toBe(false);
  });

  it('normalises and filters MAC addresses', () => {
    expect(normalizeMac('AA-BB-CC-DD-EE-FF')).toBe('aa:bb:cc:dd:ee:ff');
    expect(normalizeMac('01:00:5e:00:00:fb')).toBeUndefined();
    expect(normalizeMac('nonsense')).toBeUndefined();
  });

  it('reads ping replies and ignores unreachable answers', () => {
    expect(parsePingOutput('64 bytes from 192.0.2.1: icmp_seq=0 ttl=64 time=2.431 ms', 0)).toEqual({ alive: true, ttl: 64, rttMs: 2.431 });
    expect(parsePingOutput('Reply from 192.0.2.5: bytes=32 time<1ms TTL=128', 0).ttl).toBe(128);
    expect(parsePingOutput('Reply from 192.0.2.1: Destination host unreachable.', 0).alive).toBe(false);
    expect(parsePingOutput('Request timeout for icmp_seq 0', 2).alive).toBe(false);
  });

  it('builds a NetBIOS node status query and parses the workstation name', () => {
    const q = buildNbstatQuery(0x1234);
    expect(q.length).toBe(50);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.subarray(13, 15).toString()).toBe('CK');

    const reply = Buffer.alloc(12 + 34 + 10 + 1 + 18 * 2);
    let o = 12 + 34 + 10;
    reply[o++] = 2;
    Buffer.from('WORKGROUP      ').copy(reply, o);
    reply[o + 15] = 0x00;
    reply.writeUInt16BE(0x8400, o + 16); // group name
    o += 18;
    Buffer.from('WS-ACCT-07     ').copy(reply, o);
    reply[o + 15] = 0x00;
    reply.writeUInt16BE(0x0400, o + 16);
    expect(parseNbstat(reply)).toBe('WS-ACCT-07');
    expect(parseNbstat(Buffer.alloc(10))).toBeUndefined();
  });

  it('reads the adapter MAC that follows the NetBIOS name table', () => {
    const base = 12 + 34 + 10;
    const reply = Buffer.alloc(base + 1 + 18 + 6);
    reply[base] = 1;
    Buffer.from('PRINTER-2F     ').copy(reply, base + 1);
    reply.writeUInt16BE(0x0400, base + 1 + 16);
    Buffer.from([0x3c, 0x2a, 0xf4, 0x01, 0x02, 0x03]).copy(reply, base + 1 + 18);
    expect(parseNbstatReply(reply)).toEqual({ name: 'PRINTER-2F', mac: '3c:2a:f4:01:02:03' });

    reply.fill(0, base + 1 + 18); // hosts that report a zero unit ID
    expect(parseNbstatReply(reply)).toEqual({ name: 'PRINTER-2F' });
  });
});

describe('ping series', () => {
  it('maps macOS replies and timeouts by icmp_seq', () => {
    const out = [
      'PING 10.0.0.1 (10.0.0.1): 56 data bytes',
      '64 bytes from 10.0.0.1: icmp_seq=0 ttl=64 time=4.560 ms',
      'Request timeout for icmp_seq 1',
      '64 bytes from 10.0.0.1: icmp_seq=2 ttl=64 time=3.1 ms',
      '64 bytes from 10.0.0.1: icmp_seq=3 ttl=64 time=12.04 ms',
    ].join('\n');
    expect(parsePingSeries(out, 4)).toEqual([
      { seq: 1, timeMs: 4.56 },
      { seq: 2, timeMs: undefined },
      { seq: 3, timeMs: 3.1 },
      { seq: 4, timeMs: 12.04 },
    ]);
  });

  it('maps Windows replies in line order', () => {
    const out = [
      'Pinging 10.0.0.1 with 32 bytes of data:',
      'Reply from 10.0.0.1: bytes=32 time<1ms TTL=64',
      'Request timed out.',
      'Reply from 10.0.0.1: bytes=32 time=7ms TTL=64',
      'Reply from 10.0.0.1: bytes=32 time=2ms TTL=64',
      '',
      'Ping statistics for 10.0.0.1:',
      '    Minimum = 0ms, Maximum = 7ms, Average = 3ms',
    ].join('\r\n');
    expect(parsePingSeries(out, 4).map((r) => r.timeMs)).toEqual([1, undefined, 7, 2]);
  });

  it('maps localised Windows output by its TTL marker', () => {
    const out = [
      'Haciendo ping a 10.0.0.1 con 32 bytes de datos:',
      'Respuesta desde 10.0.0.1: bytes=32 tiempo=3ms TTL=64',
      'Tiempo de espera agotado para esta solicitud.',
      'Respuesta desde 10.0.0.1: bytes=32 tiempo<1ms TTL=64',
      'Respuesta desde 10.0.0.1: bytes=32 tiempo=5ms TTL=64',
      '',
      'Estadísticas de ping para 10.0.0.1:',
    ].join('\r\n');
    expect(parsePingSeries(out, 4).map((r) => r.timeMs)).toEqual([3, undefined, 1, 5]);
  });

  it('finds the default gateway on Windows and macOS', () => {
    const win = [
      'IPv4 Route Table',
      'Network Destination        Netmask          Gateway       Interface  Metric',
      '          0.0.0.0          0.0.0.0         10.0.0.1      10.0.0.31     25',
    ].join('\r\n');
    expect(parseDefaultGateways(win, 'win32')).toEqual(['10.0.0.1']);
    expect(parseDefaultGateways('   route to: default\n    gateway: 192.168.1.1\n', 'darwin')).toEqual(['192.168.1.1']);
  });

  it('reports every request as lost when there is no output', () => {
    expect(parsePingSeries('', 4).every((r) => r.timeMs === undefined)).toBe(true);
  });
});

describe('ipv6 neighbours', () => {
  it('classifies address scopes', () => {
    expect(ipv6Scope('2001:db8::5')).toBe('global');
    expect(ipv6Scope('fd12:3456::1')).toBe('unique-local');
    expect(ipv6Scope('fe80::1c9a:1234:5678:9abc')).toBe('link-local');
    expect(ipv6Scope('ff02::1')).toBeUndefined();
    expect(ipv6Scope('::1')).toBeUndefined();
  });

  it('reads the macOS neighbour table and groups addresses by MAC, global first', () => {
    const out = [
      'Neighbor                                Linklayer Address  Netif Expire    St Flgs Prbs',
      '2001:db8:1:2::34fe                 f8:e4:3b:c0:1c:ac    en6 permanent R',
      '2001:db8:1:2::f028                 (incomplete)         en6 expired   N',
      '2001:db8:1:2:a1b2:c3d4:e5f6:1234   f2:26:1c:c0:19:a9    en6 22h16m5s  S',
      'fe80::40c:91ff:fe1a:2b3c%en6            f2:26:1c:c0:19:a9    en6 23h59m58s S',
      'fe80::88c8:acff:fec0:15a5%awdl0         8a:c8:ac:c0:15:a5  awdl0 permanent R',
      'ff02::fb%en6                            33:33:0:0:0:fb       en6 permanent R',
    ].join('\n');
    const entries = parseNdp(out);
    expect(entries).toHaveLength(4);
    const byMac = addressesByMac(entries, 'en6');
    expect(byMac.get('f2:26:1c:c0:19:a9')).toEqual([
      { address: '2001:db8:1:2:a1b2:c3d4:e5f6:1234', scope: 'global' },
      { address: 'fe80::40c:91ff:fe1a:2b3c', scope: 'link-local' },
    ]);
    expect(byMac.has('8a:c8:ac:c0:15:a5')).toBe(false);
  });

  it('reads the Windows neighbour table in any language', () => {
    const out = [
      'Interfaz 12: Ethernet',
      '',
      'Dirección de Internet                         Dirección física   Tipo',
      '--------------------------------------------  -----------------  -----------',
      'fe80::1                                       f8-d0-0e-c0-1a-aa  Alcanzable (Router)',
      '2001:db8::25                                  74-86-e2-c0-14-a4  Obsoleto',
      'ff02::1                                       33-33-00-00-00-01  Permanente',
    ].join('\r\n');
    expect(parseNetshNeighbors6(out)).toEqual([
      { address: 'fe80::1', mac: 'f8:d0:0e:c0:1a:aa', iface: undefined },
      { address: '2001:db8::25', mac: '74:86:e2:c0:14:a4', iface: undefined },
    ]);
  });
});

describe('network identity', () => {
  const ranges = parseTargets('10.0.0.0/24').ranges;
  const interfaces = [{ address: '10.0.0.31', cidr: '10.0.0.0/24' }];

  it('uses the router MAC on an attached subnet', () => {
    const vendors = new VendorDb({ F8D00E: 'Vantiva USA LLC' });
    const id = networkIdentity({ ranges, interfaces, gateways: ['10.0.0.1'], arp: new Map([['10.0.0.1', 'f8:d0:0e:c0:1a:aa']]), vendors });
    expect(id).toMatchObject({ fingerprint: 'gw:f8:d0:0e:c0:1a:aa', cidr: '10.0.0.0/24', gatewayIp: '10.0.0.1', local: true });
    expect(defaultNetworkName(id)).toBe('10.0.0.0/24 · Vantiva router');
  });

  it('falls back to the subnet, and to the ranges for networks this computer is not on', () => {
    expect(networkIdentity({ ranges, interfaces, gateways: ['10.0.0.1'], arp: new Map() }).fingerprint).toBe('subnet:10.0.0.0/24');
    const remote = networkIdentity({ ranges: parseTargets('172.16.4.0/24, 172.16.9.10-20').ranges, interfaces, gateways: [], arp: new Map() });
    expect(remote).toMatchObject({ fingerprint: 'range:172.16.4.0/24, 172.16.9.10-172.16.9.20', local: false });
    expect(subnetOf('192.168.1.215', 23)).toBe('192.168.0.0/23');
  });
});

describe('analysis', () => {
  const vendors = new VendorDb({ F01898: 'Apple, Inc.', '3C2AF4': 'Brother Industries, LTD.', '000C29': 'VMware, Inc.' });

  it('looks up vendors and recognises private (randomised) addresses', () => {
    expect(vendors.lookup('f0:18:98:c0:18:a8')).toBe('Apple, Inc.');
    expect(vendors.lookup('da:a1:19:00:00:01')).toBe('Private address');
    expect(vendors.lookup('00:11:22:33:44:55')).toBeUndefined();
    expect(vendors.lookup(undefined)).toBeUndefined();
  });

  it('classifies common devices with evidence', () => {
    expect(classify(host({ ports: ports(80, 631, 9100), vendor: 'Brother Industries, LTD.' })).type).toBe('printer');
    // HP printers come from HP Inc.; Hewlett Packard Enterprise makes access points and servers.
    expect(classify(host({ ports: ports(80, 443), vendor: 'HP Inc.' })).type).toBe('printer');
    expect(classify(host({ ports: ports(80, 443), vendor: 'Hewlett Packard Enterprise' })).type).not.toBe('printer');
    expect(classify(host({ ports: ports(80, 443), vendor: 'Nokia Corporation' })).type).not.toBe('printer');
    // A UniFi console serves DNS: a gateway, not an access point, even though Ubiquiti makes APs.
    expect(classify(host({ ports: ports(53, 80, 443, 8080), vendor: 'Ubiquiti Inc' })).type).toBe('router');
    expect(classify(host({ ports: ports(22, 80, 443), vendor: 'Ubiquiti Inc' })).type).toBe('ap');
    const win = classify(host({ ports: ports(135, 139, 445, 3389), ttl: 128 }));
    expect(win.type).toBe('computer');
    expect(win.os).toBe('Windows');
    expect(win.evidence.length).toBeGreaterThan(0);
    const phone = classify(host({ ports: ports(62078), vendor: 'Apple, Inc.' }));
    expect(phone.type).toBe('phone');
    expect(phone.os).toBe('iOS');
    expect(classify(host({ ports: ports(22, 445, 548), vendor: 'Apple, Inc.', hostname: 'Alex-MacBook-Pro' })).type).toBe('laptop');
    expect(classify(host({ mac: '00:0c:29:01:02:03' })).type).toBe('vm');
    expect(classify(host({ ip: '192.0.2.1', ports: ports(53, 80), vendor: 'TP-LINK TECHNOLOGIES CO.,LTD.' }), ['192.0.2.1']).type).toBe('router');
    expect(classify(host({ ports: ports(22, 80, 5432), ttl: 64 })).type).toBe('server');
  });

  it('falls back to a low-confidence OS guess from TTL', () => {
    const c = classify(host({ ttl: 64 }));
    expect(c.type).toBe('unknown');
    expect(c.os).toBe('Linux / Unix-like');
    expect(c.osConfidence).toBeLessThan(0.5);
  });

  it('flags risky services, highest severity first', () => {
    const risks = evaluateRisks(host({ ports: ports(23, 445, 3389) }));
    expect(risks.map((r) => r.ruleId)).toEqual(['telnet-open', 'rdp-open', 'smb-open']);
    expect(evaluateRisks(host({ type: 'printer', ports: ports(80, 9100) })).some((r) => r.ruleId === 'http-admin')).toBe(true);
    expect(evaluateRisks(host({ type: 'printer', ports: ports(80, 443) })).some((r) => r.ruleId === 'http-admin')).toBe(false);
    expect(evaluateRisks(host({ ports: ports(22, 443) }))).toEqual([]);
  });
});

describe('vendor registry updates', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('2.1.52', '2.1.51')).toBeGreaterThan(0);
    expect(compareVersions('2.10.0', '2.9.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1.51', '2.1.51')).toBe(0);
  });

  it('reads CSV with quoted commas, doubled quotes and line breaks inside fields', () => {
    const csv = 'a,b,c\r\n1,"x, ""y""",z\n2,"multi\nline",w\n';
    expect(parseCsv(csv)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, "y"', 'z'],
      ['2', 'multi\nline', 'w'],
    ]);
  });

  it('reads IEEE assignment lists of each prefix length', () => {
    const header = 'Registry,Assignment,Organization Name,Organization Address\n';
    const mal = header + 'MA-L,F01898,"Apple, Inc.",1 Infinite Loop Cupertino CA US 95014\nMA-L,ABCDEF,Private,\nMA-L,XYZ,Bad,\n';
    const mas = header + 'MA-S,8C1F64AFA,"DATA ELECTRONIC DEVICES, INC","32 NORTHWESTERN DR\nSALEM NH US 03079 "\n';
    expect(parseIeeeCsv(mal, 6)).toEqual({ F01898: 'Apple, Inc.' });
    expect(parseIeeeCsv(mas, 9)).toEqual({ '8C1F64AFA': 'DATA ELECTRONIC DEVICES, INC' });
  });

  it('prefers the most specific assignment when looking up a vendor', () => {
    const db = new VendorDb({ '8C1F64': 'IEEE Registration Authority', '8C1F64A': 'Medium Vendor', '8C1F64AFA': 'Small Vendor' });
    expect(db.lookup('8c:1f:64:af:a0:01')).toBe('Small Vendor');
    expect(db.lookup('8c:1f:64:a0:00:01')).toBe('Medium Vendor');
    expect(db.lookup('8c:1f:64:10:00:01')).toBe('IEEE Registration Authority');
  });
});

describe('inventory', () => {
  const db = () => new Inventory(join(mkdtempSync(join(tmpdir(), 'inv-')), 'inventory.db'));
  const home = { fingerprint: 'gw:f8:d0:0e:c0:1a:aa', cidr: '192.0.2.0/24', gatewayIp: '192.0.2.1', gatewayMac: 'f8:d0:0e:c0:1a:aa', local: true };
  const office = { fingerprint: 'gw:00:11:22:33:44:55', cidr: '192.0.2.0/24', gatewayIp: '192.0.2.1', gatewayMac: '00:11:22:33:44:55', local: true };

  it('creates, updates and re-keys assets across runs', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    const a = inv.upsert(host({ ip: '192.0.2.50' }), 'run-1', net);
    expect(a.isNew).toBe(true);
    expect(a.networkId).toBe(net);
    const b = inv.upsert(host({ ip: '192.0.2.50', mac: 'aa:bb:cc:00:11:22', ports: ports(22) }), 'run-1', net);
    expect(b.id).toBe(a.id);
    expect(b.ports).toHaveLength(1);
    const c = inv.upsert(host({ ip: '192.0.2.77', mac: 'aa:bb:cc:00:11:22' }), 'run-2', net);
    expect(c.id).toBe(a.id);
    expect(c.ip).toBe('192.0.2.77');
    expect(c.isNew).toBe(false);
    expect(inv.list()).toHaveLength(1);
    expect(inv.countNew('run-2')).toBe(0);
    inv.close();
  });

  it('marks as new only devices first seen in the network\'s latest scan', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    const other = inv.resolveNetwork(office).id;
    inv.upsert(host({ ip: '192.0.2.10', mac: 'aa:bb:cc:00:00:10' }), 'run-1', net);
    inv.upsert(host({ ip: '192.0.2.132', mac: 'aa:bb:cc:00:01:32' }), 'run-1', net);
    inv.upsert(host({ ip: '192.0.2.10', mac: 'aa:bb:cc:00:00:10' }), 'run-2', net);
    const fresh = inv.upsert(host({ ip: '192.0.2.48', mac: 'aa:bb:cc:00:00:48' }), 'run-2', net);
    expect(fresh.isNew).toBe(true);
    inv.upsert(host({ ip: '192.0.2.5', mac: 'aa:bb:cc:00:00:05' }), 'run-9', other);
    const byIp = new Map(inv.list().map((a) => [a.ip, a]));
    expect(byIp.get('192.0.2.132')?.isNew).toBe(false);
    expect(byIp.get('192.0.2.10')?.isNew).toBe(false);
    expect(byIp.get('192.0.2.48')?.isNew).toBe(true);
    expect(byIp.get('192.0.2.5')?.isNew).toBe(true);
    expect(inv.get([byIp.get('192.0.2.132')!.id])[0]?.isNew).toBe(false);
    inv.close();
  });

  it('returns requested assets in the order asked, and sorts a full list by IP', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    const ids = ['192.0.2.30', '192.0.2.4', '192.0.2.100', '192.0.2.21'].map((ip) => inv.upsert(host({ ip }), 'run-1', net).id);
    const asked = [ids[2]!, ids[0]!, ids[3]!, ids[1]!];
    expect(inv.get(asked).map((a) => a.id)).toEqual(asked);
    expect(sortByIp(inv.list()).map((a) => a.ip)).toEqual(['192.0.2.4', '192.0.2.21', '192.0.2.30', '192.0.2.100']);
    inv.close();
  });

  it('keeps MAC addresses learned over SNMP for devices a remote scan cannot see them on', () => {
    const inv = db();
    const remote = inv.resolveNetwork({ fingerprint: 'range:198.51.100.0/24', cidr: '198.51.100.0/24', local: false }).id;
    const a = inv.upsert(host({ ip: '198.51.100.52' }), 'run-1', remote);
    expect(a.mac).toBeUndefined();
    expect(inv.fillMacs(remote, [{ ip: '198.51.100.52', mac: 'aa:bb:cc:00:00:52', vendor: 'Acme Printers' }])).toBe(1);
    expect(inv.get([a.id])[0]).toMatchObject({ mac: 'aa:bb:cc:00:00:52', vendor: 'Acme Printers', macSource: 'snmp' });
    // The next remote scan (no MAC) keeps the address and matches the same device.
    const again = inv.upsert(host({ ip: '198.51.100.52' }), 'run-2', remote);
    expect(again).toMatchObject({ id: a.id, mac: 'aa:bb:cc:00:00:52', vendor: 'Acme Printers' });
    // Reading again with the same address changes nothing; a new device on that IP updates it.
    expect(inv.fillMacs(remote, [{ ip: '198.51.100.52', mac: 'aa:bb:cc:00:00:52' }])).toBe(0);
    expect(inv.fillMacs(remote, [{ ip: '198.51.100.52', mac: 'aa:bb:cc:00:00:99' }])).toBe(1);
    // An address the scan saw itself wins and is never overwritten by SNMP.
    const seen = inv.upsert(host({ ip: '198.51.100.52', mac: 'aa:bb:cc:00:00:77' }), 'run-3', remote);
    expect(seen.mac).toBe('aa:bb:cc:00:00:77');
    expect(seen.macSource).toBeUndefined();
    expect(inv.fillMacs(remote, [{ ip: '198.51.100.52', mac: 'aa:bb:cc:00:00:99' }])).toBe(0);
    inv.close();
  });

  it('removes one scan from the history and keeps the rest and the devices', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    inv.upsert(host({}), 'kept', net);
    const run = (runId: string, networkId: string | undefined, live: number) =>
      inv.recordRun({ runId, networkId, targets: '192.0.2.0/24', startedAt: `2026-11-0${live + 1}T00:00:00Z`, finishedAt: '2026-11-02T00:01:00Z', status: 'done', scanned: 254, live, newAssets: 0, openPorts: 0, risks: 0 });
    run('empty', undefined, 0);
    run('kept', net, 1);
    inv.removeRun('empty');
    expect(inv.runs().map((r) => r.runId)).toEqual(['kept']);
    expect(inv.list()).toHaveLength(1);
    inv.close();
  });

  it('records runs and removes assets', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    const a = inv.upsert(host({}), 'r', net);
    inv.recordRun({
      runId: 'r',
      networkId: net,
      targets: '192.0.2.0/24',
      startedAt: '2026-11-02T00:00:00Z',
      finishedAt: '2026-11-02T00:01:00Z',
      status: 'done',
      scanned: 254,
      live: 1,
      newAssets: 1,
      openPorts: 0,
      risks: 0,
    });
    expect(inv.runs()[0]?.live).toBe(1);
    expect(inv.runs()[0]?.networkId).toBe(net);
    inv.remove(a.id);
    expect(inv.list()).toHaveLength(0);
    inv.close();
  });

  it('keeps devices of different networks apart, even on the same subnet', () => {
    const inv = db();
    const a = inv.resolveNetwork(home);
    const b = inv.resolveNetwork(office);
    expect(a.id).not.toBe(b.id);
    expect(a.name).toBe('192.0.2.0/24');
    inv.upsert(host({ ip: '192.0.2.10', mac: 'aa:aa:aa:aa:aa:01' }), 'r1', a.id);
    inv.upsert(host({ ip: '192.0.2.10', mac: 'bb:bb:bb:bb:bb:01' }), 'r2', b.id);
    // The same laptop on both networks is kept once per network.
    inv.upsert(host({ ip: '192.0.2.31', mac: 'cc:cc:cc:cc:cc:01' }), 'r1', a.id);
    inv.upsert(host({ ip: '192.0.2.31', mac: 'cc:cc:cc:cc:cc:01' }), 'r2', b.id);
    expect(inv.list().filter((x) => x.networkId === a.id)).toHaveLength(2);
    expect(inv.list().filter((x) => x.networkId === b.id)).toHaveLength(2);
    expect(inv.resolveNetwork(home).id).toBe(a.id);
    inv.close();
  });

  it('puts a scan that cannot read MACs on the known network of that subnet, keeping each MAC', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    const nas = inv.upsert(host({ ip: '192.0.2.191', mac: '00:11:32:00:00:01', vendor: 'Synology' }), 'r1', net);
    const blind = { fingerprint: 'subnet:192.0.2.0/24', cidr: '192.0.2.0/24', local: true };
    expect(inv.resolveNetwork(blind).id).toBe(net);
    const again = inv.upsert(host({ ip: '192.0.2.191' }), 'r2', net);
    expect(again.id).toBe(nas.id);
    expect(again.mac).toBe('00:11:32:00:00:01');
    expect(again.vendor).toBe('Synology');
    expect(inv.list()).toHaveLength(1);
    // A later scan that sees the MAC still finds the same device.
    expect(inv.upsert(host({ ip: '192.0.2.191', mac: '00:11:32:00:00:01' }), 'r3', net).id).toBe(nas.id);
    expect(inv.networks()).toHaveLength(1);
    inv.close();
  });

  it('keeps identify evidence, and the type it gave, when a later scan does not collect it', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    const printer = host({ ip: '192.0.2.42', mac: 'aa:bb:cc:00:00:42', ports: ports(80), observed: { services: ['_pdl-datastream._tcp'] } });
    Object.assign(printer, classify(printer, []));
    expect(inv.upsert(printer, 'r1', net).type).toBe('printer');
    const later = host({ ip: '192.0.2.42', mac: 'aa:bb:cc:00:00:42', ports: ports(80) });
    Object.assign(later, classify(later, []));
    expect(later.type).not.toBe('printer');
    const kept = inv.upsert(later, 'r2', net);
    expect(kept.type).toBe('printer');
    expect(kept.observed).toEqual({ services: ['_pdl-datastream._tcp'] });
    inv.close();
  });

  it('does not carry evidence onto a device known only by an address that may have changed hands', () => {
    const inv = db();
    const net = inv.resolveNetwork(home).id;
    const first = host({ ip: '192.0.2.60', ports: ports(80), observed: { services: ['_pdl-datastream._tcp'] } });
    Object.assign(first, classify(first, []));
    inv.upsert(first, 'r1', net);
    const other = host({ ip: '192.0.2.60', ports: ports(22) });
    Object.assign(other, classify(other, []));
    const stored = inv.upsert(other, 'r2', net);
    expect(stored.observed).toBeUndefined();
    expect(stored.type).not.toBe('printer');
    inv.close();
  });

  it('keeps a subnet-only network when two known networks share the subnet', () => {
    const inv = db();
    const a = inv.resolveNetwork(home).id;
    const b = inv.resolveNetwork(office).id;
    const blind = inv.resolveNetwork({ fingerprint: 'subnet:192.0.2.0/24', cidr: '192.0.2.0/24', local: true }).id;
    expect([a, b]).not.toContain(blind);
    inv.close();
  });

  it('adopts a subnet-only network once its router is identified, and renames and removes networks', () => {
    const inv = db();
    const first = inv.resolveNetwork({ fingerprint: 'subnet:192.0.2.0/24', cidr: '192.0.2.0/24', local: true });
    const later = inv.resolveNetwork(home);
    expect(later.id).toBe(first.id);
    expect(later.gatewayMac).toBe(home.gatewayMac);
    expect(inv.renameNetwork(first.id, 'Home').name).toBe('Home');
    inv.upsert(host({}), 'r', first.id);
    inv.removeNetwork(first.id);
    expect(inv.networks()).toHaveLength(0);
    expect(inv.list()).toHaveLength(0);
    inv.close();
  });

  it('drops a network whose scan found nothing, and lets any scan of a migrated range adopt it', () => {
    const inv = db();
    const empty = inv.resolveNetwork({ fingerprint: 'range:172.16.4.0/24', cidr: '172.16.4.0/24', local: false });
    expect(inv.removeNetworkIfEmpty(empty.id)).toBe(true);
    const kept = inv.resolveNetwork(home);
    inv.upsert(host({}), 'r', kept.id);
    expect(inv.removeNetworkIfEmpty(kept.id)).toBe(false);
    expect(inv.networks().map((n) => n.id)).toEqual([kept.id]);
    inv.close();
  });

  it('moves devices from a version 1 database into networks named after their scan targets', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'inv-')), 'inventory.db');
    const raw = new DatabaseSync(path);
    raw.exec(`
      create table assets (id text primary key, key text not null unique, ip text not null, mac text, data text not null,
        first_seen text not null, last_seen text not null, first_run_id text not null, last_run_id text not null);
      create table scan_runs (id text primary key, targets text not null, started_at text not null, finished_at text not null,
        status text not null, scanned integer not null, live integer not null, new_assets integer not null,
        open_ports integer not null, risks integer not null);
      insert into scan_runs values ('r1', '10.0.0.0/24', '2026-11-01T00:00:00Z', '2026-11-01T00:01:00Z', 'done', 254, 1, 1, 0, 0);
      insert into scan_runs values ('r2', '192.168.0.0/23', '2026-11-02T00:00:00Z', '2026-11-02T00:01:00Z', 'done', 510, 1, 1, 0, 0);
      pragma user_version = 1;
    `);
    const ins = raw.prepare('insert into assets values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run('a1', 'ip:10.0.0.5', '10.0.0.5', null, JSON.stringify(host({ ip: '10.0.0.5' })), 't', 't', 'r1', 'r1');
    ins.run('a2', 'ip:192.168.0.9', '192.168.0.9', null, JSON.stringify(host({ ip: '192.168.0.9' })), 't', 't', 'r2', 'r2');
    raw.close();

    const inv = new Inventory(path);
    const nets = inv.networks();
    expect(nets.map((n) => n.name).sort()).toEqual(['10.0.0.0/24', '192.168.0.0/23']);
    const byName = Object.fromEntries(nets.map((n) => [n.name, n.id]));
    expect(inv.list().find((a) => a.id === 'a1')?.networkId).toBe(byName['10.0.0.0/24']);
    expect(inv.runs().find((r) => r.runId === 'r2')?.networkId).toBe(byName['192.168.0.0/23']);
    // A later scan of the same subnet with the router identified joins the migrated network.
    expect(inv.resolveNetwork({ ...home, cidr: '10.0.0.0/24' }).id).toBe(byName['10.0.0.0/24']);
    inv.close();
  });

  it('exports CSV with quoting and formula protection', () => {
    const inv = db();
    const net = inv.resolveNetwork(home);
    const a = inv.upsert(host({ hostname: '=cmd|calc', vendor: 'Brother Industries, LTD.', ports: ports(80, 9100) }), 'r', net.id);
    const [head, row] = assetsToCsv([a], { [net.id]: 'Home' }).trim().split('\r\n');
    expect(head?.startsWith('Network,Name,IP address,IPv6 addresses,MAC address')).toBe(true);
    expect(row?.startsWith(`Home,"'=cmd|calc"`)).toBe(true);
    expect(row).toContain('"Brother Industries, LTD."');
    expect(row).toContain('80/http 9100/jetdirect');
    inv.close();
  });
});

describe('wifi', () => {
  it('maps generations and Windows signal percentages', () => {
    expect(generationOf(['ax', 'ac', 'n'])).toBe(6);
    expect(generationOf('be')).toBe(7);
    expect(generationOf(['g', 'b'])).toBeUndefined();
    expect(percentToDbm(100)).toBe(-50);
    expect(percentToDbm(60)).toBe(-70);
  });

  it('normalises the macOS helper report', () => {
    const r = fromHelper({
      location: 'authorized',
      connection: { interface: 'en0', poweredOn: true, ssid: 'Studio', bssid: 'fa:d0:e:c0:1b:ab', rssi: -61, noise: -92, channel: { number: 157, band: '5', width: 80 }, txRateMbps: 864, phy: 'ax', security: 'WPA2/WPA3' },
      networks: [
        { ssid: 'Studio', bssid: 'fa:d0:e:c0:1b:ab', rssi: -61, noise: -92, channel: { number: 157, band: '5', width: 80 }, security: ['WPA2/WPA3'], phy: ['ax', 'ac', 'n', 'a'] },
        { ssid: null, bssid: null, rssi: -80, noise: -90, channel: { number: 6, band: '2.4', width: 20 }, security: ['WPA2'], phy: ['n', 'g'] },
      ],
      error: null,
    });
    expect(r.location).toBe('authorized');
    expect(r.connection).toMatchObject({ ssid: 'Studio', bssid: 'fa:d0:0e:c0:1b:ab', generation: 6, channel: { number: 157, band: '5', width: 80 } });
    expect(r.networks[1]).toMatchObject({ ssid: undefined, generation: 4, channel: { band: '2.4' } });
    // A zero reading during a scan falls back to the access point's own entry.
    const busy = fromHelper({
      location: 'authorized',
      connection: { interface: 'en0', poweredOn: true, ssid: 'Studio', bssid: 'fa:d0:0e:c0:1b:ab', rssi: 0, noise: -92, channel: { number: 157 }, txRateMbps: 0 },
      networks: [{ ssid: 'Studio', bssid: 'fa:d0:0e:c0:1b:ab', rssi: -58, noise: -92, channel: { number: 157 }, security: [], phy: [] }],
    });
    expect(busy.connection?.rssi).toBe(-58);
  });

  it('parses netsh network lists in English and Spanish', () => {
    const en = [
      'SSID 1 : Studio',
      '    Network type            : Infrastructure',
      '    Authentication          : WPA2-Personal',
      '    Encryption              : CCMP',
      '    BSSID 1                 : fa:d0:0e:c0:1b:ab',
      '         Signal             : 80%',
      '         Radio type         : 802.11ax',
      '         Band               : 5 GHz',
      '         Channel            : 157',
      '         Bss Load:',
      '             Connected Stations:        3',
      '             Channel Utilization:       45 (17 %)',
      '         Basic rates (Mbps) : 6 12 24',
      '',
      'SSID 2 : ',
      '    Authentication          : Open',
      '    BSSID 1                 : 12:36:aa:c0:10:a0',
      '         Signal             : 30%',
      '         Radio type         : 802.11n',
      '         Band               : 2.4 GHz',
      '         Channel            : 11',
    ].join('\r\n');
    const nets = parseNetshNetworks(en);
    expect(nets).toHaveLength(2);
    expect(nets[0]).toMatchObject({ ssid: 'Studio', bssid: 'fa:d0:0e:c0:1b:ab', rssi: -60, phy: ['ax'], generation: 6, security: ['WPA2'], channel: { number: 157, band: '5' } });
    expect(nets[1]).toMatchObject({ ssid: undefined, security: ['Open'], channel: { number: 11, band: '2.4' } });

    const es = [
      'SSID 1 : Oficina',
      '    Tipo de red             : Infraestructura',
      '    Autenticación           : WPA3-Personal',
      '    BSSID 1                 : 48:b4:c3:c0:12:a2',
      '         Señal              : 92%',
      '         Tipo de radio      : 802.11be',
      '         Banda              : 6 GHz',
      '         Canal              : 37',
    ].join('\r\n');
    expect(parseNetshNetworks(es)[0]).toMatchObject({ ssid: 'Oficina', security: ['WPA3'], generation: 7, channel: { number: 37, band: '6' } });
  });

  it('parses the current netsh connection and detects the Location requirement', () => {
    const out = [
      '    Name                   : Wi-Fi',
      '    State                  : connected',
      '    SSID                   : Studio',
      '    AP BSSID               : fa:d0:0e:c0:1b:ab',
      '    Band                   : 5 GHz',
      '    Channel                : 157',
      '    Radio type             : 802.11ax',
      '    Authentication         : WPA3-Personal',
      '    Receive rate (Mbps)    : 1201',
      '    Transmit rate (Mbps)   : 864',
      '    Signal                 : 78%',
    ].join('\r\n');
    expect(parseNetshInterface(out)).toMatchObject({ interface: 'Wi-Fi', ssid: 'Studio', rssi: -61, generation: 6, txRateMbps: 1201, channel: { number: 157, band: '5' }, security: 'WPA3' });
    expect(parseNetshInterface('There is 1 interface on the system:\r\n    State : disconnected')).toBeUndefined();
    expect(netshNeedsLocation('Network shell commands need location permission to access WLAN information.')).toBe(true);
  });
});

describe('MAC recovery pass', () => {
  const host = (ip: string, mac?: string): DiscoveredHost => ({
    ip,
    mac,
    names: [],
    aliveVia: ['tcp'],
    ports: [],
    type: 'unknown',
    typeConfidence: 0,
    evidence: [],
    risks: [],
  });

  it('asks again only for live hosts on the attached subnet that have no MAC', () => {
    const own = new Map([['10.0.0.50', 'aa:aa:aa:aa:aa:aa']]);
    const hosts = [host('10.0.0.191'), host('10.0.0.1', 'bc:24:11:00:00:01'), host('10.0.0.50'), host('192.168.5.9')];
    expect(macGaps(hosts, '10.0.0.0/24', own).map((h) => h.ip)).toEqual(['10.0.0.191']);
  });
});

describe('port scan scheduling', () => {
  const live = (ip: string, open: number[] = []): DiscoveredHost => ({
    ip,
    names: [],
    aliveVia: ['icmp'],
    ports: open.map((port) => ({ port, service: '' })),
    type: 'unknown',
    typeConfidence: 0,
    evidence: [],
    risks: [],
  });

  it('waits ten times the ping time, within the floor and the profile limit', () => {
    expect(new PortWait(900, 5).ms).toBe(MIN_PORT_WAIT_MS);
    expect(new PortWait(900, 50).ms).toBe(500);
    expect(new PortWait(900, 400).ms).toBe(900);
  });

  it('gives a slow-answering host more time, and waits the full limit until a host without ping answers', () => {
    const w = new PortWait(900, 5);
    w.answered(120);
    expect(w.ms).toBe(480);
    const blind = new PortWait(900);
    expect(blind.ms).toBe(900);
    blind.answered(10);
    expect(blind.ms).toBe(MIN_PORT_WAIT_MS);
  });

  it('spreads checks port by port across hosts and skips ports already known open', () => {
    const hosts = [live('10.0.0.1', [22]), live('10.0.0.2')];
    const checks = [...portChecks(hosts, [22, 80, 443])].map(([h, p]) => `${h.ip}:${p}`);
    expect(checks).toEqual(['10.0.0.2:22', '10.0.0.1:80', '10.0.0.2:80', '10.0.0.1:443', '10.0.0.2:443']);
    expect(countPortChecks(hosts, [22, 80, 443])).toBe(checks.length);
  });

  it('closes a waiting connection as soon as the scan is stopped', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const probe = tcpProbe('192.0.2.1', 9, 10_000, stop.signal);
    setTimeout(() => stop.abort(), 50);
    expect(['silent', 'unreachable']).toContain(await probe);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('identify interfaces', () => {
  const lan = { name: 'en0', address: '10.0.0.91', cidr: '10.0.0.0/24', ipv6: [] };
  const vpn = { name: 'utun3', address: '172.16.5.2', cidr: '172.16.5.0/24', ipv6: [] };
  const live = (ip: string): DiscoveredHost => ({ ip, names: [], aliveVia: ['icmp'], ports: [], type: 'unknown', typeConfidence: 0, evidence: [], risks: [] });
  const names = (list: { name?: string }[]) => list.map((i) => i.name);

  it('uses each interface on the same subnet as live devices, also for a single address', () => {
    expect(names(identifyInterfaces([vpn, lan], [live('10.0.0.29')]))).toEqual(['en0']);
    expect(names(identifyInterfaces([lan, vpn], [live('172.16.5.40'), live('10.0.0.8')]))).toEqual(['en0', 'utun3']);
  });

  it('skips the network-wide queries for a remote network or when only this computer answered', () => {
    expect(identifyInterfaces([lan], [live('192.168.50.10')])).toEqual([]);
    expect(identifyInterfaces([lan], [live('10.0.0.91')])).toEqual([]);
  });
});
