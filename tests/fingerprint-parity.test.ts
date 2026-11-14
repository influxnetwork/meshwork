/**
 * The fingerprint engine must classify exactly as the reference classifier in tests/reference, on
 * thousands of generated devices. Results only change on purpose, with a new rules version.
 */
import { describe, expect, it } from 'vitest';
import type { DiscoveredHost } from '../src/shared/types';
import { announcedType, classifyHost } from '../src/shared/fingerprint';
import { classify } from '../src/scanner/analysis';
import { neighbourType } from '../src/renderer/src/map-model';
import { referenceClassify, referenceNeighbourType } from './reference/classify';

/** Small seeded generator, so a failure can be reproduced. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VENDORS = [
  undefined,
  'Private address',
  'Acme Widgets',
  'Ubiquiti Inc',
  'Aruba, a Hewlett Packard Enterprise Company',
  'Hewlett Packard Enterprise',
  'HP Inc.',
  'Hewlett-Packard Company',
  'Brother Industries, LTD.',
  'Cisco Systems, Inc',
  'Routerboard.com',
  'TP-LINK TECHNOLOGIES CO.,LTD.',
  'Fortinet, Inc.',
  'Netgate',
  'Ruckus Wireless',
  'eero inc.',
  'Hangzhou Hikvision Digital Technology Co.,Ltd.',
  'Synology Incorporated',
  'Espressif Inc.',
  'Raspberry Pi Trading Ltd',
  'Sonos, Inc.',
  'Samsung Electronics Co.,Ltd',
  'Apple, Inc.',
  'Proxmox Server Solutions GmbH',
  'VMware, Inc.',
  'Dell Inc.',
  'Nokia Corporation',
  '',
  '  Apple, Inc.',
  'Société Générale de Réseaux',
];
const PORTS = [
  21, 22, 23, 53, 80, 88, 135, 139, 389, 443, 445, 515, 548, 554, 631, 1433, 1883, 3306, 3389, 5000, 5001, 5432, 5683, 5900, 5985, 6379,
  7000, 8009, 8080, 8123, 8291, 8554, 8728, 8883, 9000, 9100, 27017, 62078,
];
const NAMES = [undefined, 'iPad-de-Alex', 'Sam-iPhone', 'galaxy-s21', 'Pixel-7', 'Alex-MacBook-Pro', 'office-laptop', 'iMac-Studio', 'printer1', 'core-sw', 'ThinkPad-X1', 'mac-mini'];
// The ping parser gives whole numbers from 0 to 255; odd values are included to pin the bounds.
const TTLS = [undefined, 0, 1, 32, 63, 64, 65, 100, 127, 128, 129, 200, 255, 0.5, 63.9, 64.5, 128.5, Number.NaN, Number.POSITIVE_INFINITY];
const MACS = ['aa:bb:cc:00:00:01', '00:0c:29:01:02:03', '00:0C:29:01:02:03', 'bc:24:11:aa:bb:cc', 'BC:24:11:AA:BB:CC', undefined];

type NameStyle = 'both' | 'hostname' | 'mdns' | 'many' | 'empty';
const NAME_STYLES: NameStyle[] = ['both', 'hostname', 'mdns', 'many', 'empty'];

function makeHost(
  ip: string,
  vendor: string | undefined,
  open: number[],
  name: string | undefined,
  ttl: number | undefined,
  mac: string | undefined,
  style: NameStyle = 'both',
): DiscoveredHost {
  const names: DiscoveredHost['names'] = !name
    ? []
    : style === 'hostname'
      ? []
      : style === 'many'
        ? [{ source: 'dns', name: 'host-17.lan' }, { source: 'netbios', name: name.toUpperCase() }]
        : style === 'empty'
          ? [{ source: 'dns', name: '' }]
          : [{ source: 'mdns', name: `${name}.local` }];
  return {
    ip,
    mac,
    vendor,
    hostname: style === 'mdns' || style === 'many' ? undefined : style === 'empty' ? '' : name,
    names,
    aliveVia: ['icmp'],
    ttl,
    ports: open.map((port) => ({ port, service: '' })),
    type: 'unknown',
    typeConfidence: 0,
    evidence: [],
    risks: [],
  };
}

function* corpus(): Generator<[DiscoveredHost, string[]]> {
  const gw = ['192.0.2.1'];
  const GATEWAY_LISTS = [gw, [], ['192.0.2.254', '192.0.2.1'], ['198.51.100.1']];
  // Every vendor with every single port, as gateway and not.
  for (const vendor of VENDORS)
    for (const p of [undefined, ...PORTS])
      for (const ip of ['192.0.2.1', '192.0.2.50']) yield [makeHost(ip, vendor, p ? [p] : [], undefined, 64, 'aa:bb:cc:00:00:01'), gw];
  // Random mixes of everything.
  const r = random(20261106);
  const pick = <T,>(list: T[]) => list[Math.floor(r() * list.length)] as T;
  for (let i = 0; i < 40_000; i++) {
    const open = PORTS.filter(() => r() < 0.12);
    yield [makeHost(r() < 0.2 ? '192.0.2.1' : '192.0.2.77', pick(VENDORS), open, pick(NAMES), pick(TTLS), pick(MACS), pick(NAME_STYLES)), pick(GATEWAY_LISTS)];
  }
}

const describeHost = (h: DiscoveredHost) => ({ ip: h.ip, vendor: h.vendor, ports: h.ports.map((p) => p.port), name: h.hostname, ttl: h.ttl, mac: h.mac });

describe('fingerprint parity with the previous rules', () => {
  it('classifies every generated device exactly as before: type, confidence, OS and reasons', () => {
    let checked = 0;
    for (const [host, gateways] of corpus()) {
      const before = referenceClassify(host, gateways);
      const { fingerprint: _version, ...after } = classifyHost(host, gateways);
      // Compared as JSON so an OS confidence left undefined matches one that is absent.
      if (JSON.stringify(after) !== JSON.stringify(before)) expect({ host: describeHost(host), result: after }).toEqual({ host: describeHost(host), result: before });
      checked++;
    }
    expect(checked).toBeGreaterThan(40_000);
  });

  it('is wired into the scanner and the map, and records the rules version', () => {
    const host = makeHost('192.0.2.9', 'Brother Industries, LTD.', [80, 9100], undefined, 64, 'aa:bb:cc:00:00:01');
    expect(classify(host, [])).toEqual(classifyHost(host, []));
    expect(classify(host, []).fingerprint).toMatch(/^rules-\d+$/);
  });

  it('reads announced names and descriptions exactly as before', () => {
    const words = ['', 'Linux 4.19.152-ui-alpine #4.19.152 SMP aarch64', 'HPE Networking Instant On Access Point 2x2 Wi-Fi 6 Indoor (US) AP22', 'Cisco IOS Software, C2960 Software\nSWITCH', 'ui-alpine', 'UniFi OS', 'Dream Machine', 'Cloud Gateway', 'UDM', 'UDR', 'UCG', 'UXG', 'Access Point', 'AP22', 'WiFi', 'Wi-Fi', 'wireless', 'WLAN',
      'switch', 'GS308', 'SG300', 'Catalyst', 'ProCurve', 'router', 'gateway', 'firewall', 'IP Phone', 'VoIP', 'Linux 5.4', 'Debian', 'udmx', 'apx'];
    let checked = 0;
    for (const a of words)
      for (const b of words) {
        for (const [name, descr] of [[a, b], [a, undefined], [undefined, b]] as const) {
          expect(announcedType(name, descr), `${name} | ${descr}`).toBe(referenceNeighbourType(name, descr));
          expect(neighbourType(name, descr)).toBe(announcedType(name, descr));
          checked++;
        }
      }
    expect(checked).toBe(words.length * words.length * 3);
  });
});
