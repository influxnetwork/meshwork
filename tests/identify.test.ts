/** Per-device collectors of the identify phase: web page, TLS certificate and SSH greeting. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttp, type Server as HttpServer } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createTcp, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { certificateName, httpInfo, parseSshGreeting, parseTitle, sshGreeting, tlsCertificate } from '../src/scanner/identify';

/**
 * A throwaway self-signed certificate for the HTTPS test server, made with the openssl command
 * line tool at test time so no private key is stored in the repository.
 */
function selfSignedCertificate(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), 'meshwork-tls-'));
  try {
    const key = join(dir, 'key.pem');
    const cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=cam-lobby.example/O=Example Cameras Inc/OU=IP Camera'], { stdio: 'ignore' });
    return { key: readFileSync(key), cert: readFileSync(cert) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const portOf = (s: { address(): AddressInfo | string | null }) => (s.address() as AddressInfo).port;

describe('page title and greeting parsing', () => {
  it('reads the page title, decoding entities and collapsing spaces', () => {
    expect(parseTitle('<html><head><TITLE>\n  RouterOS  &amp; WebFig  </TITLE></head>')).toBe('RouterOS & WebFig');
    expect(parseTitle('<title lang="en">Synology&nbsp;DiskStation</title>')).toBe('Synology DiskStation');
    expect(parseTitle('<title>&#72;ello &#x57;orld</title>')).toBe('Hello World');
    expect(parseTitle('<html><body>no title</body></html>')).toBeUndefined();
    expect(parseTitle('<title>   </title>')).toBeUndefined();
    expect(parseTitle(`<title>${'x'.repeat(500)}</title>`)).toHaveLength(160);
  });

  it('reads the SSH greeting line only', () => {
    expect(parseSshGreeting('SSH-2.0-dropbear_2022.83\r\n')).toBe('SSH-2.0-dropbear_2022.83');
    expect(parseSshGreeting('Welcome banner\r\nSSH-2.0-Cisco-1.25\r\n')).toBe('SSH-2.0-Cisco-1.25');
    expect(parseSshGreeting('HTTP/1.1 400 Bad Request\r\n')).toBeUndefined();
    expect(parseSshGreeting('')).toBeUndefined();
  });

  it('formats certificate names from their parts', () => {
    expect(certificateName({ CN: 'cam-lobby', O: 'Example Cameras Inc', OU: 'IP Camera' })).toBe('CN=cam-lobby, O=Example Cameras Inc, OU=IP Camera');
    expect(certificateName({ O: ['A', 'B'] })).toBe('O=A+B');
    expect(certificateName({})).toBeUndefined();
    expect(certificateName(undefined)).toBeUndefined();
  });
});

describe('collectors against local servers', () => {
  let web: HttpServer;
  let secure: HttpServer;
  let ssh: Server;
  let silent: Server;
  let huge: HttpServer;
  const seen: string[] = [];

  beforeAll(async () => {
    web = createHttp((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers['user-agent'] ?? ''}`);
      res.setHeader('Server', 'lighttpd/1.4.59');
      res.end('<html><head><title>NVR Login</title></head></html>');
    });
    secure = createHttps(selfSignedCertificate(), (_req, res) => {
      res.setHeader('Server', 'Boa/0.94');
      res.end('<title>IP Camera</title>');
    });
    huge = createHttp((_req, res) => {
      res.write('<html>');
      const chunk = 'x'.repeat(64 * 1024);
      const timer = setInterval(() => res.write(chunk), 1);
      res.on('close', () => clearInterval(timer));
    });
    ssh = createTcp((socket) => socket.end('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n'));
    silent = createTcp(() => {
      /* accepts and never answers */
    });
    await Promise.all([web, secure, huge, ssh, silent].map((s) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()))));
  });

  afterAll(() => {
    for (const s of [web, secure, huge, ssh, silent]) s.close();
  });

  it('reads the title and Server header of a web page with one plain GET', async () => {
    expect(await httpInfo('127.0.0.1', portOf(web), false, 2000)).toEqual({ title: 'NVR Login', server: 'lighttpd/1.4.59' });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^GET \/ Meshwork/);
  });

  it('reads a page and the certificate over HTTPS, accepting self-signed certificates', async () => {
    expect(await httpInfo('127.0.0.1', portOf(secure), true, 2000)).toEqual({ title: 'IP Camera', server: 'Boa/0.94' });
    expect(await tlsCertificate('127.0.0.1', portOf(secure), 2000)).toEqual({
      subject: 'CN=cam-lobby.example, O=Example Cameras Inc, OU=IP Camera',
      issuer: 'CN=cam-lobby.example, O=Example Cameras Inc, OU=IP Camera',
    });
  });

  it('reads the SSH greeting', async () => {
    expect(await sshGreeting('127.0.0.1', portOf(ssh), 2000)).toBe('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13');
  });

  it('gives up quietly on silent or closed ports, within the timeout', async () => {
    const started = Date.now();
    expect(await sshGreeting('127.0.0.1', portOf(silent), 300)).toBeUndefined();
    expect(await httpInfo('127.0.0.1', portOf(silent), false, 300)).toBeUndefined();
    expect(await tlsCertificate('127.0.0.1', portOf(silent), 300)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await httpInfo('127.0.0.1', 1, false, 300)).toBeUndefined();
  });

  it('stops reading a page that never ends', async () => {
    const started = Date.now();
    expect(await httpInfo('127.0.0.1', portOf(huge), false, 3000)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it('stops at once when the scan is stopped', async () => {
    const stop = new AbortController();
    const started = Date.now();
    const pending = sshGreeting('127.0.0.1', portOf(silent), 10_000, stop.signal);
    setTimeout(() => stop.abort(), 50);
    expect(await pending).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('evidence of one device', () => {
  it('gathers what each collector found under its field, leaving out what found nothing', async () => {
    const { buildObserved, identifyPorts } = await import('../src/scanner/identify');
    expect(
      buildObserved({
        services: ['_ipp._tcp'],
        upnp: { deviceType: 'urn:x:device:Printer:1', manufacturer: 'Acme', model: 'P1', friendlyName: 'Office printer', server: 'Linux UPnP/1.0' },
        onvif: [],
        http: [{ title: 'Printer home', server: 'nginx' }, { title: 'Printer home' }],
        tls: { subject: 'CN=printer', issuer: 'O=Acme' },
        ssh: undefined,
      }),
    ).toEqual({
      services: ['_ipp._tcp'],
      'upnp.deviceType': ['urn:x:device:Printer:1'],
      'upnp.manufacturer': ['Acme'],
      'upnp.model': ['P1'],
      'upnp.friendlyName': ['Office printer'],
      'http.title': ['Printer home'],
      'http.server': ['nginx', 'Linux UPnP/1.0'],
      'tls.subject': ['CN=printer'],
      'tls.issuer': ['O=Acme'],
    });
    expect(buildObserved({})).toBeUndefined();
  });

  it('picks at most one plain web port, one secure web port and the SSH port to ask', async () => {
    const { identifyPorts } = await import('../src/scanner/identify');
    expect(identifyPorts([22, 80, 443, 8080, 8443])).toEqual({ http: 80, https: 443, ssh: 22 });
    expect(identifyPorts([8080, 5001])).toEqual({ http: 8080, https: 5001 });
    expect(identifyPorts([3389])).toEqual({});
  });
});
