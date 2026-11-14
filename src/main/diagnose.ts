/**
 * Diagnose checks run from the main process: the connectivity chain (this computer, gateway, DNS,
 * internet), four-packet pings and traceroute. Commands run without a shell, with validated input.
 */
import { net } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { Resolver, getServers, lookup } from 'node:dns/promises';
import type { PingResult } from '@shared/types';
import {
  asnName,
  asnOrigin,
  asnQueryName,
  combinePublicAddress,
  originQueryName,
  readTraceAddress,
  type PublicAddress,
  gradePing,
  isTraceTarget,
  parseMacTraceLine,
  parseTraceDestination,
  parseWindowsTraceLine,
  type CheckStep,
  type LocalLink,
  compareAnswers,
  explainMtu,
  type DnsLookup,
  type DnsRecordType,
  type MtuResult,
  type PortCheck,
  type ServiceTarget,
  type TraceEvent,
  type TraceHop,
} from '@shared/diagnose';
import { parsePingOutput, parsePingSeries, ping, reverseDns, Semaphore, tcpProbe } from '../scanner/probes';
import { parsePortList, serviceName } from '../scanner/ports';
import { defaultGateways, inSubnet, localInterfaces } from '../scanner/engine';
import { networkInterfaces } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { sandboxNetHelper } from '../scanner/sandbox-net';

/**
 * Independent public targets, so one service being down never reads as "no internet". Each name
 * is tried in turn by the DNS step. The internet step fetches pages by address (needs no DNS) and
 * by name (needs DNS): only the first working means the internet works but name lookups do not.
 */
const DNS_NAMES = ['one.one.one.one', 'dns.google', 'dns.quad9.net'];
const PING_TARGETS = ['1.1.1.1', '8.8.8.8'];
const HTTPS_BY_ADDRESS = ['https://1.1.1.1/', 'https://8.8.8.8/'];
const HTTPS_BY_NAME = ['https://one.one.one.one/', 'https://dns.google/'];

export function pingFour(ip: string): Promise<PingResult> {
  return new Promise((resolve) => {
    const args = process.platform === 'win32' ? ['-n', '4', '-w', '1000', ip] : ['-c', '4', '-W', '1000', ip];
    const cmd = process.platform === 'darwin' ? '/sbin/ping' : 'ping';
    let out = '';
    const child = spawn(cmd, args, { shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', () => {
      clearTimeout(timer);
      const replies = parsePingSeries(out, 4);
      const times = replies.flatMap((r) => (r.timeMs === undefined ? [] : [r.timeMs]));
      const round = (n: number) => Math.round(n * 10) / 10;
      resolve({
        ip,
        sent: 4,
        received: times.length,
        replies,
        lossPct: Math.round(((4 - times.length) / 4) * 100),
        minMs: times.length ? round(Math.min(...times)) : undefined,
        avgMs: times.length ? round(times.reduce((a, b) => a + b, 0) / times.length) : undefined,
        maxMs: times.length ? round(Math.max(...times)) : undefined,
      });
    });
    child.on('error', () => resolve({ ip, sent: 4, received: 0, replies: parsePingSeries('', 4), lossPct: 100 }));
  });
}

const pingSummary = (p: PingResult) => (p.avgMs === undefined ? 'No reply' : `${p.avgMs} ms · ${p.lossPct}% loss`);

/** The interface that faces the default gateway, or the first one with an IPv4 address. */
export async function localLink(): Promise<LocalLink> {
  const gateways = await defaultGateways();
  const ifaces = localInterfaces();
  const gateway = gateways.find((g) => ifaces.some((i) => inSubnet(g, i.cidr))) ?? gateways[0];
  const iface = (gateway && ifaces.find((i) => inSubnet(gateway, i.cidr))) || ifaces[0];
  const mac = iface?.name ? networkInterfaces()[iface.name]?.find((a) => a.family === 'IPv4')?.mac : undefined;
  return {
    interfaceName: iface?.name,
    address: iface?.address,
    prefix: iface ? Number(iface.cidr.split('/')[1]) : undefined,
    // macOS returns a placeholder MAC when it withholds the real one.
    mac: mac && !['00:00:00:00:00:00', '02:00:00:00:00:00'].includes(mac) ? mac : undefined,
    gateway,
    dnsServers: getServers().filter((s) => !s.includes(':') || !s.startsWith('fe80')),
  };
}

