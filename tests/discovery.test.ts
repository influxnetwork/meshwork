/** Network-wide collectors of the identify phase: mDNS services, SSDP/UPnP and ONVIF discovery. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSocket, type Socket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import dnsPacket from 'dns-packet';
import {
  mdnsServiceTypes,
  mdnsServices,
  onvifDiscover,
  parseOnvifMatch,
  parseSsdpResponse,
  parseUpnpDescription,
  ssdpDiscover,
} from '../src/scanner/discovery';

const DESCRIPTION = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>Living Room TV</friendlyName>
    <manufacturer>Example Electronics &amp; Co</manufacturer>
    <modelName>QN65Q80</modelName>
    <modelNumber>2023</modelNumber>
    <deviceList><device><deviceType>urn:schemas-upnp-org:device:Basic:1</deviceType><modelName>Inner</modelName></device></deviceList>
  </device>
</root>`;

const PROBE_MATCH = `<?xml version="1.0" encoding="UTF-8"?>
<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://www.w3.org/2003/05/soap-envelope" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">
<SOAP-ENV:Body><d:ProbeMatches><d:ProbeMatch>
<d:Types>dn:NetworkVideoTransmitter tds:Device</d:Types>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/hardware/DS-2CD2143G2-I onvif://www.onvif.org/name/HIKVISION%20Camera onvif://www.onvif.org/location/city/hangzhou</d:Scopes>
<d:XAddrs>http://192.0.2.64/onvif/device_service</d:XAddrs>
</d:ProbeMatch></d:ProbeMatches></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

describe('discovery reply parsing', () => {
  it('reads the location and server of an SSDP reply', () => {
    const reply = 'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.0.2.20:49152/description.xml\r\nSERVER: Linux/4.4 UPnP/1.0 Example/1.0\r\nST: upnp:rootdevice\r\n\r\n';
    expect(parseSsdpResponse(reply)).toEqual({ location: 'http://192.0.2.20:49152/description.xml', server: 'Linux/4.4 UPnP/1.0 Example/1.0' });
    expect(parseSsdpResponse('NOTIFY * HTTP/1.1\r\n\r\n')).toBeUndefined();
    expect(parseSsdpResponse('garbage')).toBeUndefined();
  });

  it('reads the root device of a UPnP description, decoding entities', () => {
    expect(parseUpnpDescription(DESCRIPTION)).toEqual({
      deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
      friendlyName: 'Living Room TV',
      manufacturer: 'Example Electronics & Co',
      model: 'QN65Q80 2023',
    });
    // A model number that repeats the name (with firmware after it) is not added again.
    expect(parseUpnpDescription('<root><device><modelName>DS620slim</modelName><modelNumber>DS620slim 7.4-90080</modelNumber></device></root>')?.model).toBe('DS620slim');
    expect(parseUpnpDescription('<root><device></device></root>')).toBeUndefined();
    expect(parseUpnpDescription('not xml')).toBeUndefined();
  });

  it('reads the types and scopes of an ONVIF probe match, decoding names', () => {
    expect(parseOnvifMatch(PROBE_MATCH)).toEqual([
      'dn:NetworkVideoTransmitter',
      'tds:Device',
      'type/video_encoder',
      'hardware/DS-2CD2143G2-I',
      'name/HIKVISION Camera',
      'location/city/hangzhou',
    ]);
    expect(parseOnvifMatch('<Envelope/>')).toEqual([]);
  });

  it('lists the service types an mDNS answer announces', () => {
    const packet = dnsPacket.encode({
      type: 'response',
      answers: [
        { type: 'PTR', name: '_services._dns-sd._udp.local', data: '_ipp._tcp.local' },
        { type: 'PTR', name: '_services._dns-sd._udp.local', data: '_airplay._tcp.local' },
        { type: 'A', name: 'printer.local', data: '192.0.2.30' },
      ],
    });
    expect(mdnsServiceTypes(packet)).toEqual(['_ipp._tcp', '_airplay._tcp']);
    expect(mdnsServiceTypes(Buffer.from('broken'))).toEqual([]);
  });
});

describe('discovery against local responders', () => {
  let udp: Socket;
  let web: Server;
  let udpPort = 0;
  let webPort = 0;
  let lastQuery = '';

  beforeAll(async () => {
    web = createServer((req, res) => {
      res.end(req.url === '/description.xml' ? DESCRIPTION : 'no');
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
    webPort = (web.address() as AddressInfo).port;
    udp = createSocket('udp4');
    udp.on('message', (msg, rinfo) => {
      const text = msg.toString('latin1');
      lastQuery = text;
      const reply = (data: Buffer | string) => udp.send(data, rinfo.port, rinfo.address);
      if (text.startsWith('M-SEARCH')) {
        reply(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${webPort}/description.xml\r\nSERVER: Test/1.0\r\nST: ssdp:all\r\n\r\n`);
        // A reply pointing at another host must not be fetched.
        reply('HTTP/1.1 200 OK\r\nLOCATION: http://198.51.100.9/evil.xml\r\nST: ssdp:all\r\n\r\n');
      } else if (text.includes('Probe')) {
        reply(PROBE_MATCH);
      } else {
        reply(dnsPacket.encode({ type: 'response', answers: [{ type: 'PTR', name: '_services._dns-sd._udp.local', data: '_googlecast._tcp.local' }] }));
      }
    });
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    udpPort = udp.address().port;
  });

  afterAll(() => {
    udp.close();
    web.close();
  });

  const target = () => ({ address: '127.0.0.1', port: udpPort });

  it('collects the services each responder announces', async () => {
    const found = await mdnsServices(500, undefined, target());
    expect(found.get('127.0.0.1')).toEqual(['_googlecast._tcp']);
  });

  it('collects UPnP descriptions, fetched only from the device that answered', async () => {
    const found = await ssdpDiscover(800, undefined, target());
    expect(lastQuery).toMatch(/^M-SEARCH \* HTTP\/1\.1\r\n/);
    expect(found.get('127.0.0.1')).toEqual({
      deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1',
      friendlyName: 'Living Room TV',
      manufacturer: 'Example Electronics & Co',
      model: 'QN65Q80 2023',
      server: 'Test/1.0',
    });
    expect([...found.keys()]).toEqual(['127.0.0.1']);
  });

  it('collects ONVIF probe matches', async () => {
    const found = await onvifDiscover(500, undefined, target());
    expect(lastQuery).toContain('NetworkVideoTransmitter');
    expect(found.get('127.0.0.1')).toContain('hardware/DS-2CD2143G2-I');
  });

  it('returns nothing, without failing, when nobody answers or the scan is stopped', async () => {
    const silent = { address: '127.0.0.1', port: 9 };
    expect((await mdnsServices(200, undefined, silent)).size).toBe(0);
    const stop = new AbortController();
    stop.abort();
    expect((await ssdpDiscover(5000, stop.signal, target())).size).toBe(0);
  });
});
