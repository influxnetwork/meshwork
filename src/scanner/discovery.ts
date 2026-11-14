/**
 * Network-wide collectors of the identify phase. Each sends one multicast query on the local
 * network, gathers the replies for a short time, and maps them to the address that answered. A
 * UPnP description is fetched only from the device that announced it.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { request as httpRequest } from 'node:http';
import dnsPacket from 'dns-packet';
import { asciiLower, clip, elementText, markupText } from './identify';

/** Where a query is sent; tests point it at a local responder. */
export interface Target {
  address: string;
  port: number;
}

const MDNS: Target = { address: '224.0.0.251', port: 5353 };
const SSDP: Target = { address: '239.255.255.250', port: 1900 };
const WS_DISCOVERY: Target = { address: '239.255.255.250', port: 3702 };

/** Most replies kept from one query, from one address, and most bytes kept in all. */
const MAX_REPLIES = 2048;
const MAX_REPLIES_PER_ADDRESS = 8;
const MAX_REPLY_BYTES = 16 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
/** Most values kept per device. */
const MAX_VALUES = 30;
/** UPnP descriptions fetched at the same time. */
const DESCRIPTION_FETCHES = 8;
/** Largest UPnP description read. */
const MAX_DESCRIPTION_BYTES = 64 * 1024;
/** Time allowed to fetch one UPnP description. */
const DESCRIPTION_MS = 2000;

interface Reply {
  address: string;
  data: Buffer;
}

/**
 * Sends one datagram and collects every reply for `timeoutMs`, or until `signal` aborts. Replies
 * come back to the socket's own port, which keeps responders answering this query only.
 */
function exchange(message: Buffer, target: Target, timeoutMs: number, signal?: AbortSignal, localAddress?: string, ttl = 2): Promise<Reply[]> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve([]);
    const replies: Reply[] = [];
    const perAddress = new Map<string, number>();
    let bytes = 0;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(replies);
    };
    const timer = setTimeout(finish, timeoutMs);
    signal?.addEventListener('abort', finish, { once: true });
    socket.on('error', finish);
    // Replies are capped per address, in size and in total, so a noisy or hostile device cannot
    // flood the scan with work.
    socket.on('message', (data, rinfo) => {
      const seen = perAddress.get(rinfo.address) ?? 0;
      if (replies.length >= MAX_REPLIES || seen >= MAX_REPLIES_PER_ADDRESS || bytes >= MAX_TOTAL_BYTES) return;
      const kept = data.length > MAX_REPLY_BYTES ? data.subarray(0, MAX_REPLY_BYTES) : data;
      perAddress.set(rinfo.address, seen + 1);
      bytes += kept.length;
      replies.push({ address: rinfo.address, data: kept });
    });
    socket.bind(0, localAddress, () => {
      try {
        if (localAddress) socket.setMulticastInterface(localAddress);
        socket.setMulticastTTL(ttl);
      } catch {
        /* not every platform allows these on every interface; the default route is used then */
      }
      try {
        socket.send(message, target.port, target.address, (err) => {
          if (err) finish();
        });
      } catch {
        finish();
      }
    });
  });
}

/** Adds values for an address, without repeats and up to MAX_VALUES. */
function addValues(map: Map<string, string[]>, address: string, values: string[]) {
  const list = map.get(address) ?? [];
  for (const v of values) if (!list.includes(v) && list.length < MAX_VALUES) list.push(v);
  if (list.length) map.set(address, list);
}

/* ------------------------------------------------------------------ mDNS */

const SERVICE_LIST = '_services._dns-sd._udp.local';