export function checkLocal(link: LocalLink): CheckStep {
  const target = link.address ? `${link.address}/${link.prefix}` : undefined;
  const details = [link.interfaceName && `Interface ${link.interfaceName}`, link.mac && `MAC ${link.mac}`, link.gateway && `Default gateway ${link.gateway}`].filter(
    (x): x is string => !!x,
  );
  if (!link.address) return { id: 'local', status: 'fail', summary: 'No IPv4 address', details: ['No network interface has an IPv4 address.'] };
  if (link.address.startsWith('169.254.'))
    return { id: 'local', status: 'fail', target, summary: 'No address from DHCP', details: [...details, 'A 169.254.x.x address means no DHCP server answered.'] };
  if (!link.gateway) return { id: 'local', status: 'fail', target, summary: 'No default gateway', details };
  return { id: 'local', status: 'ok', target, summary: link.interfaceName ? `Connected on ${link.interfaceName}` : 'Connected', details };
}

/** Pings the gateway; a gateway that ignores ping but answers on a common TCP port only warns. */
export async function checkGateway(gateway: string): Promise<CheckStep> {
  const p = await pingFour(gateway);
  const status = gradePing(p.lossPct, p.avgMs, 20);
  const details = [`Ping: ${p.received} of ${p.sent} replies${p.avgMs !== undefined ? `, ${p.minMs}–${p.maxMs} ms` : ''}`];
  if (status !== 'fail') return { id: 'gateway', status, target: gateway, summary: pingSummary(p), details };
  for (const tcpPort of [443, 80, 53, 22]) {
    const r = await tcpProbe(gateway, tcpPort, 1200);
    if (r === 'open' || r === 'closed')
      return { id: 'gateway', status: 'warn', target: gateway, summary: 'Ignores ping, answers on TCP', details: [...details, `Answered on TCP port ${tcpPort}.`] };
  }
  return { id: 'gateway', status: 'fail', target: gateway, summary: 'No reply', details };
}

/** Resolves a public name through each configured DNS server, or through the system when none is listed. */
export async function checkDns(servers: string[]): Promise<CheckStep> {
  // IPv4 servers first: shorter to read, and the ones most networks hand out.
  const list = [...servers].sort((a, b) => Number(a.includes(':')) - Number(b.includes(':'))).slice(0, 3);
  if (!list.length) {
    const t = Date.now();
    for (const name of DNS_NAMES) {
      try {
        await lookup(name, { family: 4 });
        return { id: 'dns', status: 'ok', target: 'System resolver', summary: `Resolves in ${Date.now() - t} ms`, details: [] };
      } catch {
        // try the next name
      }
    }
    return { id: 'dns', status: 'fail', target: 'System resolver', summary: 'Lookups fail', details: [`Could not resolve ${DNS_NAMES.join(', ')}.`] };
  }
  const results = await Promise.all(
    list.map(async (server) => {
      const r = new Resolver({ timeout: 2500, tries: 1 });
      r.setServers([server]);
      // A server works when it resolves any of the names; the time is for the first that resolves.
      for (const name of DNS_NAMES) {
        const t = Date.now();
        try {
          await r.resolve4(name);
          return { server, ms: Date.now() - t };
        } catch {
          // try the next name
        }
      }
      return { server, ms: undefined };
    }),
  );
  const good = results.filter((r) => r.ms !== undefined);
  const details = results.map((r) => (r.ms === undefined ? `${r.server}: no answer` : `${r.server}: ${r.ms} ms`));
  const target = list.length > 1 ? `${list[0]} +${list.length - 1}` : list[0];
  if (!good.length) return { id: 'dns', status: 'fail', target, summary: 'No server answers', details };
  const fastest = Math.min(...good.map((r) => r.ms as number));
  if (good.length < results.length) return { id: 'dns', status: 'warn', target, summary: `${results.length - good.length} of ${results.length} servers fail`, details };
  return { id: 'dns', status: fastest >= 300 ? 'warn' : 'ok', target, summary: `Resolves in ${fastest} ms`, details };
}

