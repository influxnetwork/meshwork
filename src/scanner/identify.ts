/**
 * Per-device collectors of the identify phase. Each asks one open port what it is, reads a small,
 * capped amount, and gives up quietly: on a timeout (counted from the start, not from the last
 * byte), on Stop, or on any error. None of them sends more than a plain request.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import type { Observed, ObservedField } from '@shared/fingerprint/types';

/** Sent as the User-Agent of web requests, so device logs show who asked. */
const USER_AGENT = 'Meshwork network inventory';
/** Most of a web page read while looking for its title. */
const MAX_PAGE_BYTES = 64 * 1024;
/** Most bytes read while waiting for an SSH greeting. */
const MAX_GREETING_BYTES = 2048;
/** Longest text kept from any collector. */
const MAX_TEXT = 160;

/** Text kept from a device: on one line (control characters and runs of spaces become one space) and capped. */
export const clip = (s: string) =>
  s
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);

const NAME_CHAR = /[a-z0-9_.-]/;

/**
 * Lower case for ASCII letters only. Unlike toLowerCase it never changes the length (some letters,
 * such as "İ", grow), so positions found in it are positions in the original text.
 */
export const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

/**
 * Content of the first element called `name` (any namespace prefix, any case) in a document. It
 * searches forward only and gives up at the first opening tag that has no end, so hostile input
 * costs linear time.
 */
export function elementText(doc: string, name: string, lower = asciiLower(doc)): string | undefined {
  const n = name.toLowerCase();
  for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, i + n.length)) {
    const after = lower[i + n.length];
    if (after !== '>' && after !== '/' && !/\s/.test(after ?? '')) continue;
    let lt = i - 1;
    if (lower[lt] === ':') {
      lt--;
      const stop = Math.max(0, lt - 32);
      while (lt > stop && NAME_CHAR.test(lower[lt] as string)) lt--;
    }
    if (lower[lt] !== '<') continue;
    const gt = lower.indexOf('>', i);
    if (gt < 0) return undefined;
    if (lower[gt - 1] === '/') return '';
    for (let c = lower.indexOf('</', gt); c >= 0; c = lower.indexOf('</', c + 2)) {
      let k = c + 2;
      // A namespace prefix is short: look for its colon only in the next few characters.
      const colon = lower.slice(k, k + 33).indexOf(':') + k;
      if (colon > k && lower.slice(k, colon).split('').every((ch) => NAME_CHAR.test(ch))) k = colon + 1;
      if (lower.startsWith(n, k) && (lower[k + n.length] === '>' || /\s/.test(lower[k + n.length] ?? ''))) return doc.slice(gt + 1, c);
    }
    return undefined;
  }
  return undefined;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Markup text with entities decoded and runs of white space collapsed to one space. */
export function markupText(raw: string): string {
  return raw
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => String.fromCodePoint(Math.min(parseInt(h, 16), 0x10ffff)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => String.fromCodePoint(Math.min(Number(d), 0x10ffff)))
    .replace(/&([a-z]+);/gi, (all, name: string) => ENTITIES[name.toLowerCase()] ?? all)
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text of the page's <title>, with entities decoded and spaces collapsed; undefined when absent or empty. */
export function parseTitle(html: string): string | undefined {
  const raw = elementText(html, 'title');
  const text = raw ? markupText(raw) : '';
  return text ? clip(text) : undefined;
}

/** The "SSH-…" identification line of a server's first bytes; lines before it are ignored. */
export function parseSshGreeting(text: string): string | undefined {
  const line = text.split(/\r?\n/).find((l) => l.startsWith('SSH-'));
  return line ? clip(line.trim()) : undefined;
}

/** "CN=…, O=…, OU=…" from the parts of a certificate name; undefined when it has none. */
export function certificateName(name: Record<string, string | string[] | undefined> | undefined): string | undefined {
  if (!name) return undefined;
  const parts = ['CN', 'O', 'OU']
    .map((k) => {
      const v = name[k];
      const text = Array.isArray(v) ? v.join('+') : v;
      return text ? `${k}=${text}` : undefined;
    })
    .filter(Boolean);
  return parts.length ? clip(parts.join(', ')) : undefined;
}

/**
 * Resolves once with the first value given to `finish`, after `timeoutMs`, or when `signal`
 * aborts; the cleanup that `start` returns runs exactly once either way.
 */
function settle<T>(timeoutMs: number, signal: AbortSignal | undefined, start: (finish: (v: T | undefined) => void) => () => void): Promise<T | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    let done = false;
    let cleanup: (() => void) | undefined;
    const finish = (v: T | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      cleanup?.();
      resolve(v);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      cleanup = start(finish);
    } catch {
      finish(undefined);
      return;
    }
    // A collector that finished while starting still has to release its socket.
    if (done) cleanup();
  });
}

export interface HttpInfo {
  title?: string;
  server?: string;
}

/**
 * TLS settings for devices on a local network: many cameras and printers only speak old protocol
 * versions. Only names are read from these connections; nothing secret is sent. Cipher strings are
 * left at the default: the app's TLS library rejects some OpenSSL-only settings.
 */
const LEGACY_TLS = { rejectUnauthorized: false, minVersion: 'TLSv1' as const };

/**
 * Title and Server header of the page at "/" on one port, from a GET that follows at most one
 * redirect, and only to the same device and port. Certificates are not checked: devices on a
 * local network mostly use self-signed ones.
 */
