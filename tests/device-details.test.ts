import { describe, expect, it } from 'vitest';
import { deviceDetailsText } from '../src/shared/device-details';

describe('device details text', () => {
  it('lists identity, discovery, what the device reports and where it is plugged in', () => {
    const text = deviceDetailsText({
      name: 'ap-lobby',
      ip: '10.0.0.40',
      mac: 'aa:bb:cc:00:00:01',
      vendor: 'Hewlett Packard Enterprise',
      type: 'Access point',
      scanType: 'Printer',
      confidence: 0.7,
      names: [{ source: 'mdns', name: 'ap-lobby.local' }],
      aliveVia: ['icmp', 'tcp'],
      rttMs: 3,
      ttl: 64,
      ports: [{ port: 443, service: 'https' }],
      evidence: ['vendor makes access points'],
      fingerprint: 'rules-1',
      gear: { source: 'lldp', name: 'ap-lobby', description: 'Instant  On\nAP22' },
      connection: { path: 'sw-core gi7 › Gateway', switchName: 'sw-core', switchPort: 'gi7', vlan: 10, poeWatts: 6.2, confirmed: true },
    });
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        'Device: ap-lobby',
        'MAC address: aa:bb:cc:00:00:01',
        'Type: Access point (the scan guessed Printer, 70% confidence)',
        'Names: ap-lobby.local (mDNS)',
        'Answered by: ping, TCP, 3 ms, TTL 64',
        'Open ports: 443/https',
        'Description over LLDP: Instant On AP22',
        'Connected to: sw-core port gi7',
        'PoE: 6.2 W',
        'Path: sw-core gi7 › Gateway',
        '- vendor makes access points',
        'Classified with: rules-1',
      ]),
    );
  });

  it('leaves out what is unknown and marks an assumed link', () => {
    const text = deviceDetailsText({ name: 'Unmanaged segment', type: 'Switch', connection: { path: 'sw gi3', confirmed: false } });
    expect(text).toBe('Device: Unmanaged segment\nType: Switch\nPath: sw gi3 (assumed)');
  });
});

describe('identify evidence in device details', () => {
  it('names the model and maker a device reports, preferring its own description', async () => {
    const { reportedIdentity } = await import('../src/shared/device-details');
    expect(reportedIdentity({ 'upnp.model': ['Sonos Era 300 S41'], 'upnp.manufacturer': ['Sonos, Inc.'], onvif: ['hardware/X1'] })).toEqual({
      model: 'Sonos Era 300 S41',
      manufacturer: 'Sonos, Inc.',
      source: 'UPnP',
    });
    expect(reportedIdentity({ onvif: ['tdn:NetworkVideoTransmitter', 'hardware/DWC-MT95Wi28TW', 'name/Lobby'] })).toEqual({ model: 'DWC-MT95Wi28TW', source: 'ONVIF' });
    expect(reportedIdentity({ ssh: ['SSH-2.0-dropbear'] })).toBeUndefined();
    expect(reportedIdentity(undefined)).toBeUndefined();
  });

  it('lists the evidence in the copied text', () => {
    const text = deviceDetailsText({
      name: 'cam',
      type: 'Camera',
      observed: {
        services: ['_http._tcp'],
        'upnp.deviceType': ['urn:schemas-upnp-org:device:Basic:1'],
        'upnp.manufacturer': ['Acme'],
        'upnp.model': ['C1'],
        onvif: ['tdn:NetworkVideoTransmitter', 'hardware/C1'],
        'http.title': ['Camera login'],
        'http.server': ['Boa/0.94'],
        'tls.subject': ['CN=cam, O=Acme'],
        ssh: ['SSH-2.0-dropbear_2019.78'],
      },
    });
    expect(text.split('\n')).toEqual(
      expect.arrayContaining([
        'Announces: _http._tcp',
        'UPnP: urn:schemas-upnp-org:device:Basic:1 · Acme · C1',
        'ONVIF: tdn:NetworkVideoTransmitter, hardware/C1',
        'Web page: Camera login · Boa/0.94',
        'Certificate: CN=cam, O=Acme',
        'SSH: SSH-2.0-dropbear_2019.78',
      ]),
    );
  });
});
