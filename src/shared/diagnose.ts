/**
 * Types and pure logic for the Diagnose module: the connectivity check from this computer out to
 * the internet, and traceroute output parsing for macOS and Windows.
 */

import type { DhcpLocation } from './rogue';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';
export type CheckStepId = 'local' | 'gateway' | 'dns' | 'internet' | 'service';

/** One link of the chain: this computer, the gateway, DNS, the internet, and optionally one service the customer relies on. */
export interface CheckStep {
  id: CheckStepId;
  status: CheckStatus;
  /** Short answer shown under the step, e.g. "0.6 ms · 0% loss". */
  summary: string;
  /** Address or name the step tested, e.g. "10.20.0.1". */
  target?: string;
  /** Extra lines for the detail panel. */
  details: string[];
}

/** This computer's connection: the interface facing the default gateway. */
export interface LocalLink {
  interfaceName?: string;
  address?: string;
  prefix?: number;
  mac?: string;
  gateway?: string;
  dnsServers: string[];
}

export interface Verdict {
  status: Exclude<CheckStatus, 'skipped'>;
  /** Which step the answer points at, when one failed. */
  culprit?: CheckStepId;
  text: string;
}

const STEP_NAME: Record<CheckStepId, string> = { local: 'This computer', gateway: 'Gateway', dns: 'DNS', internet: 'Internet', service: 'Service' };

/**
 * The one-line answer to "is it the network or the provider?": the first failing step, in chain
 * order, decides it; with no failure, any warnings are named.
 */
export function verdict(steps: CheckStep[]): Verdict {
  const failed = steps.find((s) => s.status === 'fail');
  if (failed) {
    const text: Record<CheckStepId, string> = {
      local: 'This computer has no working network connection: check the cable or WiFi, and that it received an address.',
      gateway: 'The local network is the problem: the gateway does not answer.',
      dns: 'Name lookups fail: the DNS servers are the problem, while the network itself answers.',
      internet: 'The local network works, but the internet does not answer: the provider or the firewall is the likely cause.',
      service: 'The internet works, but this service does not answer: the problem is on the service side, or the firewall blocks it.',
    };
    return { status: 'fail', culprit: failed.id, text: text[failed.id] };
  }
  const warned = steps.filter((s) => s.status === 'warn');
  if (warned.length) {
    return {
      status: 'warn',
      culprit: warned[0]?.id,
      text: `The connection works, with warnings on ${warned.map((s) => STEP_NAME[s.id].toLowerCase()).join(' and ')}.`,
    };
  }
  return { status: 'ok', text: 'Every step passed: this computer reaches the internet without problems.' };
}

/** Grades a ping series: no replies fails; loss or slow replies warn. */
export function gradePing(lossPct: number, avgMs: number | undefined, slowMs: number): CheckStatus {
  if (lossPct >= 100 || avgMs === undefined) return 'fail';
  return lossPct > 0 || avgMs >= slowMs ? 'warn' : 'ok';
}

/** A service to check, typed as a host name, an address, "host:port" or an http(s) URL. */
export interface ServiceTarget {
  host: string;
  port: number;
  /** Set for web services: the address fetched to confirm the service answers. */
  url?: string;
  /** How the technician typed it, for display. */
  label: string;
}

/** Reads a service target; undefined when the text is not one. Plain hosts are checked on port 443. */
export function parseServiceTarget(text: string): ServiceTarget | undefined {
  const raw = text.trim();
  if (!raw || raw.length > 300) return undefined;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (!isTraceTarget(host)) return undefined;
      const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
      return { host, port, url: u.toString(), label: raw };
    } catch {
      return undefined;
    }
  }
  const m = /^([^:\s/]+)(?::(\d{1,5}))?$/.exec(raw);
  if (!m || !isTraceTarget(m[1] as string)) return undefined;
  const port = m[2] ? Number(m[2]) : 443;
  if (port < 1 || port > 65535) return undefined;
  const scheme = port === 443 ? 'https' : port === 80 ? 'http' : undefined;
  return { host: m[1] as string, port, url: scheme ? `${scheme}://${m[1]}/` : undefined, label: raw };
}

/** Result of a port test: one entry per port, in the order tested. */
export interface PortCheck {
  host: string;
  ip: string;
  results: { port: number; state: 'open' | 'closed' | 'silent' | 'unreachable'; service: string; ms?: number }[];
  ms: number;
}

/** One echo of a live ping: when it was sent and its round trip, or none when lost. */
export interface PingSample {
  at: number;
  rttMs?: number;
}