/** Service types ("_ipp._tcp") an mDNS packet lists in answer to the service enumeration query. */
export function mdnsServiceTypes(packet: Buffer): string[] {
  try {
    const decoded = dnsPacket.decode(packet);
    const records = [...(decoded.answers ?? []), ...(decoded.additionals ?? [])];
    const types = records
      .map((r) => ({ type: r.type, name: r.name, data: (r as { data?: unknown }).data }))
      .filter((r) => r.type === 'PTR' && r.name.toLowerCase() === SERVICE_LIST && typeof r.data === 'string')
      .map((r) => clip((r.data as string).replace(/\.local\.?$/i, '')));
    return [...new Set(types)].slice(0, MAX_VALUES);
  } catch {
    return [];
  }
}

/** Service types each device announces over mDNS, by address. */
export async function mdnsServices(timeoutMs: number, signal?: AbortSignal, target: Target = MDNS, localAddress?: string): Promise<Map<string, string[]>> {
  const query = dnsPacket.encode({ type: 'query', id: randomInt(1, 65535), flags: 0, questions: [{ type: 'PTR', name: SERVICE_LIST, class: 'IN' }] });
  const found = new Map<string, string[]>();
  for (const r of await exchange(query, target, timeoutMs, signal, localAddress, 255)) {
    if (signal?.aborted) break;
    addValues(found, r.address, mdnsServiceTypes(r.data));
  }
  return found;
}

/* ------------------------------------------------------------------ SSDP / UPnP */

/** Location and Server header of an SSDP search reply; undefined for anything else. */
export function parseSsdpResponse(text: string): { location: string; server?: string } | undefined {
  if (!/^HTTP\/1\.\d 200/i.test(text)) return undefined;
  const header = (name: string) => new RegExp(`^${name}:[ \\t]*(.+)$`, 'im').exec(text)?.[1]?.trim();
  const location = header('location');
  if (!location) return undefined;
  const server = header('server');
  return { location, ...(server ? { server: clip(server) } : {}) };
}

export interface UpnpDevice {
  deviceType?: string;
  friendlyName?: string;
  manufacturer?: string;
  model?: string;
  /** SERVER header of the search reply. */
  server?: string;
}

/** Type, name, manufacturer and model of the root device of a UPnP description. */
export function parseUpnpDescription(xml: string): UpnpDevice | undefined {
  const lowerAll = asciiLower(xml);
  let start = -1;
  for (let i = lowerAll.indexOf('<device'); i >= 0; i = lowerAll.indexOf('<device', i + 7)) {
    const after = lowerAll[i + 7];
    if (after === '>' || after === ' ' || after === '\t' || after === '\n' || after === '\r') {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  // Only the root device: its embedded devices come after <deviceList>.
  const rest = xml.slice(start);
  const lowerRest = lowerAll.slice(start);
  const cut = [lowerRest.indexOf('<devicelist'), lowerRest.indexOf('</device>')].filter((n) => n >= 0);
  const root = cut.length ? rest.slice(0, Math.min(...cut)) : rest;
  const lowerRoot = asciiLower(root);
  const tag = (name: string) => {
    const raw = elementText(root, name, lowerRoot);
    const text = raw ? markupText(raw) : '';
    return text ? clip(text) : undefined;
  };
  const name = tag('modelName');
  const number = tag('modelNumber');
  // The number is added only when it is not already part of the name, or the name of it (some
  // makers repeat the name and the firmware there).
  const related = name && number && (name.includes(number) || number.includes(name));
  const model = name && number && !related ? clip(`${name} ${number}`) : (name ?? number);
  const device: UpnpDevice = {};
  const deviceType = tag('deviceType');
  const friendlyName = tag('friendlyName');
  const manufacturer = tag('manufacturer');
  if (deviceType) device.deviceType = deviceType;
  if (friendlyName) device.friendlyName = friendlyName;
  if (manufacturer) device.manufacturer = manufacturer;
  if (model) device.model = model;
  return Object.keys(device).length ? device : undefined;
}

/** GETs a small text document; undefined on any error, a non-200 answer, or when it is too large. */
function fetchText(url: URL, timeoutMs: number, signal?: AbortSignal): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(undefined);
    let done = false;
    const finish = (v: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      req.destroy();
      resolve(v);
    };
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const req = httpRequest(url, { headers: { 'User-Agent': 'Meshwork network inventory', Connection: 'close' } }, (res) => {
      if (res.statusCode !== 200) return finish(undefined);
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_DESCRIPTION_BYTES) finish(undefined);
      });
      res.on('end', () => finish(body));
      res.on('error', () => finish(undefined));
    });
    req.on('error', () => finish(undefined));
    req.end();
  });
}

