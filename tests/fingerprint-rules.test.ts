/** One case per rule: the device that makes it fire, and what it concludes. */
import { describe, expect, it } from 'vitest';
import type { DeviceType, DiscoveredHost } from '../src/shared/types';
import { announcedVerdict, HOST_RULES, hostVerdict, NEIGHBOUR_RULES } from '../src/shared/fingerprint';

interface HostCase {
  host: Partial<DiscoveredHost> & { open?: number[] };
  gateway?: boolean;
  type?: DeviceType;
  os?: string;
}

const host = ({ open = [], ...partial }: HostCase['host']): DiscoveredHost => ({
  ip: '192.0.2.50',
  names: [],
  aliveVia: ['icmp'],
  ports: open.map((port) => ({ port, service: '' })),
  type: 'unknown',
  typeConfidence: 0,
  evidence: [],
  risks: [],
  ...partial,
});

const HOST_CASES: Record<string, HostCase> = {
  vm: { host: { mac: '00:0c:29:01:02:03' }, type: 'vm' },
  'printer-ports': { host: { open: [9100] }, type: 'printer' },
  'printer-vendor-web': { host: { vendor: 'HP Inc.', open: [443] }, type: 'printer' },
  camera: { host: { open: [554] }, type: 'camera' },
  storage: { host: { open: [445, 5000, 5001] }, type: 'storage' },
  iot: { host: { vendor: 'Espressif Inc.' }, type: 'iot' },
  tv: { host: { open: [8009] }, type: 'tv' },
  'firewall-vendor': { host: { vendor: 'Fortinet, Inc.' }, type: 'firewall', os: 'Network OS' },
  'network-dns': { host: { vendor: 'Ubiquiti Inc', open: [53] }, type: 'router', os: 'Network OS' },
  'network-gateway': { host: { vendor: 'Cisco Systems, Inc' }, gateway: true, type: 'router', os: 'Network OS' },
  'network-ap': { host: { vendor: 'Ruckus Wireless' }, type: 'ap', os: 'Network OS' },
  'network-switch': { host: { vendor: 'Cisco Systems, Inc' }, type: 'switch', os: 'Network OS' },
  'gateway-service': { host: { open: [80] }, gateway: true, type: 'router' },
  'apple-sync-tablet': { host: { open: [62078], hostname: 'iPad-Alex' }, type: 'tablet', os: 'iPadOS' },
  'apple-sync-phone': { host: { open: [62078] }, type: 'phone', os: 'iOS' },
  'phone-name': { host: { hostname: 'galaxy-s21' }, type: 'phone' },
  'voip-phone': { host: { vendor: 'Poly', open: [80, 443, 5060] }, type: 'phone' },
  'windows-server-ttl': { host: { open: [3389, 1433], ttl: 128 }, type: 'server', os: 'Windows' },
  'windows-server': { host: { open: [3389, 389] }, type: 'server', os: 'Windows' },
  'windows-computer-ttl': { host: { open: [135, 445], ttl: 128 }, type: 'computer', os: 'Windows' },
  'windows-computer': { host: { open: [5985] }, type: 'computer', os: 'Windows' },
  'apple-laptop': { host: { vendor: 'Apple, Inc.', open: [22], hostname: 'Alex-MacBook-Air' }, type: 'laptop', os: 'macOS' },
  'apple-computer': { host: { vendor: 'Apple, Inc.', open: [548] }, type: 'computer', os: 'macOS' },
  'laptop-name': { host: { hostname: 'ThinkPad-X1' }, type: 'laptop' },
  'server-fallback': { host: { open: [22, 5432] }, type: 'server', os: 'Linux / Unix-like' },
  'os-ttl-unix': { host: { ttl: 64 }, os: 'Linux / Unix-like' },
  'os-ttl-windows': { host: { ttl: 128 }, os: 'Windows' },
  'os-ttl-network': { host: { ttl: 255 }, os: 'Network OS' },
  'os-server-ssh': { host: { open: [22, 5432] }, os: 'Linux / Unix-like' },
  // rules-2: evidence from the identify phase.
  'onvif-camera': { host: { observed: { onvif: ['tdn:NetworkVideoTransmitter', 'hardware/C500'] } }, type: 'camera' },
  'mdns-printer': { host: { observed: { services: ['_ipp._tcp', '_pdl-datastream._tcp'] } }, type: 'printer' },
  'mdns-print-service': { host: { observed: { services: ['_ipp._tcp', '_ipps._tcp'] } }, type: 'printer' },
  'upnp-printer': { host: { observed: { 'upnp.deviceType': ['urn:schemas-upnp-org:device:Printer:1'] } }, type: 'printer' },
  'upnp-storage': { host: { observed: { 'upnp.manufacturer': ['Synology'] } }, type: 'storage' },
  'upnp-media': { host: { observed: { 'upnp.deviceType': ['urn:schemas-upnp-org:device:MediaRenderer:1'] } }, type: 'tv' },
  'upnp-zone-player': { host: { observed: { 'upnp.deviceType': ['urn:schemas-upnp-org:device:ZonePlayer:1'] } }, type: 'tv' },
  'mdns-media': { host: { observed: { services: ['_googlecast._tcp'] } }, type: 'tv' },
  'tls-signage': { host: { observed: { 'tls.subject': ['CN=brightsign-x.local, O=BrightSign LLC, OU=Control'] } }, type: 'tv' },
  'tls-server-management': { host: { observed: { 'tls.subject': ['CN=idrac-EXAMPLE1, O=Dell Inc., OU=Remote Access Group'] } }, type: 'server' },
  'tls-ap-portal': { host: { observed: { 'tls.subject': ['CN=captive-2022.aio.cloudauth.net, O=Hewlett Packard Enterprise Company'] } }, type: 'ap' },
  'web-firewall': { host: { observed: { 'http.title': ['pfSense - Login'] } }, type: 'firewall', os: 'Network OS' },
  'web-router': { host: { observed: { 'http.title': ['OpenWrt - LuCI'] } }, type: 'router', os: 'Network OS' },
  'mdns-smart-home': { host: { observed: { services: ['_smartthings._tcp'] } }, type: 'iot' },
  'mdns-home-accessory': { host: { observed: { services: ['_hap._tcp'] } }, type: 'iot' },
  'web-smart-home': { host: { observed: { 'http.server': ['ShellyHTTP/1.0.0'] } }, type: 'iot' },
  'web-embedded': { host: { observed: { 'http.server': ['GoAhead-Webs'] } }, type: 'iot' },
  'ssh-network-os': { host: { observed: { ssh: ['SSH-2.0-Cisco-1.25'] } }, os: 'Network OS' },
  'ssh-windows': { host: { observed: { ssh: ['SSH-2.0-OpenSSH_for_Windows_9.5'] } }, os: 'Windows' },
  'ssh-linux': { host: { observed: { ssh: ['SSH-2.0-OpenSSH_10.0p2 Debian-7'] } }, os: 'Linux / Unix-like' },
};

