import { spawn } from 'node:child_process';
import { setMaxListeners } from 'node:events';
import { hostname, networkInterfaces } from 'node:os';
import type { DiscoveredHost, NameSource, NetworkIdentity, ScanEvent, ScanPhase, ScanSettings, Timing } from '@shared/types';
import { allPorts, LIVENESS_PORTS, parsePortList, serviceName, TOP_PORTS } from './ports';
import { countAddresses, expandRanges, intToIp, ipToInt, mergeRanges, MAX_TARGETS, parseTargets, rangeContains, type Ipv4Range } from './targets';
import { addressesByMac, ipv6Scope, mdnsName, multicastPing6, netbiosInfo, readNeighbors6, type Neighbor6, normalizeMac, ping, readArpTable, reverseDns, Semaphore, tcpProbe } from './probes';
import { classify, evaluateRisks, VendorDb } from './analysis';
import { mdnsServices, onvifDiscover, ssdpDiscover } from './discovery';
import { buildObserved, httpInfo, identifyPorts, sshGreeting, tlsCertificate, type CertificateInfo, type HttpInfo } from './identify';

interface TimingProfile {
  /** Hosts processed at the same time. */
  hosts: number;
  /** Sockets and child processes open at the same time (kept under default file limits). */
  sockets: number;
  connectMs: number;
  pingMs: number;
  nameMs: number;
  /** How long the identify phase listens for answers to its network-wide queries. */
  listenMs: number;
}

export const TIMING: Record<Timing, TimingProfile> = {
  cautious: { hosts: 16, sockets: 48, connectMs: 1500, pingMs: 1000, nameMs: 1500, listenMs: 3000 },
  balanced: { hosts: 48, sockets: 128, connectMs: 900, pingMs: 800, nameMs: 1200, listenMs: 2500 },
  aggressive: { hosts: 96, sockets: 200, connectMs: 600, pingMs: 600, nameMs: 1000, listenMs: 2000 },
};

export interface EngineOptions {
  runId: string;
  settings: ScanSettings;
  vendors: VendorDb;
  signal: AbortSignal;
  emit(event: ScanEvent): void;
  /** Reads the OS neighbour (ARP) table; defaults to reading it in this process. */
  readArp?: () => Promise<Map<string, string>>;
  /** Reads the OS IPv6 neighbour table; defaults to reading it in this process. */
  readNeighbors6?: () => Promise<Neighbor6[]>;
}

/** Runs `worker` over `items` with at most `limit` in flight; stops early when aborted. */
async function forEachLimited<T>(items: T[], limit: number, signal: AbortSignal, worker: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!signal.aborted && next < items.length) {
      const item = items[next++] as T;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/** Extracts default gateways from `route print -4 0.0.0.0` (Windows) or `route -n get default` (macOS). */
export function parseDefaultGateways(out: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const gateways = [...out.matchAll(/^\s*0\.0\.0\.0\s+0\.0\.0\.0\s+(\d+\.\d+\.\d+\.\d+)\s/gm)].map((m) => m[1] as string);
    return [...new Set(gateways)];
  }
  const m = /gateway:\s*(\d+\.\d+\.\d+\.\d+)/.exec(out);
  return m?.[1] ? [m[1]] : [];
}

export function defaultGateways(): Promise<string[]> {
  return new Promise((resolve) => {
    let out = '';
    const [cmd, args] =
      process.platform === 'win32' ? ['route', ['print', '-4', '0.0.0.0']] : ['/sbin/route', ['-n', 'get', 'default']];
    const child = spawn(cmd as string, args as string[], { shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 2000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve([]));
    child.on('close', () => {
      clearTimeout(timer);
      resolve(parseDefaultGateways(out, process.platform));
    });
  });
}

/** This machine's own IPv4 addresses with their MACs (they never appear in the ARP table). */
function ownAddresses(): Map<string, string | undefined> {
  const own = new Map<string, string | undefined>();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) own.set(a.address, normalizeMac(a.mac));
  }
  return own;
}

