import type { Ipv6Address, Ipv6Scope } from '@shared/types';
import { Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { promises as dnsPromises } from 'node:dns';
import { createSocket } from 'node:dgram';
import { randomInt } from 'node:crypto';
import * as dnsPacket from 'dns-packet';
import { sandboxArpText } from './sandbox-net';

/** Limits how many network operations run at once (sockets and child processes). */
export class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

/**
 * open: the port accepted the connection.
 * closed: the host answered with a reset, so it is up but the port is closed.
 * silent: no answer before the timeout (filtered port or host down).
 * unreachable: the OS reported no route to the host.
 */
export type ProbeResult = 'open' | 'closed' | 'silent' | 'unreachable';

export function tcpProbe(ip: string, port: number, timeoutMs: number, signal?: AbortSignal): Promise<ProbeResult> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve('silent');
    const socket = new Socket();
    let settled = false;
    const onAbort = () => finish('silent');
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(result);
    };
    // Stopping a scan closes the connections still waiting instead of letting them time out.
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish('open'));
    socket.once('timeout', () => finish('silent'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') finish('closed');
      else if (err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' || err.code === 'EHOSTDOWN') finish('unreachable');
      else finish('silent');
    });
    socket.connect(port, ip);
  });
}

export interface PingReply {
  alive: boolean;
  rttMs?: number;
  ttl?: number;
}

/** Runs a command without a shell and collects stdout; resolves on exit or timeout. */
function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = '';
    const child = spawn(cmd, args, { shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: null, out });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

export function parsePingOutput(out: string, code: number | null): PingReply {
  const ttl = /ttl[=:](\d+)/i.exec(out);
  // Read "=13ms" or "<1ms" without the word before it, which Windows translates ("time", "tiempo", "Zeit").
  const time = /[=<]\s*([\d.]+)\s*ms/i.exec(out);
  // Some systems exit 0 for "destination unreachable" replies, so a TTL is required too.
  const alive = code === 0 && ttl !== null;
  return { alive, ttl: ttl ? Number(ttl[1]) : undefined, rttMs: alive && time ? Number(time[1]) : undefined };
}

export async function ping(ip: string, timeoutMs: number): Promise<PingReply> {
  const wait = String(Math.max(200, timeoutMs));
  const args =
    process.platform === 'win32'
      ? ['-n', '1', '-w', wait, ip]
      : process.platform === 'darwin'
        ? ['-c', '1', '-W', wait, ip]
        : ['-c', '1', '-W', String(Math.ceil(timeoutMs / 1000)), ip];
  const cmd = process.platform === 'darwin' ? '/sbin/ping' : 'ping';
  const { code, out } = await run(cmd, args, timeoutMs + 1500);
  return parsePingOutput(out, code);
}

/** Normalises "a:b:c:d:e:f" or "aa-bb-cc-dd-ee-ff" to "aa:bb:cc:dd:ee:ff". */
export function normalizeMac(raw: string): string | undefined {
  const parts = raw.trim().toLowerCase().split(/[:-]/);
  if (parts.length !== 6 || parts.some((p) => !/^[0-9a-f]{1,2}$/.test(p))) return undefined;
  const mac = parts.map((p) => p.padStart(2, '0')).join(':');
  // Broadcast, empty, IPv4 multicast, and the placeholder macOS reports when it withholds the real address.
  if (mac === 'ff:ff:ff:ff:ff:ff' || mac === '00:00:00:00:00:00' || mac === '02:00:00:00:00:00' || mac.startsWith('01:00:5e'))
    return undefined;
  return mac;
}

/** Parses `arp -an` (macOS/Linux) or `arp -a` (Windows) output into ip -> mac. */
export function parseArp(out: string): Map<string, string> {
  const table = new Map<string, string>();
  for (const line of out.split('\n')) {
    const unix = /\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/i.exec(line);
    const win = /^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s/i.exec(line);
    const m = unix ?? win;
    if (!m?.[1] || !m[2]) continue;
    const mac = normalizeMac(m[2]);
    if (mac) table.set(m[1], mac);
  }
  return table;
}