/**
 * Time of one web request; any HTTP answer counts, since it proves the path works. Requests go
 * through Electron's network stack, so system proxies apply, and follow redirects.
 */
async function fetchTime(url: string, timeoutMs = 6000): Promise<{ ok: boolean; ms?: number; error?: string }> {
  const t = Date.now();
  try {
    await net.fetch(url, { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return { ok: true, ms: Date.now() - t };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One HTTPS request straight to an address, without following redirects: public addresses answer
 * with a redirect to their name, and following it would need DNS, which this request must not.
 */
function directTime(url: string, timeoutMs = 6000): Promise<{ ok: boolean; ms?: number; error?: string }> {
  return new Promise((resolve) => {
    const t = Date.now();
    const req = httpsRequest(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve({ ok: true, ms: Date.now() - t });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.end();
  });
}

const firstOk = async (urls: string[], direct = false) => {
  const results = await Promise.all(urls.map(async (u) => ({ url: u, ...(await (direct ? directTime(u) : fetchTime(u))) })));
  return results.find((r) => r.ok) ?? results[0];
};

/**
 * Public trace pages that show the address a request came from, per family, tried in order. They
 * belong to the same public DNS service the internet step already tests.
 */
const TRACE_URLS: Record<4 | 6, string[]> = {
  4: ['https://1.1.1.1/cdn-cgi/trace', 'https://1.0.0.1/cdn-cgi/trace'],
  6: ['https://[2606:4700:4700::1111]/cdn-cgi/trace', 'https://[2606:4700:4700::1001]/cdn-cgi/trace'],
};
/** Largest trace page read. */
const TRACE_MAX_BYTES = 4096;

/** Fetches one trace page and reads the address of the given family from it. */
function traceAddress(url: string, family: 4 | 6, timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = httpsRequest(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > TRACE_MAX_BYTES) req.destroy(new Error('page too large'));
      });
      res.on('end', () => resolve(res.statusCode === 200 ? readTraceAddress(body, family) : undefined));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', () => resolve(undefined));
    req.end();
  });
}

/** The address of one family from the first trace page that answers. */
async function addressOver(family: 4 | 6): Promise<string | undefined> {
  for (const url of TRACE_URLS[family]) {
    const ip = await traceAddress(url, family);
    if (ip) return ip;
  }
  return undefined;
}

/**
 * The public IPv4 and IPv6 addresses this network uses on the internet, the reverse name of the
 * IPv4 one and the provider that announces them. Undefined when no trace page answers.
 */
export async function publicAddress(): Promise<PublicAddress | undefined> {
  const [v4, v6] = await Promise.all([addressOver(4), addressOver(6)]);
  const ip = v4 ?? v6;
  const [name, network] = await Promise.all([v4 ? reverseDns(v4, 3000) : undefined, ip ? addressNetwork(ip) : undefined]);
  return combinePublicAddress(v4, v6, name, network);
}

/** TXT records of a name from the system's DNS servers, or none after the timeout. */
async function txt(name: string, timeoutMs = 3000): Promise<string[]> {
  const resolver = new Resolver({ timeout: timeoutMs, tries: 1 });
  const answer = resolver.resolveTxt(name).then((records) => records.map((parts) => parts.join('')));
  const late = new Promise<string[]>((resolve) => setTimeout(() => resolve([]), timeoutMs + 500));
  return Promise.race([answer.catch(() => []), late]);
}

/**
 * The network that announces an address and its owner, the internet provider, from the public
 * address-to-network DNS service. Asked through the network's own DNS servers.
 */
async function addressNetwork(ip: string): Promise<{ asn: number; name?: string } | undefined> {
  const query = originQueryName(ip);
  const asn = query ? asnOrigin(await txt(query)) : undefined;
  if (!asn) return undefined;
  return { asn, name: asnName(await txt(asnQueryName(asn))) };
}

/**
 * Pings public addresses and fetches public pages over HTTPS, by address and by name. HTTPS
 * decides; ping only adds detail, since some networks block it.
 */
export async function checkInternet(): Promise<CheckStep> {
  const [pings, byAddress, byName] = await Promise.all([Promise.all(PING_TARGETS.map(pingFour)), firstOk(HTTPS_BY_ADDRESS, true), firstOk(HTTPS_BY_NAME)]);
  const p = [...pings].sort((a, b) => a.lossPct - b.lossPct || (a.avgMs ?? 1e9) - (b.avgMs ?? 1e9))[0] as PingResult;
  const host = (u?: string) => (u ? new URL(u).host : '');
  const details = [
    `Ping ${p.ip}: ${pingSummary(p)}`,
    byAddress?.ok ? `HTTPS by address (${host(byAddress.url)}): ${byAddress.ms} ms` : 'HTTPS by address: failed',
    byName?.ok ? `HTTPS by name (${host(byName.url)}): ${byName.ms} ms` : 'HTTPS by name: failed',
  ];
  const pingStatus = gradePing(p.lossPct, p.avgMs, 150);
  const target = 'Public services';
  if (byName?.ok) {
    const summary = p.avgMs !== undefined ? `${p.avgMs} ms · ${p.lossPct}% loss · HTTPS OK` : `HTTPS OK in ${byName.ms} ms`;
    return { id: 'internet', status: pingStatus === 'warn' ? 'warn' : 'ok', target, summary, details };
  }
  if (byAddress?.ok)
    return { id: 'internet', status: 'warn', target, summary: 'Reachable by address, not by name', details: [...details, 'The internet answers, but name lookups fail: see DNS.'] };
  if (pingStatus !== 'fail')
    return { id: 'internet', status: 'warn', target, summary: 'Ping works, HTTPS fails', details: [...details, 'A proxy or firewall may be blocking web traffic.'] };
  return { id: 'internet', status: 'fail', target, summary: 'No reply', details };
}

/** Checks one service the customer relies on: its name, a TCP connection, then a web request when it is a web service. */
export async function checkService(target: ServiceTarget): Promise<CheckStep> {
  const base = { id: 'service' as const, target: target.label };
  let ip = target.host;
  const details: string[] = [];
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(target.host)) {
    try {
      ip = (await lookup(target.host, { family: 4 })).address;
      details.push(`${target.host} resolves to ${ip}`);
    } catch {
      return { ...base, status: 'fail', summary: 'Name does not resolve', details: [`Could not resolve ${target.host}.`] };
    }
  }
  const t = Date.now();
  const tcp = await tcpProbe(ip, target.port, 3000);
  if (tcp !== 'open') {
    const why = tcp === 'closed' ? 'refuses the connection' : tcp === 'unreachable' ? 'is unreachable' : 'does not answer';
    return { ...base, status: 'fail', summary: `Port ${target.port} ${why}`, details: [...details, `TCP ${ip}:${target.port} ${why}.`] };
  }
  details.push(`TCP ${ip}:${target.port}: connected in ${Date.now() - t} ms`);
  if (!target.url) return { ...base, status: 'ok', summary: `Answers on port ${target.port}`, details };
  const web = await fetchTime(target.url, 8000);
  if (!web.ok) return { ...base, status: 'warn', summary: 'Connects, web request fails', details: [...details, `Request failed${web.error ? `: ${web.error}` : ''}`] };
  return { ...base, status: 'ok', summary: `Answers in ${web.ms} ms`, details: [...details, `Web request: ${web.ms} ms`] };
}