export interface PingStats {
  sent: number;
  received: number;
  lossPct: number;
  minMs?: number;
  avgMs?: number;
  maxMs?: number;
  /** Mean change between consecutive replies, in milliseconds. */
  jitterMs?: number;
  /** Runs of consecutive lost echoes: when each began and how many were lost. */
  outages: { at: number; lost: number }[];
}

/** Summarises a live ping series. */
export function pingStats(samples: PingSample[]): PingStats {
  const times = samples.flatMap((s) => (s.rttMs === undefined ? [] : [s.rttMs]));
  const round = (n: number) => Math.round(n * 10) / 10;
  const outages: PingStats['outages'] = [];
  let run: { at: number; lost: number } | undefined;
  for (const s of samples) {
    if (s.rttMs === undefined) {
      run = run ?? { at: s.at, lost: 0 };
      run.lost++;
    } else if (run) {
      outages.push(run);
      run = undefined;
    }
  }
  if (run) outages.push(run);
  const jumps = times.slice(1).map((t, i) => Math.abs(t - (times[i] as number)));
  return {
    sent: samples.length,
    received: times.length,
    lossPct: samples.length ? round(((samples.length - times.length) / samples.length) * 100) : 0,
    minMs: times.length ? round(Math.min(...times)) : undefined,
    avgMs: times.length ? round(times.reduce((a, b) => a + b, 0) / times.length) : undefined,
    maxMs: times.length ? round(Math.max(...times)) : undefined,
    jitterMs: jumps.length ? round(jumps.reduce((a, b) => a + b, 0) / jumps.length) : undefined,
    outages,
  };
}

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'PTR';

/** Answer of one DNS server to one lookup. */
export interface DnsAnswer {
  server: string;
  /** "Network" for servers this computer is configured with, "Public" for the comparison server. */
  source: 'Network' | 'Public';
  ms?: number;
  records: string[];
  error?: string;
}

/**
 * How the servers' answers compare. "internal": the network's DNS returns private addresses the
 * public one does not (a name meant for inside, or an old entry); "missing": some servers find the
 * name and others do not; "varies": different public records, normal for sites spreading load.
 */
export type DnsAgreement = 'same' | 'varies' | 'internal' | 'missing' | 'none';

export interface DnsLookup {
  name: string;
  type: DnsRecordType;
  answers: DnsAnswer[];
  agreement: DnsAgreement;
}

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|169\.254\.)/;

/** Compares the answers of several servers to one lookup; servers that did not answer are ignored. */
export function compareAnswers(answers: DnsAnswer[]): DnsAgreement {
  const found = answers.filter((a) => !a.error && a.records.length);
  const notFound = answers.filter((a) => a.error === 'No such record');
  if (!found.length) return 'none';
  if (notFound.length) return 'missing';
  const isPrivate = (a: DnsAnswer) => a.records.some((r) => PRIVATE_V4.test(r));
  const own = found.filter((a) => a.source === 'Network');
  const pub = found.filter((a) => a.source === 'Public');
  if (own.some(isPrivate) && pub.length && !pub.some(isPrivate)) return 'internal';
  const sets = found.map((a) => [...a.records].sort().join('|'));
  return new Set(sets).size > 1 ? 'varies' : 'same';
}

export interface MtuResult {
  target: string;
  /** Largest packet, in bytes, that reached the target without being fragmented. */
  mtu?: number;
  /** Probes sent during the search. */
  probes: number;
  status: Exclude<CheckStatus, 'skipped'>;
  explanation: string;
}

/** Explains a path MTU in terms of the links that usually cause it. */
export function explainMtu(mtu: number): { status: MtuResult['status']; explanation: string } {
  if (mtu >= 1500) return { status: 'ok', explanation: 'Full-size packets pass. Nothing on this path shrinks them.' };
  if (mtu >= 1492)
    return { status: 'ok', explanation: 'Typical of a DSL or fibre link using PPPoE. Normal, as long as the router adjusts packet sizes for the devices behind it.' };
  if (mtu >= 1400)
    return { status: 'warn', explanation: 'Something on the path, often a VPN or tunnel, shrinks packets. If some sites or transfers hang without an error, set the MTU or MSS clamping on the tunnel or router.' };
  return { status: 'fail', explanation: 'Packets are much smaller than normal. Expect pages and transfers that hang: check tunnels, VPNs and the provider link.' };
}

/** A DHCP server that offered an address, as shown in Diagnose. */
export interface DhcpOfferView {
  server: string;
  from: string;
  offered: string;
  router?: string;
  dns: string[];
  leaseSeconds?: number;
  mac?: string;
}