/** True when one of this machine's addresses falls inside the scanned ranges (same subnet). */
function isLocalScan(ranges: Ipv4Range[], own: Map<string, string | undefined>): boolean {
  return [...own.keys()].some((ip) => rangeContains(ranges, ip));
}

/** An IPv4 interface of this machine: its address and the subnet it sits on. */
export interface LocalInterface {
  address: string;
  /** Subnet in CIDR notation, e.g. "10.0.0.0/24". */
  cidr: string;
  /** OS interface name, e.g. "en0" or "Ethernet". */
  name?: string;
  /** IPv6 zone index of the interface (Windows addresses link-local multicast by number). */
  scopeId?: number;
  /** This machine's own IPv6 addresses on the interface. */
  ipv6?: string[];
}

/** Subnet of an address with a prefix length, in CIDR notation. */
export function subnetOf(address: string, prefix: number): string {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return `${intToIp((ipToInt(address) & mask) >>> 0)}/${prefix}`;
}

export function inSubnet(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split('/');
  return subnetOf(ip, Number(bits)) === `${base}/${bits}`;
}

export function localInterfaces(): LocalInterface[] {
  const out: LocalInterface[] = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    const v6 = (addrs ?? []).filter((a) => a.family === 'IPv6' && !a.internal);
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const prefix = Number(a.cidr?.split('/')[1] ?? 24);
      out.push({
        address: a.address,
        cidr: subnetOf(a.address, prefix),
        name,
        scopeId: v6.find((x) => x.scopeid)?.scopeid,
        ipv6: v6.map((x) => x.address.split('%')[0] as string),
      });
    }
  }
  return out;
}

/**
 * Decides which network a scan belongs to. For a subnet this computer is attached to, the
 * router's MAC identifies the network (two homes can both use 192.168.1.0/24); without it the
 * subnet does. Ranges this computer is not on are identified by the ranges themselves.
 */
export function networkIdentity(input: {
  ranges: Ipv4Range[];
  interfaces: LocalInterface[];
  gateways: string[];
  arp: Map<string, string>;
  vendors?: VendorDb;
}): NetworkIdentity {
  const iface = input.interfaces.find((i) => rangeContains(input.ranges, i.address));
  if (iface) {
    const gatewayIp = input.gateways.find((g) => inSubnet(g, iface.cidr));
    const gatewayMac = gatewayIp ? input.arp.get(gatewayIp) : undefined;
    return {
      fingerprint: gatewayMac ? `gw:${gatewayMac}` : `subnet:${iface.cidr}`,
      cidr: iface.cidr,
      gatewayIp,
      gatewayMac,
      gatewayVendor: gatewayMac ? input.vendors?.lookup(gatewayMac) : undefined,
      local: true,
    };
  }
  const merged = mergeRanges(input.ranges);
  const label = merged
    .map((r) => {
      // CIDR blocks are stored without their network and broadcast addresses; show them as CIDR again.
      for (const [start, end] of [
        [r.start, r.end],
        [r.start - 1, r.end + 1],
      ] as const) {
        const size = end - start + 1;
        const prefix = 32 - Math.log2(size);
        if (Number.isInteger(prefix) && start >= 0 && start % size === 0) return `${intToIp(start)}/${prefix}`;
      }
      return `${intToIp(r.start)}-${intToIp(r.end)}`;
    })
    .join(', ');
  return { fingerprint: `range:${label}`, cidr: label, local: false };
}

/**
 * Live hosts on the directly attached subnet that still have no MAC. A fast scan can finish before
 * the operating system has resolved every neighbour, so these are asked again. Hosts outside the
 * subnet never appear in the ARP table and are left out, as is this computer.
 */
export function macGaps(hosts: Iterable<DiscoveredHost>, cidr: string, own: Map<string, string | undefined>): DiscoveredHost[] {
  return [...hosts].filter((h) => !h.mac && !own.has(h.ip) && inSubnet(h.ip, cidr));
}

/**
 * Addresses worth one more look: those that did not answer, share their /24 block with one that
 * did, and are outside the subnets whose neighbour table was read (`covered`). There the table
 * tells who is present whatever the probes missed; elsewhere nothing does, so a device that
 * missed its answer for a moment is only found by asking again. A block where nothing answered is
 * left alone.
 */
