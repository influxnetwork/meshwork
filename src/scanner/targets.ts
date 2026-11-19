import { networkInterfaces } from 'node:os';
import type { LocalTarget, TargetParseResult } from '@shared/types';

/** Upper bound on addresses in a single scan; larger inputs are rejected. */
export const MAX_TARGETS = 65_536;

export interface Ipv4Range {
  start: number;
  end: number;
}

const OCTET = '(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4 = new RegExp(`^${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);

export function isIpv4(text: string): boolean {
  return IPV4.test(text);
}

export function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

export function intToIp(n: number): string {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/** Mask length to the number of addresses it covers. */
function blockSize(prefix: number): number {
  return 2 ** (32 - prefix);
}

/**
 * Parses one target token.
 * Accepts "10.0.0.1", "10.0.0.1-10.0.0.50", "10.0.0.1-50" (last-octet shorthand),
 * "10.0.0.0/24" and "localhost". For CIDR blocks of /30 or wider the network and
 * broadcast addresses are skipped.
 */
export function parseToken(token: string): Ipv4Range {
  const t = token.trim().toLowerCase();
  if (t === 'localhost') return { start: ipToInt('127.0.0.1'), end: ipToInt('127.0.0.1') };

  if (t.includes('/')) {
    const [base, bits] = t.split('/');
    const prefix = Number(bits);
    if (!base || !isIpv4(base) || bits === '' || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
      throw new Error(`"${token}" is not a valid CIDR block`);
    }
    const size = blockSize(prefix);
    const network = Math.floor(ipToInt(base) / size) * size;
    if (prefix >= 31) return { start: network, end: network + size - 1 };
    return { start: network + 1, end: network + size - 2 };
  }

  if (t.includes('-')) {
    const [from, to] = t.split('-').map((s) => s.trim());
    if (!from || !to || !isIpv4(from)) throw new Error(`"${token}" is not a valid range`);
    let end: number;
    if (isIpv4(to)) end = ipToInt(to);
    else if (/^\d{1,3}$/.test(to) && Number(to) <= 255) end = ipToInt(from) - (ipToInt(from) % 256) + Number(to);
    else throw new Error(`"${token}" is not a valid range`);
    const start = ipToInt(from);
    if (end < start) throw new Error(`"${token}" ends before it starts`);
    return { start, end };
  }

  if (!isIpv4(t)) throw new Error(`"${token}" is not an IPv4 address, range or CIDR block`);
  const n = ipToInt(t);
  return { start: n, end: n };
}

export function splitTargets(text: string): string[] {
  return text
    .split(/[;,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Merges overlapping and adjacent ranges so no address is scanned twice. */
export function mergeRanges(ranges: Ipv4Range[]): Ipv4Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: Ipv4Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

export function countAddresses(ranges: Ipv4Range[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start + 1), 0);
}

export function parseTargets(text: string): { ranges: Ipv4Range[]; errors: string[] } {
  const ranges: Ipv4Range[] = [];
  const errors: string[] = [];
  for (const token of splitTargets(text)) {
    try {
      ranges.push(parseToken(token));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return { ranges: mergeRanges(ranges), errors };
}

export function describeTargets(text: string): TargetParseResult {
  const { ranges, errors } = parseTargets(text);
  const count = countAddresses(ranges);
  let largest: TargetParseResult['largest'];
  if (count > MAX_TARGETS) {
    for (const target of splitTargets(text)) {
      try {
        const r = parseToken(target);
        const size = r.end - r.start + 1;
        if (size > MAX_TARGETS && size > (largest?.count ?? 0)) largest = { target, count: size };
      } catch {
        // A target that does not parse is already in `errors`.
      }
    }
  }
  return { count, errors, tooLarge: count > MAX_TARGETS, largest };
}

export function* expandRanges(ranges: Ipv4Range[]): Generator<string> {
  for (const r of ranges) for (let n = r.start; n <= r.end; n++) yield intToIp(n);
}

export function rangeContains(ranges: Ipv4Range[], ip: string): boolean {
  const n = ipToInt(ip);
  return ranges.some((r) => n >= r.start && n <= r.end);
}

/**
 * Suggests one target per active IPv4 interface (its own subnet), skipping loopback,
 * link-local and point-to-point links. Subnets wider than /22 are narrowed to the
 * /24 around the interface address so the default scan stays quick.
 */
export function localTargets(): LocalTarget[] {
  const out: LocalTarget[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const prefix = Number(a.cidr?.split('/')[1] ?? 24);
      if (prefix >= 31) continue;
      const usePrefix = prefix < 22 ? 24 : prefix;
      const size = blockSize(usePrefix);
      const network = Math.floor(ipToInt(a.address) / size) * size;
      out.push({ iface, address: a.address, cidr: `${intToIp(network)}/${usePrefix}`, hosts: size - 2 });
    }
  }
  return out;
}