const NEIGHBOUR_CASES: Record<string, { name?: string; descr?: string; type: DeviceType }> = {
  'announced-console': { name: 'gw', descr: 'Linux 4.19.152-ui-alpine', type: 'router' },
  'announced-ap': { name: 'WAP-01', descr: 'Instant On Access Point AP22', type: 'ap' },
  'announced-switch': { descr: 'Cisco SG300-28 Managed Switch', type: 'switch' },
  'announced-router': { descr: 'Edge router', type: 'router' },
  'announced-phone': { descr: 'IP Phone 7841', type: 'phone' },
};

describe('device rules', () => {
  for (const [id, c] of Object.entries(HOST_CASES)) {
    it(`${id} fires and concludes ${[c.type, c.os].filter(Boolean).join(' / ')}`, () => {
      const h = host(c.host);
      const v = hostVerdict(h, c.gateway ? [h.ip] : []);
      expect(v.matched).toContain(id);
      if (c.type) expect(v.type).toBe(c.type);
      if (c.os) expect(v.os).toBe(c.os);
    });
  }

  it('has a case for every rule', () => {
    expect(HOST_RULES.rules.map((r) => r.id).sort()).toEqual(Object.keys(HOST_CASES).sort());
  });
});

describe('identify evidence against weaker clues', () => {
  it('a camera that answers ONVIF beats a storage-like port set', () => {
    const v = hostVerdict(host({ open: [445, 5000, 5001], observed: { onvif: ['tdn:NetworkVideoTransmitter'] } }), []);
    expect(v.type).toBe('camera');
    expect(v.why[0]).toMatch(/ONVIF/);
  });

  it('a storage device that also answers device discovery is not taken for a camera', () => {
    const v = hostVerdict(host({ vendor: 'Synology Incorporated', observed: { onvif: ['wsdp:Device', 'pub:Computer'], 'upnp.manufacturer': ['Synology'] } }), []);
    expect(v.type).toBe('storage');
  });

  it('a Mac announcing AirPlay stays a computer, not a media player', () => {
    const v = hostVerdict(host({ vendor: 'Apple, Inc.', open: [22, 445], observed: { services: ['_airplay._tcp', '_raop._tcp', '_companion-link._tcp'] } }), []);
    expect(v.type).toBe('computer');
  });

  it('the SSH greeting names the OS before the TTL guess does', () => {
    const v = hostVerdict(host({ ttl: 64, observed: { ssh: ['SSH-2.0-OpenSSH_for_Windows_9.5'] } }), []);
    expect(v.os).toBe('Windows');
    expect(v.why.join(' ')).not.toMatch(/TTL/);
  });

  it('a Mac or Linux desktop sharing a printer stays a computer', () => {
    const mac = hostVerdict(host({ vendor: 'Apple, Inc.', open: [22, 445, 548], observed: { services: ['_ipp._tcp', '_ipps._tcp', '_printer._tcp'] } }), []);
    expect(mac.type).toBe('computer');
    const linux = hostVerdict(host({ open: [22, 631], observed: { services: ['_ipp._tcp'] } }), []);
    expect(linux.matched).not.toContain('mdns-print-service');
  });

  it('a Windows PC that shares media stays a computer', () => {
    const v = hostVerdict(host({ open: [135, 445, 3389], observed: { 'upnp.deviceType': ['urn:schemas-upnp-org:device:MediaRenderer:1'] } }), []);
    expect(v.type).toBe('computer');
  });

  it('router software on a switch or access point does not make it a router', () => {
    const sw = hostVerdict(host({ vendor: 'Routerboard.com', observed: { ssh: ['SSH-2.0-ROSSSH'], 'http.title': ['RouterOS router configuration page'] } }), []);
    expect(sw.type).toBe('switch');
    expect(sw.os).toBe('Network OS');
    const console = hostVerdict(host({ observed: { 'http.title': ['UniFi OS'] } }), []);
    expect(console.matched).not.toContain('web-router');
  });

  it('a storage maker\'s router is not taken for storage', () => {
    const v = hostVerdict(host({ observed: { 'upnp.manufacturer': ['Synology'], 'upnp.deviceType': ['urn:schemas-upnp-org:device:InternetGatewayDevice:1'] } }), []);
    expect(v.type).not.toBe('storage');
  });

  it('an Apple TV or mesh router announcing HomeKit or Matter is not taken for a smart home gadget', () => {
    const v = hostVerdict(host({ vendor: 'Apple, Inc.', observed: { services: ['_hap._tcp', '_matter._tcp', '_airplay._tcp'] } }), []);
    expect(v.type).not.toBe('iot');
    const mesh = hostVerdict(host({ vendor: 'eero inc.', open: [53, 80], observed: { services: ['_matter._tcp', '_hap._udp'] } }), []);
    expect(mesh.type).not.toBe('iot');
    const cast = hostVerdict(host({ observed: { services: ['_googlecast._tcp', '_matter._tcp'] } }), []);
    expect(cast.type).toBe('tv');
  });

  it('a firewall keeps a network OS even when its SSH greeting names the Unix it runs on', () => {
    const v = hostVerdict(host({ observed: { 'http.title': ['pfSense - Login'], ssh: ['SSH-2.0-OpenSSH_9.7 FreeBSD-20240318'] } }), []);
    expect(v.type).toBe('firewall');
    expect(v.os).toBe('Network OS');
  });

  it('general-purpose web servers are not taken for embedded devices', () => {
    for (const server of ['Mongoose/6.18', 'thttpd/2.29', 'mini_httpd/1.30']) expect(hostVerdict(host({ observed: { 'http.server': [server] } }), []).type, server).toBe('unknown');
  });

  it('IP desk phones are phones, while computers and phone systems that speak SIP are not', () => {
    expect(hostVerdict(host({ vendor: 'YEALINK(XIAMEN) NETWORK TECHNOLOGY CO.,LTD.', open: [443, 5061] }), []).type).toBe('phone');
    expect(hostVerdict(host({ vendor: 'Polycom', open: [80, 5060] }), []).type).toBe('phone');
    expect(hostVerdict(host({ vendor: 'Dell Inc.', ttl: 128, open: [135, 445, 5060] }), []).type).toBe('computer');
    expect(hostVerdict(host({ vendor: 'Dell Inc.', open: [22, 5060] }), []).type).not.toBe('phone');
    expect(hostVerdict(host({ vendor: 'Poly', open: [443] }), []).type).not.toBe('phone');
  });

  it('records the new rules version', () => {
    expect(HOST_RULES.version).toBe('rules-3');
  });
});

describe('announced device rules', () => {
  for (const [id, c] of Object.entries(NEIGHBOUR_CASES)) {
    it(`${id} fires and concludes ${c.type}`, () => {
      const v = announcedVerdict(c.name, c.descr);
      expect(v.matched).toEqual([id]);
      expect(v.type).toBe(c.type);
    });
  }

  it('has a case for every rule', () => {
    expect(NEIGHBOUR_RULES.rules.map((r) => r.id).sort()).toEqual(Object.keys(NEIGHBOUR_CASES).sort());
  });
});
