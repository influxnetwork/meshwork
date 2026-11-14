import { describe, expect, it } from 'vitest';
import {
  asnName,
  asnOrigin,
  originQueryName,
  combinePublicAddress,
  readTraceAddress,
  gradePing,
  hopStats,
  isTraceTarget,
  parseMacTraceLine,
  parseServiceTarget,
  parseTraceDestination,
  parseWindowsTraceLine,
  pingStats,
  compareAnswers,
  explainMtu,
  verdict,
  type CheckStep,
  type TraceHop,
} from '../src/shared/diagnose';

const step = (id: CheckStep['id'], status: CheckStep['status']): CheckStep => ({ id, status, summary: '', details: [] });

describe('connectivity verdict', () => {
  it('blames the first failing link in chain order', () => {
    const v = verdict([step('local', 'ok'), step('gateway', 'ok'), step('dns', 'fail'), step('internet', 'fail')]);
    expect(v).toMatchObject({ status: 'fail', culprit: 'dns' });
  });

  it('points at the provider when only the internet fails', () => {
    const v = verdict([step('local', 'ok'), step('gateway', 'ok'), step('dns', 'ok'), step('internet', 'fail')]);
    expect(v.culprit).toBe('internet');
    expect(v.text).toMatch(/provider/);
  });

  it('names the warnings when nothing fails', () => {
    const v = verdict([step('local', 'ok'), step('gateway', 'warn'), step('dns', 'ok'), step('internet', 'warn')]);
    expect(v.status).toBe('warn');
    expect(v.text).toContain('gateway and internet');
    expect(verdict([step('local', 'ok'), step('gateway', 'ok'), step('dns', 'ok'), step('internet', 'ok')]).status).toBe('ok');
  });

  it('grades pings by loss and speed', () => {
    expect(gradePing(100, undefined, 20)).toBe('fail');
    expect(gradePing(25, 3, 20)).toBe('warn');
    expect(gradePing(0, 40, 20)).toBe('warn');
    expect(gradePing(0, 2, 20)).toBe('ok');
  });
});

describe('service target', () => {
  it('reads hosts, host:port and web addresses', () => {
    expect(parseServiceTarget('erp.example.com')).toEqual({ host: 'erp.example.com', port: 443, url: 'https://erp.example.com/', label: 'erp.example.com' });
    expect(parseServiceTarget('10.0.5.20:3389')).toEqual({ host: '10.0.5.20', port: 3389, url: undefined, label: '10.0.5.20:3389' });
    expect(parseServiceTarget('intranet:80')).toMatchObject({ port: 80, url: 'http://intranet/' });
    expect(parseServiceTarget('https://portal.example.com:8443/login')).toMatchObject({ host: 'portal.example.com', port: 8443, url: 'https://portal.example.com:8443/login' });
    expect(parseServiceTarget('http://192.0.2.10/')).toMatchObject({ host: '192.0.2.10', port: 80 });
  });

  it('rejects anything else', () => {
    for (const bad of ['', '   ', 'host:99999', 'host:0', '-x', 'ftp://files.example.com', 'two words', 'a;b']) expect(parseServiceTarget(bad)).toBeUndefined();
  });

  it('blames the service when only it fails', () => {
    const v = verdict([step('local', 'ok'), step('gateway', 'ok'), step('dns', 'ok'), step('internet', 'ok'), step('service', 'fail')]);
    expect(v.culprit).toBe('service');
  });
});

