/**
 * Mac App Store build: the bundled meshwork-net helper must print text that the existing
 * traceroute and ARP parsers read exactly as they read the system tools.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArp } from '../src/scanner/probes';
import { isAppStoreBuild, loadArpModule, sandboxArpText, sandboxNetHelper } from '../src/scanner/sandbox-net';
import { parseMacTraceLine, parseTraceDestination } from '../src/shared/diagnose';

const BIN = join(import.meta.dirname, '..', 'resources', 'bin', 'mac');
const HELPER = join(BIN, 'meshwork-net');
const ARP_MODULE = join(BIN, 'meshwork-arp.node');
const live = process.platform === 'darwin' && existsSync(HELPER) && existsSync(ARP_MODULE);

describe('App Store build detection', () => {
  it('is off outside a Mac App Store build, so other builds keep the system tools', () => {
    expect(isAppStoreBuild()).toBe(false);
    expect(sandboxNetHelper()).toBeUndefined();
    expect(sandboxArpText()).toBeUndefined();
  });
});

describe('helper output format', () => {
  it('trace lines parse like traceroute -n -I lines', () => {
    expect(parseTraceDestination('traceroute to one.one.one.one (1.1.1.1), 30 hops max, 48 byte packets')).toBe('1.1.1.1');
    expect(parseMacTraceLine(' 1  10.0.0.1  2.803 ms  2.089 ms  3.184 ms')).toEqual({ n: 1, ip: '10.0.0.1', others: [], times: [2.803, 2.089, 3.184], flags: [] });
    expect(parseMacTraceLine(' 7  * * 198.51.100.49  16.606 ms')).toEqual({ n: 7, ip: '198.51.100.49', others: [], times: [null, null, 16.606], flags: [] });
    expect(parseMacTraceLine(' 9  * * *')).toEqual({ n: 9, others: [], times: [null, null, null], flags: [] });
    expect(parseMacTraceLine(' 4  10.1.1.1  1.000 ms 10.1.1.2  2.000 ms  3.000 ms')).toEqual({ n: 4, ip: '10.1.1.1', others: ['10.1.1.2'], times: [1, 2, 3], flags: [] });
    expect(parseMacTraceLine(' 3  192.0.2.1  5.500 ms !H')).toEqual({ n: 3, ip: '192.0.2.1', others: [], times: [5.5], flags: ['!H'] });
  });

  it('arp lines parse like arp -an lines, incomplete entries skipped', () => {
    const out = '? (10.0.0.1) at a0:b1:c:d3:e4:5 on en0 ifscope [ethernet]\n? (10.0.0.9) at (incomplete) on en0 ifscope [ethernet]\n';
    expect([...parseArp(out)]).toEqual([['10.0.0.1', 'a0:b1:0c:d3:e4:05']]);
  });
});

describe.skipIf(!live)('helper against the system tools (this Mac)', () => {
  it('the module reads the same ARP table as /usr/sbin/arp -an', (ctx) => {
    const text = loadArpModule(ARP_MODULE).arpTable();
    expect(typeof text).toBe('string');
    const system = parseArp(execFileSync('/usr/sbin/arp', ['-an'], { encoding: 'utf8' }));
    const helper = parseArp(text);
    // macOS shows hardware addresses only to a process holding the topology-observation
    // entitlement; the test runner has none, the signed app does.
    if (helper.size === 0 || system.size === 0) ctx.skip();
    // Entries can appear or expire between the two reads; the shared ones must agree.
    const shared = [...helper.keys()].filter((ip) => system.has(ip));
    expect(shared.length).toBeGreaterThan(0);
    for (const ip of shared) expect(helper.get(ip)).toBe(system.get(ip));
  });

  it('traces the first hop to the default gateway', () => {
    const gateway = /gateway:\s*(\S+)/.exec(execFileSync('/sbin/route', ['-n', 'get', 'default'], { encoding: 'utf8' }))?.[1];
    if (!gateway) return;
    const out = execFileSync(HELPER, ['trace', gateway, '2', '1', '1'], { encoding: 'utf8', timeout: 10_000 });
    const hop = parseMacTraceLine(out.split('\n')[0] ?? '');
    expect(hop?.n).toBe(1);
    expect(hop?.ip).toBe(gateway);
  });
});