export function silentAddresses(addresses: string[], live: ReadonlySet<string>, covered: string[]): string[] {
  const block = (ip: string) => ip.slice(0, ip.lastIndexOf('.'));
  const active = new Set([...live].map(block));
  return addresses.filter((ip) => !live.has(ip) && active.has(block(ip)) && !covered.some((cidr) => inSubnet(ip, cidr)));
}

/** The subnets the neighbour table tells about: those it holds at least one address of. */
export function subnetsInTable(cidrs: string[], table: ReadonlyMap<string, string>): string[] {
  return cidrs.filter((cidr) => [...table.keys()].some((ip) => inSubnet(ip, cidr)));
}

/** Most addresses pinged at a time in the second look, whatever the timing profile. */
const SECOND_LOOK_MAX = 96;

/** Port lists longer than this wait per host only as long as the host takes to answer. */
export const ADAPTIVE_MIN_PORTS = 1024;
/** How often hosts that gained open ports are sent during the port scan. */
const PUBLISH_EVERY_MS = 250;
/** Shortest wait for a port when it is adapted to the host. */
export const MIN_PORT_WAIT_MS = 300;

/**
 * How long to wait for a port on one host. Starts at ten times the host's ping time (never under
 * MIN_PORT_WAIT_MS nor over the timing profile's limit) and grows to four times the slowest
 * answer seen, so a host that answers slowly gets more time. Without a ping time it waits the
 * full limit until the host has answered once.
 */
export class PortWait {
  private slowest = 0;
  constructor(
    private readonly max: number,
    private readonly rttMs?: number,
  ) {}

  get ms(): number {
    if (this.rttMs === undefined && this.slowest === 0) return this.max;
    const want = Math.max(MIN_PORT_WAIT_MS, (this.rttMs ?? 0) * 10, this.slowest * 4);
    return Math.min(this.max, Math.ceil(want));
  }

  answered(ms: number) {
    this.slowest = Math.max(this.slowest, ms);
  }
}

/**
 * Every (host, port) check of the port scan, port by port across all hosts, so that one host
 * behind a firewall shares the connections with the others instead of holding them all. Ports a
 * host already showed open are skipped. Yields lazily: nothing is queued up front.
 */
export function* portChecks(hosts: DiscoveredHost[], ports: number[]): Generator<[DiscoveredHost, number]> {
  const known = hosts.map((h) => new Set(h.ports.map((p) => p.port)));
  for (const p of ports) {
    for (let i = 0; i < hosts.length; i++) if (!known[i]?.has(p)) yield [hosts[i] as DiscoveredHost, p];
  }
}

/** Number of checks portChecks yields. */
export function countPortChecks(hosts: DiscoveredHost[], ports: number[]): number {
  const wanted = new Set(ports);
  return hosts.reduce((n, h) => n + ports.length - h.ports.filter((p) => wanted.has(p.port)).length, 0);
}

/**
 * The interfaces that reach live hosts directly: the network-wide identify queries go out on each,
 * since multicast only reaches the local segment. Empty when no live host is on a directly
 * attached subnet (a remote scan), and the queries are skipped then.
 */
export function identifyInterfaces(interfaces: LocalInterface[], live: DiscoveredHost[]): LocalInterface[] {
  return interfaces.filter((i) => live.some((h) => h.ip !== i.address && inSubnet(h.ip, i.cidr)));
}

/**
 * Joins per-interface results. Lists seen for one device on several interfaces are joined without
 * repeats; other answers keep the first one.
 */
function mergeMaps<T>(maps: Map<string, T>[]): Map<string, T> {
  const out = new Map<string, T>();
  for (const m of maps)
    for (const [k, v] of m) {
      const seen = out.get(k);
      if (seen === undefined) out.set(k, v);
      else if (Array.isArray(seen) && Array.isArray(v)) out.set(k, [...new Set([...seen, ...v])] as T);
    }
  return out;
}