/**
 * Root device description of each device that answers an SSDP search, by address. The
 * description is fetched only over plain HTTP from the address that answered.
 */
export async function ssdpDiscover(
  timeoutMs: number,
  signal?: AbortSignal,
  target: Target = SSDP,
  localAddress?: string,
  /** Addresses in the scan; descriptions are fetched only from these. Undefined allows any. */
  allow?: Set<string>,
): Promise<Map<string, UpnpDevice>> {
  const search = Buffer.from(
    `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.address}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 1\r\nST: ssdp:all\r\nUSER-AGENT: Meshwork network inventory\r\n\r\n`,
  );
  const locations = new Map<string, { url: URL; server?: string }>();
  for (const r of await exchange(search, target, timeoutMs, signal, localAddress)) {
    if (signal?.aborted) break;
    if (locations.has(r.address) || (allow && !allow.has(r.address))) continue;
    const reply = parseSsdpResponse(r.data.toString('latin1'));
    if (!reply) continue;
    let url: URL;
    try {
      url = new URL(reply.location);
    } catch {
      continue;
    }
    // A device may only point at itself.
    if (url.protocol !== 'http:' || url.hostname !== r.address) continue;
    locations.set(r.address, { url, server: reply.server });
  }
  const found = new Map<string, UpnpDevice>();
  const queue = [...locations];
  const worker = async () => {
    for (let next = queue.shift(); next && !signal?.aborted; next = queue.shift()) {
      const [address, { url, server }] = next;
      const xml = await fetchText(url, DESCRIPTION_MS, signal);
      const device = { ...(xml ? parseUpnpDescription(xml) : undefined), ...(server ? { server } : {}) };
      if (Object.keys(device).length) found.set(address, device);
    }
  };
  await Promise.all(Array.from({ length: Math.min(DESCRIPTION_FETCHES, queue.length) }, worker));
  return found;
}

/* ------------------------------------------------------------------ ONVIF */

/** Types and ONVIF scopes ("hardware/…", "name/…") of a WS-Discovery probe match. */
export function parseOnvifMatch(xml: string): string[] {
  const lower = asciiLower(xml);
  const types = elementText(xml, 'Types', lower)?.trim().split(/\s+/) ?? [];
  const scopes = (elementText(xml, 'Scopes', lower)?.trim().split(/\s+/) ?? [])
    .filter((v) => v.startsWith('onvif://www.onvif.org/'))
    .map((v) => {
      const path = v.slice('onvif://www.onvif.org/'.length);
      try {
        return decodeURIComponent(path);
      } catch {
        return path;
      }
    });
  return [...types, ...scopes]
    .filter(Boolean)
    .map(clip)
    .filter(Boolean)
    .slice(0, MAX_VALUES);
}

/** What each camera or recorder that answers an ONVIF probe says it is, by address. */
export async function onvifDiscover(timeoutMs: number, signal?: AbortSignal, target: Target = WS_DISCOVERY, localAddress?: string): Promise<Map<string, string[]>> {
  const probe = Buffer.from(
    '<?xml version="1.0" encoding="UTF-8"?>' +
      '<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ' +
      'xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">' +
      `<e:Header><w:MessageID>uuid:${randomUUID()}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
      '<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>' +
      '<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>',
  );
  const found = new Map<string, string[]>();
  for (const r of await exchange(probe, target, timeoutMs, signal, localAddress)) {
    if (signal?.aborted) break;
    addValues(found, r.address, parseOnvifMatch(r.data.toString('utf8')));
  }
  return found;
}