describe('traceroute parsing', () => {
  it('accepts host names and addresses but never an option', () => {
    expect(isTraceTarget('1.1.1.1')).toBe(true);
    expect(isTraceTarget('meshwork.influxnetwork.com')).toBe(true);
    expect(isTraceTarget('-I')).toBe(false);
    expect(isTraceTarget('host; rm -rf /')).toBe(false);
    expect(isTraceTarget('')).toBe(false);
  });

  it('reads the destination from macOS and localised Windows headers', () => {
    expect(parseTraceDestination('traceroute to one.one.one.one (1.1.1.1), 30 hops max, 48 byte packets')).toBe('1.1.1.1');
    expect(parseTraceDestination('Tracing route to one.one.one.one [1.1.1.1]')).toBe('1.1.1.1');
    expect(parseTraceDestination('Traza a la dirección one.one.one.one [1.1.1.1]')).toBe('1.1.1.1');
    expect(parseTraceDestination('over a maximum of 30 hops:')).toBeUndefined();
  });

  it('parses macOS hops, timeouts and extra responders', () => {
    expect(parseMacTraceLine(' 1  10.0.0.1  2.371 ms  1.881 ms  1.893 ms')).toEqual({ n: 1, ip: '10.0.0.1', others: [], times: [2.371, 1.881, 1.893], flags: [] });
    expect(parseMacTraceLine(' 7  * * *')).toEqual({ n: 7, others: [], times: [null, null, null], flags: [] });
    const first = parseMacTraceLine(' 2  10.20.30.83  10.465 ms') as TraceHop;
    const more = parseMacTraceLine('    10.20.30.82  17.100 ms  15.325 ms', first) as TraceHop;
    expect(more).toMatchObject({ n: 2, ip: '10.20.30.83', others: ['10.20.30.82'], times: [10.465, 17.1, 15.325] });
    expect(first.times).toHaveLength(1);
    expect(parseMacTraceLine(' 9  192.0.2.1  3.2 ms !H  * 4.0 ms !H')).toMatchObject({ times: [3.2, null, 4], flags: ['!H', '!H'] });
    expect(parseMacTraceLine('traceroute to 1.1.1.1 (1.1.1.1), 30 hops max')).toBeUndefined();
  });

  it('parses Windows hops in any language', () => {
    expect(parseWindowsTraceLine('  1    <1 ms    <1 ms    <1 ms  192.168.1.1')).toEqual({ n: 1, ip: '192.168.1.1', others: [], times: [0.5, 0.5, 0.5], flags: [] });
    expect(parseWindowsTraceLine('  3    12 ms    11 ms     *     10.0.0.1')).toMatchObject({ times: [12, 11, null], ip: '10.0.0.1' });
    expect(parseWindowsTraceLine('  4     *        *        *     Request timed out.')).toMatchObject({ n: 4, ip: undefined, times: [null, null, null] });
    expect(parseWindowsTraceLine('  4     *        *        *     Tiempo de espera agotado para esta solicitud.')).toMatchObject({ ip: undefined });
    expect(parseWindowsTraceLine('Tracing route to 1.1.1.1 over a maximum of 30 hops')).toBeUndefined();
  });

  it('summarises a hop as loss and average', () => {
    expect(hopStats({ n: 1, others: [], times: [2, null, 4], flags: [] })).toEqual({ lossPct: 33, avgMs: 3 });
    expect(hopStats({ n: 1, others: [], times: [null, null, null], flags: [] })).toEqual({ lossPct: 100, avgMs: undefined });
  });
});

import { parsePingOutput } from '../src/scanner/probes';

describe('single ping output', () => {
  it('reads the round trip in any language', () => {
    expect(parsePingOutput('64 bytes from 1.1.1.1: icmp_seq=0 ttl=57 time=13.1 ms', 0)).toEqual({ alive: true, ttl: 57, rttMs: 13.1 });
    expect(parsePingOutput('Respuesta desde 10.0.0.1: bytes=32 tiempo=3ms TTL=64', 0)).toEqual({ alive: true, ttl: 64, rttMs: 3 });
    expect(parsePingOutput('Antwort von 10.0.0.1: Bytes=32 Zeit<1ms TTL=64', 0)).toEqual({ alive: true, ttl: 64, rttMs: 1 });
    expect(parsePingOutput('Request timeout for icmp_seq 0', 2)).toMatchObject({ alive: false });
  });
});

describe('live ping statistics', () => {
  it('counts loss, range, jitter and each drop', () => {
    const at = (i: number) => 1000 * i;
    const s = pingStats([
      { at: at(0), rttMs: 10 },
      { at: at(1), rttMs: 14 },
      { at: at(2) },
      { at: at(3) },
      { at: at(4), rttMs: 12 },
      { at: at(5) },
    ]);
    expect(s).toMatchObject({ sent: 6, received: 3, lossPct: 50, minMs: 10, maxMs: 14, avgMs: 12, jitterMs: 3 });
    expect(s.outages).toEqual([{ at: at(2), lost: 2 }, { at: at(5), lost: 1 }]);
  });

  it('handles an empty run', () => {
    expect(pingStats([])).toMatchObject({ sent: 0, lossPct: 0, outages: [] });
  });
});