export function httpInfo(ip: string, port: number, tls: boolean, timeoutMs: number, signal?: AbortSignal): Promise<HttpInfo | undefined> {
  return settle<HttpInfo>(timeoutMs, signal, (finish) => {
    const request = tls ? httpsRequest : httpRequest;
    let server: string | undefined;
    let current: ReturnType<typeof request> | undefined;
    const get = (path: string, redirectsLeft: number) => {
      let body = '';
      const result = (): HttpInfo | undefined => {
        const title = parseTitle(body);
        return title || server ? { ...(title ? { title } : {}), ...(server ? { server } : {}) } : undefined;
      };
      current = request(
        { host: ip, port, path, method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', Connection: 'close' }, ...LEGACY_TLS },
        (res: IncomingMessage) => {
          const header = res.headers.server;
          if (!server && typeof header === 'string' && header.trim()) server = clip(header);
          const status = res.statusCode ?? 0;
          const location = res.headers.location;
          if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
            const next = sameDevicePath(location, ip, port, tls);
            // The redirect's own body is not wanted: its connection is closed before the next one.
            current?.destroy();
            if (next) return get(next, redirectsLeft - 1);
            return finish(result());
          }
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            body += chunk;
            if (body.length >= MAX_PAGE_BYTES) {
              body = body.slice(0, MAX_PAGE_BYTES);
              return finish(result());
            }
            // Only the newly arrived text can complete the title.
            if (body.slice(-(chunk.length + 8)).toLowerCase().includes('</title')) finish(result());
          });
          res.on('end', () => finish(result()));
          res.on('error', () => finish(result()));
        },
      );
      current.on('error', () => finish(server ? { server } : undefined));
      current.end();
    };
    get('/', 1);
    return () => current?.destroy();
  });
}

/** Path of a redirect target when it stays on the same device, port and protocol; undefined otherwise. */
function sameDevicePath(location: string, ip: string, port: number, tls: boolean): string | undefined {
  try {
    const base = new URL(`${tls ? 'https' : 'http'}://${ip}:${port}/`);
    const url = new URL(location, base);
    return url.protocol === base.protocol && url.hostname === base.hostname && url.port === base.port ? `${url.pathname}${url.search}` : undefined;
  } catch {
    return undefined;
  }
}

export interface CertificateInfo {
  subject?: string;
  issuer?: string;
}

/** Subject and issuer of the certificate a TLS port presents; the connection closes after the handshake. */
export function tlsCertificate(ip: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<CertificateInfo | undefined> {
  return settle<CertificateInfo>(timeoutMs, signal, (finish) => {
    const socket = tlsConnect({ host: ip, port, ...LEGACY_TLS });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      const subject = certificateName(cert?.subject as unknown as Record<string, string | string[]>);
      const issuer = certificateName(cert?.issuer as unknown as Record<string, string | string[]>);
      finish(subject || issuer ? { ...(subject ? { subject } : {}), ...(issuer ? { issuer } : {}) } : undefined);
    });
    socket.on('error', () => finish(undefined));
    return () => socket.destroy();
  });
}

/** The identification line an SSH server sends first; nothing is sent to it. */
export function sshGreeting(ip: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  return settle<string>(timeoutMs, signal, (finish) => {
    const socket = new Socket();
    let text = '';
    socket.setEncoding('latin1');
    socket.on('data', (chunk: string) => {
      text += chunk;
      const line = /\r?\n/.test(text) ? parseSshGreeting(text) : undefined;
      if (line || text.length >= MAX_GREETING_BYTES) finish(line ?? parseSshGreeting(text));
    });
    socket.on('end', () => finish(parseSshGreeting(text)));
    socket.on('error', () => finish(undefined));
    socket.connect(port, ip);
    return () => socket.destroy();
  });
}

/** Plain and secure web ports and the SSH port the identify phase asks, in order of preference. */
const HTTP_PORTS = [80, 8080, 8000, 81, 8081, 8888, 7080];
const HTTPS_PORTS = [443, 8443, 4443, 5001, 9443];
const SSH_PORT = 22;

/** The open ports one device is asked on: at most one plain web, one secure web and the SSH port. */
export function identifyPorts(open: number[]): { http?: number; https?: number; ssh?: number } {
  const has = new Set(open);
  const http = HTTP_PORTS.find((p) => has.has(p));
  const https = HTTPS_PORTS.find((p) => has.has(p));
  return { ...(http ? { http } : {}), ...(https ? { https } : {}), ...(has.has(SSH_PORT) ? { ssh: SSH_PORT } : {}) };
}

/** What the collectors found for one device. */
export interface Findings {
  services?: string[];
  upnp?: { deviceType?: string; manufacturer?: string; model?: string; friendlyName?: string; server?: string };
  onvif?: string[];
  http?: HttpInfo[];
  tls?: CertificateInfo;
  ssh?: string;
}

/** The device's evidence by field, without repeats; undefined when no collector found anything. */
export function buildObserved(f: Findings): Observed | undefined {
  const out: Observed = {};
  const put = (field: ObservedField, values: (string | undefined)[]) => {
    const list = [...new Set(values.filter((v): v is string => !!v))];
    if (list.length) out[field] = list;
  };
  put('services', f.services ?? []);
  put('upnp.deviceType', [f.upnp?.deviceType]);
  put('upnp.manufacturer', [f.upnp?.manufacturer]);
  put('upnp.model', [f.upnp?.model]);
  put('upnp.friendlyName', [f.upnp?.friendlyName]);
  put('onvif', f.onvif ?? []);
  put('http.title', (f.http ?? []).map((h) => h.title));
  // The UPnP search reply carries a Server header too: it describes the same software.
  put('http.server', [...(f.http ?? []).map((h) => h.server), f.upnp?.server]);
  put('tls.subject', [f.tls?.subject]);
  put('tls.issuer', [f.tls?.issuer]);
  put('ssh', [f.ssh]);
  return Object.keys(out).length ? out : undefined;
}