/** An offer as Diagnose shows it: with the vendor, the subnet and, when found, the switch port. */
export interface DhcpOfferResult extends DhcpOfferView {
  vendor?: string;
  /** True when the server's address is outside this computer's subnet. */
  otherSubnet?: boolean;
  location?: DhcpLocation;
}

/** Result of the DHCP server test. */
export interface DhcpCheckResult {
  offers: DhcpOfferResult[];
  listenedMs: number;
  mode: 'direct' | 'relay';
  error?: string;
  /**
   * Search for the servers on the managed switches, run when more than one answered.
   * no-scan: this network is not in the inventory. no-snmp: it has no SNMP community.
   * no-answer: no switch answered with the saved community. no-table: the gear answered but none
   * shares its MAC address table, so no port can be told.
   */
  locate?: {
    status: 'done' | 'no-scan' | 'no-snmp' | 'no-answer' | 'no-table' | 'failed';
    networkId?: string;
    /** Names of the devices that answered without a MAC address table (no-table). */
    gear?: string[];
    switches?: number;
    /** Inventory devices that got their MAC address from the reading. */
    macsFilled?: number;
    error?: string;
  };
}

// ---------------------------------------------------------------- traceroute

export interface TraceHop {
  /** Hop number, from 1. */
  n: number;
  /** First address that answered at this hop; none when every probe timed out. */
  ip?: string;
  /** Other addresses that answered the same hop (load-balanced paths). */
  others: string[];
  /** Round-trip time of each probe, in milliseconds; null for a probe with no reply. */
  times: (number | null)[];
  /** Unreachable markers such as "!H" (host) or "!N" (network). */
  flags: string[];
}

export type TraceEvent =
  | { id: string; kind: 'start'; target: string; destination?: string }
  | { id: string; kind: 'hop'; hop: TraceHop }
  | { id: string; kind: 'done'; reached: boolean; destination?: string; stoppedEarly?: boolean }
  | { id: string; kind: 'error'; message: string };

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

/** Host names and IPv4 addresses accepted as a trace target; a leading dash is refused so it is never read as an option. */
export function isTraceTarget(text: string): boolean {
  if (IPV4.test(text)) return true;
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/.test(text);
}

/** Destination address from a header line: "traceroute to x (192.0.2.4), …" or "Tracing route to x [192.0.2.4]" in any language. */
export function parseTraceDestination(line: string): string | undefined {
  const m = /[[(]((?:\d{1,3}\.){3}\d{1,3})[\])]/.exec(line);
  return m?.[1] && IPV4.test(m[1]) ? m[1] : undefined;
}

/**
 * One line of macOS `traceroute -n` output. A line starting with a hop number opens a hop; an
 * indented line without one adds another responder to `previous` (returned as a new, updated hop).
 * Other lines give undefined.
 */
export function parseMacTraceLine(line: string, previous?: TraceHop): TraceHop | undefined {
  const head = /^\s*(\d+)\s+(.*)$/.exec(line);
  const cont = !head && previous && /^\s+\S/.test(line) ? line.trim() : undefined;
  if (!head && cont === undefined) return undefined;
  const hop: TraceHop = head
    ? { n: Number(head[1]), others: [], times: [], flags: [] }
    : { ...(previous as TraceHop), others: [...(previous as TraceHop).others], times: [...(previous as TraceHop).times], flags: [...(previous as TraceHop).flags] };
  const tokens = (head ? (head[2] as string) : (cont as string)).split(/\s+/);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (IPV4.test(t)) {
      if (!hop.ip) hop.ip = t;
      else if (t !== hop.ip && !hop.others.includes(t)) hop.others.push(t);
    } else if (t === '*') hop.times.push(null);
    else if (/^\d+(\.\d+)?$/.test(t) && tokens[i + 1] === 'ms') {
      hop.times.push(Number(t));
      i++;
    } else if (/^!\w*$/.test(t)) hop.flags.push(t);
  }
  return hop;
}

/**
 * One line of Windows `tracert -d` output: the hop number, three probe columns ("<1 ms", "12 ms"
 * or "*") and the address that answered, if any. The trailing text is localised, so only the
 * address is read from it.
 */