export async function readArpTable(): Promise<Map<string, string>> {
  let inApp: string | undefined;
  try {
    inApp = sandboxArpText();
  } catch {
    // The table could not be read in this process: no MAC addresses, like an empty table.
    return new Map();
  }
  if (inApp !== undefined) return parseArp(inApp);
  const { out } =
    process.platform === 'win32' ? await run('arp', ['-a'], 5000) : await run('/usr/sbin/arp', ['-an'], 5000);
  return parseArp(out);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

/**
 * Reverse name lookup. Asks the operating system's resolver first (getnameinfo), which uses the
 * network's configured DNS servers and search domains and, on Windows, LLMNR and NetBIOS too. The
 * built-in DNS client is queried in parallel as a fallback. The OS echoes the address back when
 * it finds no name; that answer is ignored.
 */
export async function reverseDns(ip: string, timeoutMs: number): Promise<string | undefined> {
  const clean = (name: string | undefined) => {
    const n = name?.replace(/\.$/, '');
    return n && n !== ip && !/^[\d.]+$/.test(n) ? n : undefined;
  };
  const system = withTimeout(dnsPromises.lookupService(ip, 0), timeoutMs)
    .then((r) => clean(r?.hostname))
    .catch(() => undefined);
  const direct = withTimeout(dnsPromises.reverse(ip), timeoutMs)
    .then((names) => clean(names?.[0]))
    .catch(() => undefined);
  const [fromSystem, fromDirect] = await Promise.all([system, direct]);
  return fromDirect ?? fromSystem;
}

function reverseName(ip: string): string {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
}

/** Sends one UDP datagram and resolves with the first reply from the same host, or undefined. */
function udpExchange(ip: string, port: number, payload: Buffer, timeoutMs: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const socket = createSocket('udp4');
    let done = false;
    const finish = (value?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on('error', () => finish());
    socket.on('message', (msg, rinfo) => {
      if (rinfo.address === ip) finish(msg);
    });
    socket.send(payload, port, ip, (err) => err && finish());
  });
}

/**
 * Asks the host itself for its multicast DNS name with a unicast query to port 5353.
 * Responders answer legacy unicast queries directly, which finds names like "printer.local".
 */
export async function mdnsName(ip: string, timeoutMs: number): Promise<string | undefined> {
  const query = dnsPacket.encode({
    type: 'query',
    id: randomInt(1, 65535),
    flags: 0,
    questions: [{ type: 'PTR', name: reverseName(ip), class: 'IN' }],
  });
  const reply = await udpExchange(ip, 5353, query, timeoutMs);
  if (!reply) return undefined;
  try {
    const packet = dnsPacket.decode(reply);
    for (const answer of packet.answers ?? []) {
      if (answer.type === 'PTR' && typeof answer.data === 'string') return answer.data.replace(/\.$/, '');
    }
  } catch {
    /* malformed reply */
  }
  return undefined;
}

/** NetBIOS node status request for the wildcard name "*". */
export function buildNbstatQuery(id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0000, 2); // flags
  header.writeUInt16BE(1, 4); // one question
  const raw = Buffer.alloc(16); // "*" followed by 15 zero bytes
  raw[0] = 0x2a;
  const encoded = Buffer.alloc(32);
  for (let i = 0; i < 16; i++) {
    const b = raw[i] ?? 0;
    encoded[i * 2] = 0x41 + (b >> 4);
    encoded[i * 2 + 1] = 0x41 + (b & 0x0f);
  }
  const tail = Buffer.from([0x00, 0x00, 0x21, 0x00, 0x01]); // end of name, type NBSTAT, class IN
  return Buffer.concat([header, Buffer.from([0x20]), encoded, tail]);
}

export interface NbstatInfo {
  /** Unique workstation name (suffix 0x00). */
  name?: string;
  /** Adapter address from the statistics block ("unit ID"); absent when the host reports zeros. */
  mac?: string;
}

/** Parses a node status reply: the workstation name and the adapter MAC address that follows the name table. */
export function parseNbstatReply(reply: Buffer): NbstatInfo {
  // header (12) + encoded name (34) + type/class (4) + ttl (4) + rdlength (2)
  let offset = 12 + 34 + 4 + 4 + 2;
  const count = reply[offset];
  if (count === undefined) return {};
  offset += 1;
  const info: NbstatInfo = {};
  for (let i = 0; i < count; i++) {
    if (offset + 18 > reply.length) return info;
    const name = reply.subarray(offset, offset + 15).toString('latin1').trim();
    const suffix = reply[offset + 15];
    const flags = reply.readUInt16BE(offset + 16);
    const isGroup = (flags & 0x8000) !== 0;
    if (!info.name && suffix === 0x00 && !isGroup && name) info.name = name;
    offset += 18;
  }
  if (offset + 6 <= reply.length) {
    const unit = reply.subarray(offset, offset + 6);
    if (unit.some((b) => b !== 0)) info.mac = [...unit].map((b) => b.toString(16).padStart(2, '0')).join(':');
  }
  return info;
}

/** Returns the unique workstation name from a node status reply, if present. */
export function parseNbstat(reply: Buffer): string | undefined {
  return parseNbstatReply(reply).name;
}

/** NetBIOS node status lookup: workstation name and, when reported, the adapter MAC address. */
export async function netbiosInfo(ip: string, timeoutMs: number): Promise<NbstatInfo> {
  const reply = await udpExchange(ip, 137, buildNbstatQuery(randomInt(1, 65535)), timeoutMs);
  return reply ? parseNbstatReply(reply) : {};
}

/**
 * Turns the output of a `count`-packet ping into one entry per echo request, in order.
 * Uses icmp_seq when the platform prints it (macOS, Linux) and line order otherwise (Windows).
 */