// ---------------------------------------------------------------- live ping and port test

/** One echo request to an address or host name, for the live ping chart. */
export async function pingOnce(target: string): Promise<{ alive: boolean; rttMs?: number }> {
  const r = await ping(target, 1000);
  return { alive: r.alive, rttMs: r.rttMs };
}

/** Most ports one test may check, so a typo like "1-65535" does not run for minutes. */
export const MAX_TEST_PORTS = 1024;

/** Connects to every listed port on one host; open means a service accepted the connection. */
export async function checkPorts(host: string, ports: string): Promise<PortCheck> {
  const list = parsePortList(ports);
  if (!list.length) throw new Error('Enter at least one port.');
  if (list.length > MAX_TEST_PORTS) throw new Error(`Test up to ${MAX_TEST_PORTS} ports at a time.`);
  let ip = host;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    try {
      ip = (await lookup(host, { family: 4 })).address;
    } catch {
      throw new Error(`Could not resolve ${host}.`);
    }
  }
  const gate = new Semaphore(64);
  const started = Date.now();
  const results = await Promise.all(
    list.map(async (port) => {
      const release = await gate.acquire();
      try {
        const t = Date.now();
        const state = await tcpProbe(ip, port, 1500);
        return { port, state, service: serviceName(port), ms: state === 'open' ? Date.now() - t : undefined };
      } finally {
        release();
      }
    }),
  );
  return { host, ip, results, ms: Date.now() - started };
}