export function parseWindowsTraceLine(line: string): TraceHop | undefined {
  const m = /^\s*(\d+)\s+((?:(?:<?\d+\s*ms|\*)\s+){3})(.*)$/.exec(line);
  if (!m) return undefined;
  const times = [...(m[2] as string).matchAll(/<?(\d+)\s*ms|\*/g)].map((x) => (x[0] === '*' ? null : x[0].startsWith('<') ? 0.5 : Number(x[1])));
  const addr = /((?:\d{1,3}\.){3}\d{1,3})/.exec(m[3] as string)?.[1];
  return { n: Number(m[1]), ip: addr && IPV4.test(addr) ? addr : undefined, others: [], times, flags: [] };
}

/** Loss and average of a hop's probes. */
export function hopStats(hop: TraceHop): { lossPct: number; avgMs?: number } {
  const got = hop.times.filter((t): t is number => t !== null);
  const lossPct = hop.times.length ? Math.round(((hop.times.length - got.length) / hop.times.length) * 100) : 100;
  return { lossPct, avgMs: got.length ? Math.round((got.reduce((a, b) => a + b, 0) / got.length) * 10) / 10 : undefined };
}

/** The public addresses this network uses on the internet. */
export interface PublicAddress {
  ipv4?: string;
  ipv6?: string;
  /** Reverse DNS name of the IPv4 address; it usually names the internet provider. */
  name?: string;
  /** Organisation that announces the address on the internet: the internet provider. */
  provider?: string;
  /** Its autonomous system number. */
  asn?: number;
}

const IPV6 = /^[0-9a-f:.]+$/i;
const isIpv6 = (s: string) => s.includes(':') && IPV6.test(s) && s.length <= 45;

/**
 * Reads the address from a trace page ("key=value" lines, one of them "ip=…"), for one address
 * family. Returns undefined when the page holds no address of that family.
 */
export function readTraceAddress(text: string, family: 4 | 6): string | undefined {
  const ip = /^ip=(.+)$/m.exec(text)?.[1]?.trim() ?? '';
  return (family === 4 ? IPV4.test(ip) : isIpv6(ip)) ? ip : undefined;
}

/** Joins the IPv4 and IPv6 answers; undefined when neither family has an address. */
export function combinePublicAddress(ipv4?: string, ipv6?: string, name?: string, network?: { asn: number; name?: string }): PublicAddress | undefined {
  if (!ipv4 && !ipv6) return undefined;
  const out: PublicAddress = {};
  if (ipv4) out.ipv4 = ipv4;
  if (ipv6) out.ipv6 = ipv6;
  if (name) out.name = name;
  if (network) {
    out.asn = network.asn;
    if (network.name) out.provider = network.name;
  }
  return out;
}

/** Zone of the public DNS service that maps addresses to the network that announces them. */
const ASN_ZONE = 'asn.cymru.com';

/** The 32 hexadecimal digits of an IPv6 address, or undefined when it is not one. */
function ipv6Digits(ip: string): string | undefined {
  if (!isIpv6(ip) || ip.includes('.')) return undefined;
  const halves = ip.toLowerCase().split('::');
  if (halves.length > 2) return undefined;
  const head = halves[0] ? (halves[0] as string).split(':') : [];
  const tail = halves.length === 2 && halves[1] ? (halves[1] as string).split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return undefined;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

/** DNS name whose TXT record tells which network announces an address. */
export function originQueryName(ip: string): string | undefined {
  if (IPV4.test(ip)) return `${ip.split('.').reverse().join('.')}.origin.${ASN_ZONE}`;
  const digits = ipv6Digits(ip);
  return digits ? `${[...digits].reverse().join('.')}.origin6.${ASN_ZONE}` : undefined;
}

/** DNS name whose TXT record describes one network. */
export const asnQueryName = (asn: number) => `AS${asn}.${ASN_ZONE}`;

/** Network number from an origin answer such as "64496 | 203.0.113.0/24 | US | arin | 2006-06-28". */
export function asnOrigin(records: string[]): number | undefined {
  const first = records[0]?.split('|')[0]?.trim().split(/\s+/)[0];
  const asn = first ? Number(first) : NaN;
  return Number.isInteger(asn) && asn > 0 ? asn : undefined;
}

/**
 * Organisation name from a network answer such as "64496 | US | arin | 1997-02-14 | EXAMPLE-64496 -
 * Example Cable Services, LLC, US": the part after the network handle, without the country.
 */
export function asnName(records: string[]): string | undefined {
  const field = records[0]?.split('|').slice(4).join('|').trim();
  if (!field) return undefined;
  const noCountry = field.replace(/,\s*[A-Z]{2}$/, '').trim();
  const dash = noCountry.indexOf(' - ');
  const name = (dash >= 0 ? noCountry.slice(dash + 3) : noCountry).trim();
  return name ? name.slice(0, 120) : undefined;
}
