/** Collectors facing hostile or unusual devices: bounded time and size, safe text, no crashes. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import type { AddressInfo } from 'node:net';
import { clip, httpInfo, parseTitle } from '../src/scanner/identify';
import { onvifDiscover, parseOnvifMatch, parseUpnpDescription, ssdpDiscover } from '../src/scanner/discovery';

const time = (fn: () => unknown) => {
  const t = performance.now();
  fn();
  return performance.now() - t;
};

describe('parsers on hostile input', () => {
  const big = (unit: string) => unit.repeat(Math.ceil(65_000 / unit.length));

  it('read titles and descriptions in linear time, even without closing tags', () => {
    for (const input of [big('<title>'), big('<title '), big('<TITLE>x'), `<title>${big('</a')}`]) expect(time(() => parseTitle(input))).toBeLessThan(40);
    for (const input of [big('<device '), big('<device><modelName>'), big('<deviceType>')]) expect(time(() => parseUpnpDescription(input))).toBeLessThan(40);
    for (const input of [big('<Types '), big('<d:Types>'), big('<Scopes>onvif://www.onvif.org/x ')]) expect(time(() => parseOnvifMatch(input))).toBeLessThan(40);
  });

  it('still reads well-formed documents', () => {
    expect(parseTitle('</title><title>Real</title>')).toBe('Real');
    expect(parseTitle('<title>Página de configuración</title>')).toBe('Página de configuración');
    expect(parseUpnpDescription('<root><device><modelName>A1</modelName></device></root>')).toEqual({ model: 'A1' });
    expect(parseOnvifMatch('<d:ProbeMatch><d:Types>dn:NetworkVideoTransmitter</d:Types></d:ProbeMatch>')).toEqual(['dn:NetworkVideoTransmitter']);
  });

  it('reads titles that contain letters whose lower case is longer', () => {
    expect(parseTitle('<title>İstanbul Router</title>')).toBe('İstanbul Router');
    expect(parseTitle('<!-- İİİİ --><title>Real</title>')).toBe('Real');
    expect(parseUpnpDescription('<root><!-- İİ --><device><modelName>İ-Cam 2</modelName></device></root>')).toEqual({ model: 'İ-Cam 2' });
  });

  it('keeps collected text on one line, so it cannot forge lines in copied details', () => {
    expect(clip('CN=cam\nWhy this type:\r\n- printer')).toBe('CN=cam Why this type: - printer');
    expect(clip('a\u0000\u0007b')).toBe('a b');
  });
});

describe('web pages from unusual devices', () => {
  let web: Server;
  let port = 0;
  beforeAll(async () => {
    web = createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(302, { Location: '/login.html', Server: 'Embedded/1.0' });
        return res.end();
      }
      if (req.url === '/login.html') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end('<title>Cámara IP – inicio</title>');
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
    port = (web.address() as AddressInfo).port;
  });
  afterAll(() => web.close());

  it('follows one redirect on the same device and decodes UTF-8 titles', async () => {
    expect(await httpInfo('127.0.0.1', port, false, 2000)).toEqual({ title: 'Cámara IP – inicio', server: 'Embedded/1.0' });
  });
});

describe('network-wide queries facing a noisy or hostile network', () => {
  let udp: Socket;
  let web: Server;
  let udpPort = 0;
  let webPort = 0;
  let fetched = 0;

  beforeAll(async () => {
    web = createServer((_req, res) => {
      fetched++;
      res.end('<root><device><modelName>X</modelName></device></root>');
    });
    await new Promise<void>((r) => web.listen(0, '127.0.0.1', () => r()));
    webPort = (web.address() as AddressInfo).port;
    udp = createSocket('udp4');
    udp.on('message', (msg, rinfo) => {
      const text = msg.toString('latin1');
      if (text.startsWith('M-SEARCH')) {
        udp.send(`HTTP/1.1 200 OK\r\nLOCATION: http://127.0.0.1:${webPort}/d.xml\r\n\r\n`, rinfo.port, rinfo.address);
      } else {
        // A flood of large, malformed replies from one address.
        const junk = Buffer.from('<Types '.repeat(1200));
        for (let i = 0; i < 400; i++) udp.send(junk, rinfo.port, rinfo.address);
      }
    });
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    udpPort = udp.address().port;
  });
  afterAll(() => {
    udp.close();
    web.close();
  });

  it('survives a flood of malformed replies quickly', async () => {
    const started = Date.now();
    const found = await onvifDiscover(400, undefined, { address: '127.0.0.1', port: udpPort });
    expect(found.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('fetches descriptions only from devices in the scan', async () => {
    fetched = 0;
    const outside = await ssdpDiscover(300, undefined, { address: '127.0.0.1', port: udpPort }, undefined, new Set(['192.0.2.7']));
    expect(outside.size).toBe(0);
    expect(fetched).toBe(0);
    const inside = await ssdpDiscover(300, undefined, { address: '127.0.0.1', port: udpPort }, undefined, new Set(['127.0.0.1']));
    expect(inside.get('127.0.0.1')?.model).toBe('X');
    expect(fetched).toBe(1);
  });
});