// ---------------------------------------------------------------- DNS lookup and path MTU

/** Public server each lookup is compared against. */
const PUBLIC_DNS = '1.1.1.1';

/** Looks a name up (or an address, in reverse) on this computer's DNS servers and on a public one. */
export async function dnsLookup(name: string, type: DnsRecordType): Promise<DnsLookup> {
  const reverse = /^\d+\.\d+\.\d+\.\d+$/.test(name);
  const kind: DnsRecordType = reverse ? 'PTR' : type === 'PTR' ? 'A' : type;
  const own = getServers()
    .filter((x) => !x.startsWith('fe80'))
    .sort((a, b) => Number(a.includes(':')) - Number(b.includes(':')))
    .slice(0, 2);
  const servers: { server: string; source: 'Network' | 'Public' }[] = [...own.map((server) => ({ server, source: 'Network' as const })), { server: PUBLIC_DNS, source: 'Public' as const }];
  const answers = await Promise.all(
    servers.map(async ({ server, source }) => {
      const r = new Resolver({ timeout: 3000, tries: 1 });
      r.setServers([server]);
      const t = Date.now();
      try {
        const records: string[] = reverse
          ? await r.reverse(name)
          : kind === 'A'
            ? await r.resolve4(name)
            : kind === 'AAAA'
              ? await r.resolve6(name)
              : kind === 'CNAME'
                ? await r.resolveCname(name)
                : kind === 'MX'
                  ? (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map((m) => `${m.priority} ${m.exchange}`)
                  : (await r.resolveTxt(name)).map((parts) => parts.join(''));
        return { server, source, ms: Date.now() - t, records };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const error = code === 'ENOTFOUND' || code === 'ENODATA' ? 'No such record' : code === 'ETIMEOUT' || code === 'ECONNREFUSED' ? 'No answer from server' : (code ?? 'Lookup failed');
        return { server, source, ms: Date.now() - t, records: [], error };
      }
    }),
  );
  return { name, type: kind, answers, agreement: compareAnswers(answers) };
}

/** One echo of `payload` bytes that routers may not fragment; true when it arrived whole. */
function pingUnfragmented(target: string, payload: number): Promise<boolean> {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const args = win ? ['-n', '1', '-f', '-l', String(payload), '-w', '1000', target] : ['-c', '1', '-D', '-s', String(payload), '-W', '1000', target];
    let out = '';
    const child = spawn(win ? 'ping' : '/sbin/ping', args, { shell: false, windowsHide: true });
    const timer = setTimeout(() => child.kill(), 3000);
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(parsePingOutput(out, code).alive);
    });
  });
}

/** IPv4 and ICMP headers added to an echo payload. */
const HEADERS = 28;