describe('DNS comparison and MTU', () => {
  it('tells normal variation from an internal or missing record', () => {
    const a = (source: 'Network' | 'Public', records: string[], error?: string) => ({ server: 's', source, records, error });
    expect(compareAnswers([a('Network', ['198.51.100.4', '203.0.113.8']), a('Public', ['203.0.113.8', '198.51.100.4'])])).toBe('same');
    expect(compareAnswers([a('Network', ['140.82.112.3']), a('Public', ['140.82.113.4'])])).toBe('varies');
    expect(compareAnswers([a('Network', ['10.0.0.5']), a('Public', ['203.0.113.5'])])).toBe('internal');
    expect(compareAnswers([a('Network', ['10.0.0.5']), a('Public', [], 'No such record')])).toBe('missing');
    expect(compareAnswers([a('Network', ['10.0.0.5']), a('Public', [], 'No answer from server')])).toBe('same');
    expect(compareAnswers([a('Network', [], 'No such record'), a('Public', [], 'No such record')])).toBe('none');
  });

  it('explains common path sizes', () => {
    expect(explainMtu(1500).status).toBe('ok');
    expect(explainMtu(1492).explanation).toMatch(/PPPoE/);
    expect(explainMtu(1420).status).toBe('warn');
    expect(explainMtu(1280).status).toBe('fail');
  });
});

describe('public address', () => {
  const trace = (ip: string) => `fl=29f\nh=1.1.1.1\nip=${ip}\nts=1793988074.1\nloc=US\nwarp=off\n`;

  it('reads the address from the trace page, for the asked family only', () => {
    expect(readTraceAddress(trace('203.0.113.7'), 4)).toBe('203.0.113.7');
    expect(readTraceAddress(trace('2001:db8::7'), 6)).toBe('2001:db8::7');
    // An IPv4 answer to the IPv6 request (or the reverse) is not that family's address.
    expect(readTraceAddress(trace('203.0.113.7'), 6)).toBeUndefined();
    expect(readTraceAddress(trace('2001:db8::7'), 4)).toBeUndefined();
  });

  it('ignores pages that hold no address', () => {
    expect(readTraceAddress('', 4)).toBeUndefined();
    expect(readTraceAddress('<html>blocked by proxy</html>', 4)).toBeUndefined();
    expect(readTraceAddress(trace('999.1.1.1'), 4)).toBeUndefined();
    expect(readTraceAddress(trace('hello'), 6)).toBeUndefined();
    expect(readTraceAddress('xip=203.0.113.7\n', 4)).toBeUndefined();
  });

  it('combines the IPv4 and IPv6 answers with the reverse name', () => {
    expect(combinePublicAddress('203.0.113.7', '2001:db8::7', 'c-203-0-113-7.example.net')).toEqual({
      ipv4: '203.0.113.7',
      ipv6: '2001:db8::7',
      name: 'c-203-0-113-7.example.net',
    });
    expect(combinePublicAddress(undefined, '2001:db8::7')).toEqual({ ipv6: '2001:db8::7' });
    expect(combinePublicAddress(undefined, undefined, 'x.example.net')).toBeUndefined();
    expect(combinePublicAddress('203.0.113.7', undefined, undefined, { asn: 64500, name: 'Example Cable' })).toEqual({
      ipv4: '203.0.113.7',
      asn: 64500,
      provider: 'Example Cable',
    });
  });
});

describe('internet provider by ASN', () => {
  it('builds the origin query name for IPv4 and IPv6', () => {
    expect(originQueryName('203.0.113.45')).toBe('45.113.0.203.origin.asn.cymru.com');
    expect(originQueryName('2001:db8:85a3::8a2e:370:7334')).toBe(
      '4.3.3.7.0.7.3.0.e.2.a.8.0.0.0.0.0.0.0.0.3.a.5.8.8.b.d.0.1.0.0.2.origin6.asn.cymru.com',
    );
    expect(originQueryName('2001:db8::1')).toBe('1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2.origin6.asn.cymru.com');
    expect(originQueryName('not an address')).toBeUndefined();
  });

  it('reads the network number from the origin answer', () => {
    expect(asnOrigin(['64496 | 203.0.113.0/24 | US | arin | 2006-06-28'])).toBe(64496);
    // A prefix announced by several networks lists them all; the first one is used.
    expect(asnOrigin(['15169 36040 | 8.8.8.0/24 | US | arin | 1992-12-01'])).toBe(15169);
    expect(asnOrigin([])).toBeUndefined();
    expect(asnOrigin(['garbage'])).toBeUndefined();
  });

  it('reads the organisation name from the network answer', () => {
    expect(asnName(['64496 | US | arin | 1997-02-14 | EXAMPLE-64496 - Example Cable Services, LLC, US'])).toBe('Example Cable Services, LLC');
    expect(asnName(['15169 | US | arin | 2000-03-30 | GOOGLE, US'])).toBe('GOOGLE');
    expect(asnName(['3352 | ES | ripencc | 1994-11-14 | TELEFONICA_DE_ESPANA, ES'])).toBe('TELEFONICA_DE_ESPANA');
    expect(asnName([])).toBeUndefined();
    expect(asnName(['64496 | US | arin | 1997-02-14 | '])).toBeUndefined();
  });
});