export function parsePingSeries(output: string, count: number): { seq: number; timeMs?: number }[] {
  const times = new Map<number, number>();
  const seqMatches = [...output.matchAll(/icmp_seq[= ](\d+)[^\n]*?time[=<]\s*([\d.]+)\s*ms/gi)];
  if (seqMatches.length || /icmp_seq/i.test(output)) {
    const first = /icmp_seq[= ]0\b/i.test(output) ? 0 : 1;
    for (const m of seqMatches) {
      const index = Number(m[1]) - first;
      if (index >= 0 && index < count && !times.has(index)) times.set(index, Number(m[2]));
    }
  } else {
    // Windows prints a header, one line per request, a blank line, then statistics. Its wording is
    // localised, so a reply is recognised by "TTL=" and every other line in that block is a loss.
    const lines = output.split(/\r?\n/).map((l) => l.trim());
    const start = lines.findIndex((l) => l.length > 0) + 1;
    let index = 0;
    for (let i = start; i < lines.length && index < count; i++) {
      const line = lines[i] as string;
      if (!line) {
        if (index > 0) break;
        continue;
      }
      if (/TTL=/i.test(line)) {
        const time = /[=<]\s*([\d.]+)\s*ms/i.exec(line);
        times.set(index, time ? Number(time[1]) : 0);
      }
      index++;
    }
  }
  return Array.from({ length: count }, (_, i) => ({ seq: i + 1, timeMs: times.get(i) }));
}

/** One entry of the IPv6 neighbour table. */
export interface Neighbor6 {
  address: string;
  mac: string;
  /** Interface name, when the platform reports it. */
  iface?: string;
}

/** Scope of a unicast IPv6 address; undefined for multicast, loopback and unspecified addresses. */
export function ipv6Scope(address: string): Ipv6Scope | undefined {
  const head = parseInt(address.split(':')[0] || '0', 16);
  if (Number.isNaN(head)) return undefined;
  if ((head & 0xffc0) === 0xfe80) return 'link-local';
  if ((head & 0xfe00) === 0xfc00) return 'unique-local';
  if ((head & 0xe000) === 0x2000) return 'global';
  return undefined;
}

function neighbor(address: string, rawMac: string, iface?: string): Neighbor6 | undefined {
  const addr = address.split('%')[0]?.toLowerCase() ?? '';
  const mac = normalizeMac(rawMac);
  // 33:33:xx is the Ethernet range for IPv6 multicast, never a device.
  if (!mac || mac.startsWith('33:33:') || !ipv6Scope(addr)) return undefined;
  return { address: addr, mac, iface };
}

/** Parses `ndp -an` (macOS): neighbour, link-layer address, interface, expiry, state. */
export function parseNdp(out: string): Neighbor6[] {
  const entries: Neighbor6[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^([0-9a-f:]+(?:%\S+)?)\s+([0-9a-f:]{11,17})\s+(\S+)\s/i.exec(line.trim());
    if (!m) continue;
    const n = neighbor(m[1] as string, m[2] as string, m[3]);
    if (n) entries.push(n);
  }
  return entries;
}

/** Parses `netsh interface ipv6 show neighbors` (Windows); rows are address, physical address, type. */
export function parseNetshNeighbors6(out: string): Neighbor6[] {
  const entries: Neighbor6[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*([0-9a-f:]+(?:%\d+)?)\s+([0-9a-f]{2}(?:-[0-9a-f]{2}){5})\s/i.exec(line);
    if (!m) continue;
    const n = neighbor(m[1] as string, m[2] as string);
    if (n) entries.push(n);
  }
  return entries;
}

export async function readNeighbors6(): Promise<Neighbor6[]> {
  if (process.platform === 'win32') {
    const { out } = await run('netsh', ['interface', 'ipv6', 'show', 'neighbors'], 6000);
    return parseNetshNeighbors6(out);
  }
  const { out } = await run('/usr/sbin/ndp', ['-an'], 5000);
  return parseNdp(out);
}

/**
 * Pings the all-nodes multicast group (ff02::1) on one interface so every IPv6 device on the
 * link answers and lands in the neighbour table. One packet reaches the whole segment, which is
 * the only practical way to find devices in a /64.
 */
export async function multicastPing6(iface: string, scopeId?: number): Promise<void> {
  if (process.platform === 'win32') {
    if (scopeId === undefined) return;
    await run('ping', ['-6', '-n', '2', '-w', '1000', `ff02::1%${scopeId}`], 5000);
    return;
  }
  await run('/sbin/ping6', ['-c', '2', '-i', '0.5', `ff02::1%${iface}`], 4000);
}

const SCOPE_ORDER: Record<Ipv6Scope, number> = { global: 0, 'unique-local': 1, 'link-local': 2 };

/** Groups neighbour entries by MAC, keeping one interface's entries when `iface` is given. */
export function addressesByMac(entries: Neighbor6[], iface?: string): Map<string, Ipv6Address[]> {
  const out = new Map<string, Ipv6Address[]>();
  for (const e of entries) {
    if (iface && e.iface && e.iface !== iface) continue;
    const scope = ipv6Scope(e.address);
    if (!scope) continue;
    const list = out.get(e.mac) ?? [];
    if (!list.some((a) => a.address === e.address)) list.push({ address: e.address, scope });
    out.set(e.mac, list);
  }
  for (const list of out.values()) list.sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || a.address.localeCompare(b.address));
  return out;
}