/** Finds the largest unfragmented packet to a target by halving the range between 576 and 1500 bytes. */
export async function pathMtu(target: string): Promise<MtuResult> {
  let probes = 1;
  if (!(await pingUnfragmented(target, 56)))
    return { target, probes, status: 'fail', explanation: `${target} does not answer ping, so the path size cannot be measured. Try the gateway or a public address.` };
  let lo = 576 - HEADERS;
  let hi = 1500 - HEADERS;
  probes++;
  if (await pingUnfragmented(target, hi)) return { target, mtu: 1500, probes, ...explainMtu(1500) };
  probes++;
  if (!(await pingUnfragmented(target, lo))) return { target, mtu: undefined, probes, status: 'fail', explanation: 'Even small packets are refused when fragmenting is not allowed. A device on the path drops them.' };
  // lo passes and hi fails: narrow down to the largest size that passes.
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    probes++;
    if (await pingUnfragmented(target, mid)) lo = mid;
    else hi = mid;
  }
  const mtu = lo + HEADERS;
  return { target, mtu, probes, ...explainMtu(mtu) };
}

// ---------------------------------------------------------------- traceroute

/** Silent hops in a row after which a trace stops: the rest of the path does not answer. */
const SILENT_LIMIT = 5;
const traces = new Map<string, ChildProcess>();

/** Starts a trace; events arrive through `emit` until a 'done' or 'error' event. */
export function startTrace(id: string, target: string, emit: (e: TraceEvent) => void): void {
  if (!isTraceTarget(target)) throw new Error('Enter an IPv4 address or a host name.');
  const win = process.platform === 'win32';
  const helper = sandboxNetHelper();
  const [cmd, args] = win
    ? ['tracert', ['-d', '-w', '1000', '-h', '30', target]]
    : helper
      ? [helper, ['trace', target, '30', '3', '1']]
      : ['/usr/sbin/traceroute', ['-n', '-I', '-q', '3', '-w', '1', '-m', '30', target]];
  const child = spawn(cmd as string, args as string[], { shell: false, windowsHide: true });
  traces.set(id, child);
  let destination = /^\d+\.\d+\.\d+\.\d+$/.test(target) ? target : undefined;
  let last: TraceHop | undefined;
  let silent = 0;
  let stoppedEarly = false;
  let buffer = '';
  let errText = '';
  emit({ id, kind: 'start', target, destination });

  const onLine = (line: string) => {
    if (!destination && !/^\s*\d+\s/.test(line)) destination = parseTraceDestination(line);
    const hop = win ? parseWindowsTraceLine(line) : parseMacTraceLine(line, last);
    if (!hop) return;
    // A hop can arrive in several lines (extra responders); each event replaces the hop with that number.
    last = hop;
    emit({ id, kind: 'hop', hop });
    silent = hop.times.length && hop.times.every((t) => t === null) ? silent + 1 : 0;
    if (silent >= SILENT_LIMIT) {
      stoppedEarly = true;
      child.kill();
    }
  };
  const read = (d: Buffer) => {
    buffer += d.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    lines.forEach(onLine);
  };
  child.stdout.on('data', read);
  child.stderr.on('data', (d: Buffer) => {
    const text = d.toString();
    errText += text;
    text.split(/\r?\n/).forEach((l) => {
      if (!destination) destination = parseTraceDestination(l);
    });
  });
  child.on('error', () => {
    traces.delete(id);
    emit({ id, kind: 'error', message: `Could not start ${win ? 'tracert' : 'traceroute'}.` });
  });
  child.on('close', (code) => {
    if (buffer) onLine(buffer);
    traces.delete(id);
    if (!last && code !== 0 && !stoppedEarly) {
      const reason = /unknown host|cannot resolve|unable to resolve|could not find host/i.test(errText) ? `Could not resolve ${target}.` : `The trace to ${target} failed.`;
      emit({ id, kind: 'error', message: reason });
      return;
    }
    emit({ id, kind: 'done', reached: !!destination && (last?.ip === destination || !!last?.others.includes(destination)), destination, stoppedEarly });
  });
}

export function cancelTrace(id: string): void {
  traces.get(id)?.kill();
}