/** Hosts asked at the same time in the MAC recovery pass; kept low so the neighbour table keeps up. */
const MAC_PASS_HOSTS = 8;

function newHost(ip: string): DiscoveredHost {
  return { ip, names: [], aliveVia: [], ports: [], type: 'unknown', typeConfidence: 0, evidence: [], risks: [] };
}

function addPort(host: DiscoveredHost, port: number) {
  // The port scan finds ports in ascending order: appending keeps the list sorted without a search.
  const last = host.ports.at(-1);
  if (!last || last.port < port) {
    host.ports.push({ port, service: serviceName(port) });
    return;
  }
  if (!host.ports.some((p) => p.port === port)) {
    host.ports.push({ port, service: serviceName(port) });
    host.ports.sort((a, b) => a.port - b.port);
  }
}

export function portsFor(settings: ScanSettings): number[] {
  switch (settings.portProfile) {
    case 'none':
      return [];
    case 'all':
      return allPorts();
    case 'custom':
      return parsePortList(settings.customPorts);
    default:
      return TOP_PORTS;
  }
}

export async function runScan(opts: EngineOptions): Promise<void> {
  const { runId, settings, vendors, signal, emit } = opts;
  // Every connection in flight listens for Stop; there can be as many as the profile's sockets.
  setMaxListeners(0, signal);
  const startedAt = new Date().toISOString();
  const timing = TIMING[settings.timing];
  const sockets = new Semaphore(timing.sockets);

  const { ranges, errors } = parseTargets(settings.targets);
  const total = countAddresses(ranges);
  if (!total) throw new Error(errors[0] ?? 'Add at least one IP address, range or CIDR block.');
  if (total > MAX_TARGETS) throw new Error(`That is ${total.toLocaleString()} addresses; the limit is ${MAX_TARGETS.toLocaleString()}.`);
  const ports = portsFor(settings);

  const hosts = new Map<string, DiscoveredHost>();
  let phase: ScanPhase = 'liveness';
  let done = 0;
  let phaseTotal = total;
  let lastProgress = 0;
  const progress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgress < 150) return;
    lastProgress = now;
    emit({ type: 'progress', progress: { runId, phase, done, total: phaseTotal, live: hosts.size } });
  };
  const publish = (host: DiscoveredHost) => emit({ type: 'host', runId, host: structuredClone(host) });

  let macHidden = false;
  let lanBlocked = false;
  const finish = (status: 'done' | 'cancelled') => {
    phase = 'done';
    progress(true);
    const all = [...hosts.values()];
    emit({
      type: 'done',
      summary: {
        runId,
        targets: settings.targets,
        startedAt,
        finishedAt: new Date().toISOString(),
        status,
        scanned: total,
        live: all.length,
        newAssets: 0,
        openPorts: all.reduce((n, h) => n + h.ports.length, 0),
        risks: all.reduce((n, h) => n + h.risks.length, 0),
        macHidden,
        lanBlocked,
      },
    });
  };

  const gateways = await defaultGateways();
  const own = ownAddresses();
  const readArp = opts.readArp ?? readArpTable;

  // Identify the network before reporting any host, so every device is saved to it directly.
  const interfaces = localInterfaces();
  const attached = interfaces.find((i) => rangeContains(ranges, i.address));
  const gatewayIp = attached && gateways.find((g) => inSubnet(g, attached.cidr));
  let gatewayArp = new Map<string, string>();
  if (gatewayIp) {
    await ping(gatewayIp, timing.pingMs); // puts the router in the neighbour table
    gatewayArp = await readArp();
  }
  emit({ type: 'network-identity', runId, identity: networkIdentity({ ranges, interfaces, gateways, arp: gatewayArp, vendors }) });
  progress(true);

  /* Phase 1: liveness. A host is up if it answers ping, accepts a TCP connection or resets one. */
  const addresses = [...expandRanges(ranges)];
  await forEachLimited(addresses, timing.hosts, signal, async (ip) => {
    const host = newHost(ip);
    let up = false;
    const pingTask = sockets.run(() => ping(ip, timing.pingMs)).then((reply) => {
      if (!reply.alive) return;
      up = true;
      host.aliveVia.push('icmp');
      host.rttMs = reply.rttMs;
      host.ttl = reply.ttl;
    });
    const tcpTasks = LIVENESS_PORTS.map((port) =>
      sockets.run(async () => {
        if (signal.aborted) return;
        const result = await tcpProbe(ip, port, timing.connectMs, signal);
        if (result === 'open' || result === 'closed') {
          up = true;
          if (!host.aliveVia.includes('tcp')) host.aliveVia.push('tcp');
        }
        if (result === 'open') addPort(host, port);
      }),
    );
    await Promise.all([pingTask, ...tcpTasks]);
    if (own.has(ip)) {
      up = true;
      host.mac = own.get(ip);
      host.hostname = hostname().replace(/\.local$/i, '');
      host.evidence.push('this computer');
    }
    if (up) {
      hosts.set(ip, host);
      publish(host);
    }
    done++;
    progress();
  });

  /* Hosts that block ping and every probed port still answer ARP on the local segment. */
  const arp = await readArp();
  // macOS hides link-layer entries from apps without local network permission.
  const onLocalSubnet = [...hosts.keys()].filter((ip) => !own.has(ip));
  const localScan = isLocalScan(ranges, own);
  macHidden = arp.size === 0 && onLocalSubnet.length > 0 && localScan;
  // Not even the gateway answered: on macOS this means the app has no local network permission.
  lanBlocked =
    process.platform === 'darwin' && arp.size === 0 && onLocalSubnet.length === 0 && localScan && addresses.length > own.size;
  for (const [ip, mac] of arp) {
    if (!rangeContains(ranges, ip)) continue;
    let host = hosts.get(ip);
    if (!host) {
      host = newHost(ip);
      host.aliveVia.push('arp');
      hosts.set(ip, host);
    }
    host.mac ??= mac;
  }
  // One more ping, with a longer wait, for the silent addresses the table says nothing about. The
  // table speaks for the subnets this computer is on that it holds an address of. This computer
  // answering does not make its block one where something answered. A ping alone is light, so
  // twice as many addresses are asked at a time as in the first look, up to a fixed number.
  const covered = subnetsInTable(interfaces.filter((i) => rangeContains(ranges, i.address)).map((i) => i.cidr), arp);
  const answered = new Set([...hosts.keys()].filter((ip) => !own.has(ip)));
  const silent = lanBlocked ? [] : silentAddresses(addresses, answered, covered).filter((ip) => !hosts.has(ip));
  if (silent.length && !signal.aborted) {
    phaseTotal += silent.length;
    progress(true);
    await forEachLimited(silent, Math.min(timing.hosts * 2, SECOND_LOOK_MAX), signal, async (ip) => {
      const reply = await sockets.run(() => ping(ip, TIMING.cautious.pingMs));
      if (reply.alive) {
        const host = newHost(ip);
        host.aliveVia.push('icmp');
        host.rttMs = reply.rttMs;
        host.ttl = reply.ttl;
        hosts.set(ip, host);
      }
      done++;
      progress();
    });
  }
  // Second, slower pass for live hosts the table missed: one ping and one connection to a port it
  // already answered on make the system resolve the neighbour, then the table is read again.
  const gaps = attached && !macHidden && !lanBlocked ? macGaps(hosts.values(), attached.cidr, own) : [];
  if (gaps.length && !signal.aborted) {
    const slow = TIMING.cautious;
    await forEachLimited(gaps, MAC_PASS_HOSTS, signal, async (host) => {
      await ping(host.ip, slow.pingMs);
      const port = host.ports[0]?.port;
      if (port && !signal.aborted) await tcpProbe(host.ip, port, slow.connectMs, signal);
    });
    const again = await readArp();
    for (const host of gaps) host.mac ??= again.get(host.ip);
  }
  for (const host of hosts.values()) {
    host.vendor = vendors.lookup(host.mac);
    publish(host);
  }
  if (signal.aborted) return finish('cancelled');

  // IPv6: one multicast ping fills the neighbour table; addresses are joined to devices by MAC later.
  let neighbors6: Neighbor6[] = [];
  if (attached?.name) {
    await multicastPing6(attached.name, attached.scopeId);
    neighbors6 = await (opts.readNeighbors6 ?? readNeighbors6)().catch(() => []);
  }

  const live = [...hosts.values()];

  /* Phase 2: names from multicast DNS, NetBIOS and reverse DNS. */
  if (settings.resolveNames) {
    phase = 'names';
    done = 0;
    phaseTotal = live.length;
    progress(true);
    await forEachLimited(live, timing.hosts, signal, async (host) => {
      const lookups: [NameSource, Promise<string | undefined>][] = [
        ['mdns', sockets.run(() => mdnsName(host.ip, timing.nameMs))],
        [
          'netbios',
          sockets.run(() => netbiosInfo(host.ip, timing.nameMs)).then((info) => {
            // NetBIOS replies carry the adapter MAC, which fills the gap when the OS hides the ARP table.
            if (!host.mac && info.mac) {
              host.mac = normalizeMac(info.mac) ?? info.mac;
              host.vendor = vendors.lookup(host.mac);
            }
            return info.name;
          }),
        ],
        ['dns', reverseDns(host.ip, timing.nameMs)],
      ];
      for (const [source, lookup] of lookups) {
        const name = await lookup;
        if (name && !host.names.some((n) => n.name.toLowerCase() === name.toLowerCase())) host.names.push({ source, name });
      }
      const preferred =
        host.names.find((n) => n.source === 'mdns') ??
        host.names.find((n) => n.source === 'netbios') ??
        host.names.find((n) => n.source === 'dns');
      if (preferred && !host.hostname) host.hostname = preferred.name.replace(/\.local$/i, '');
      publish(host);
      done++;
      progress();
    });
    if (signal.aborted) return finish('cancelled');
  }

  /* Phase 3: TCP port scan on live hosts. A fixed set of workers takes checks one at a time. */
  if (ports.length && live.length) {
    const total = countPortChecks(live, ports);
    if (total) {
      phase = 'ports';
      done = 0;
      phaseTotal = total;
      progress(true);
      const adaptive = ports.length > ADAPTIVE_MIN_PORTS;
      const waits = new Map(live.map((h) => [h, new PortWait(timing.connectMs, adaptive ? h.rttMs : undefined)]));
      const checks = portChecks(live, ports);
      // Hosts with new open ports are sent at most every PUBLISH_EVERY_MS, not once per port.
      const changed = new Set<DiscoveredHost>();
      const flush = () => {
        for (const host of changed) publish(host);
        changed.clear();
      };
      const flusher = setInterval(flush, PUBLISH_EVERY_MS);
      // A port that stayed silent while its host's wait was shorter than it later became is
      // checked again with the longer wait, so a host slower than its ping time loses no ports.
      const recheck: [DiscoveredHost, number][] = [];
      const check = async (host: DiscoveredHost, port: number, retry: boolean) => {
        const wait = waits.get(host) as PortWait;
        const used = adaptive ? wait.ms : timing.connectMs;
        const started = performance.now();
        const result = await tcpProbe(host.ip, port, used, signal);
        if (result === 'open' || result === 'closed') wait.answered(performance.now() - started);
        if (result === 'open') {
          addPort(host, port);
          changed.add(host);
        } else if (result === 'silent' && adaptive && !retry && !signal.aborted && wait.ms > used) {
          recheck.push([host, port]);
          phaseTotal++;
        }
        done++;
        progress();
      };
      const pool = (next: () => [DiscoveredHost, number] | undefined, retry: boolean) => async () => {
        for (let item = next(); item && !signal.aborted; item = next()) await check(item[0], item[1], retry);
      };
      const fromChecks = () => {
        const n = checks.next();
        return n.done ? undefined : n.value;
      };
      try {
        await Promise.all(Array.from({ length: Math.min(timing.sockets, total) }, pool(fromChecks, false)));
        let r = 0;
        await Promise.all(Array.from({ length: Math.min(timing.sockets, recheck.length) }, pool(() => recheck[r++], true)));
      } finally {
        clearInterval(flusher);
      }
      flush();
      progress(true);
      if (signal.aborted) return finish('cancelled');
    }
  }

  /*
   * Phase 4: identify. Devices are asked what they are: what they announce on the local network
   * (mDNS services, UPnP descriptions, ONVIF) and what their open web and SSH ports present.
   * The network-wide queries run while the devices are asked one by one.
   */
  if (ports.length && live.length) {
    phase = 'identify';
    done = 0;
    phaseTotal = live.length;
    progress(true);
    const locals = identifyInterfaces(interfaces, live).map((i) => i.address);
    const inScan = new Set(live.map((h) => h.ip));
    // A collector that fails gives no evidence; it never fails the scan.
    const quiet = <T,>(p: Promise<Map<string, T>>) => p.catch(() => new Map<string, T>());
    const announced = Promise.all(
      locals.map((local) =>
        Promise.all([
          quiet(mdnsServices(timing.listenMs, signal, undefined, local)),
          quiet(ssdpDiscover(timing.listenMs, signal, undefined, local, inScan)),
          quiet(onvifDiscover(timing.listenMs, signal, undefined, local)),
        ]),
      ),
    ).then((perInterface) => [mergeMaps(perInterface.map((r) => r[0])), mergeMaps(perInterface.map((r) => r[1])), mergeMaps(perInterface.map((r) => r[2]))] as const);
    // Long enough for a slow embedded web server, short enough not to hold the scan.
    const wait = Math.max(1500, timing.connectMs * 2);
    const asked = new Map<DiscoveredHost, { http: HttpInfo[]; tls?: CertificateInfo; ssh?: string }>();
    // Each device costs at most a few short waits; the socket limit still bounds the connections.
    await forEachLimited(live, Math.max(8, Math.floor(timing.hosts / 2)), signal, async (host) => {
      const p = identifyPorts(host.ports.map((o) => o.port));
      const [plain, secure, tls, ssh] = await Promise.all([
        p.http ? sockets.run(() => httpInfo(host.ip, p.http as number, false, wait, signal)) : undefined,
        p.https ? sockets.run(() => httpInfo(host.ip, p.https as number, true, wait, signal)) : undefined,
        p.https ? sockets.run(() => tlsCertificate(host.ip, p.https as number, wait, signal)) : undefined,
        p.ssh ? sockets.run(() => sshGreeting(host.ip, p.ssh as number, wait, signal)) : undefined,
      ]);
      asked.set(host, { http: [plain, secure].filter((h): h is HttpInfo => !!h), tls, ssh });
      done++;
      progress();
    });
    const [services, upnp, onvif] = await announced;
    if (signal.aborted) return finish('cancelled');
    for (const host of live) {
      const a = asked.get(host);
      const observed = buildObserved({ services: services.get(host.ip), upnp: upnp.get(host.ip), onvif: onvif.get(host.ip), http: a?.http, tls: a?.tls, ssh: a?.ssh });
      if (observed) host.observed = observed;
    }
  }

  /* Phase 5: classification and risk rules. */
  phase = 'analysis';
  done = 0;
  phaseTotal = live.length;
  progress(true);
  const v6ByMac = addressesByMac(neighbors6, process.platform === 'win32' ? undefined : attached?.name);
  for (const host of live) {
    if (own.has(host.ip)) {
      const mine = (interfaces.find((i) => i.address === host.ip)?.ipv6 ?? []).filter((a) => ipv6Scope(a));
      if (mine.length) host.ipv6 = addressesByMac(mine.map((address) => ({ address, mac: 'self' }))).get('self');
    } else if (host.mac && v6ByMac.has(host.mac)) {
      host.ipv6 = v6ByMac.get(host.mac);
    }
    Object.assign(host, classify(host, gateways));
    if (host.evidence.length === 0 && own.has(host.ip)) host.evidence.push('this computer');
    host.risks = evaluateRisks(host);
    publish(host);
    done++;
  }
  finish('done');
}
