import { describe, expect, it } from 'vitest';
import { buildReportHtml, inCidr, printedSections, reportFindings, summaryLines, type ReportData, publicAddressText } from '../src/shared/report';
import type { RiskFinding } from '../src/shared/types';

const telnet: RiskFinding = { ruleId: 'telnet-open', severity: 'high', title: 'Telnet is enabled', detail: 'Turn Telnet off.' };
const smb: RiskFinding = { ruleId: 'smb-open', severity: 'low', title: 'File sharing (SMB) is reachable', detail: 'Limit it.' };

const base: ReportData = {
  title: 'Harbor <Office>',
  cidr: '10.0.0.0/24',
  date: '2026-11-05T20:00:00.000Z',
  branding: { company: 'Acme "IT"', preparedBy: 'J. Doe', credit: false },
  devices: [{ name: 'printer', ip: '10.0.0.9', type: 'printer', ports: 2, risks: 1, worst: 'high' }],
  findings: [],
  gear: 1,
};

describe('reportFindings', () => {
  it('groups devices by risk, loops first among high, then checks', () => {
    const f = reportFindings(
      [
        { ip: '10.0.0.9', risks: [telnet, smb] },
        { ip: '10.0.0.10', risks: [telnet] },
      ],
      (a) => (a.ip === '10.0.0.9' ? 'printer' : a.ip),
      [{ switchIp: '10.0.0.2', switchName: 'Core', ports: ['gi1', 'gi21'] }],
      [{ name: 'DNS', status: 'warn', summary: 'Slow answers' }],
    );
    expect(f.map((x) => x.severity)).toEqual(['high', 'high', 'medium', 'low']);
    expect(f[0]?.title).toBe('Network loop on Core');
    expect(f[1]?.affected).toEqual(['printer (10.0.0.9)', '10.0.0.10']);
    expect(f[2]?.title).toBe('DNS: Slow answers');
  });
});

describe('buildReportHtml', () => {
  it('escapes everything the user typed', () => {
    const html = buildReportHtml(base, { sections: ['cover', 'inventory', 'signoff'], paper: 'letter', mapOrientation: 'auto', summary: '<script>x</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('Harbor &lt;Office&gt;');
    expect(html).toContain('Acme &quot;IT&quot;');
    // In CSS strings (page header) quotes are escaped for CSS.
    expect(html).toContain('content:"Acme \\"IT\\" · Harbor \\3c Office>"');
  });

  it('only prints sections that were chosen and have content', () => {
    expect(printedSections({}, { sections: ['cover', 'map', 'connectivity', 'inventory'] })).toEqual(['cover', 'inventory']);
    const html = buildReportHtml(base, { sections: ['inventory'], paper: 'a4', mapOrientation: 'auto' });
    expect(html).toContain('size:A4');
    expect(html).not.toContain('class="cover"');
    expect(html).toContain('<span>1</span>Device inventory');
  });

  it('puts a wide map on a landscape page and ignores images that are not data URLs', () => {
    const wide = { ...base, map: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 2000, height: 800 } };
    expect(buildReportHtml(wide, { sections: ['map'], paper: 'letter', mapOrientation: 'auto' })).toContain('@page map{size:letter landscape}');
    expect(buildReportHtml(wide, { sections: ['map'], paper: 'letter', mapOrientation: 'portrait' })).toContain('@page map{size:letter portrait}');
    const bad = { ...base, map: { dataUrl: 'https://example.com/x.png', width: 1, height: 1 }, branding: { ...base.branding, logo: 'javascript:alert(1)' } };
    const html = buildReportHtml(bad, { sections: ['cover', 'map'], paper: 'letter', mapOrientation: 'auto' });
    expect(html).not.toContain('example.com');
    expect(html).not.toContain('javascript:');
  });

  it('adds the footer credit only when asked', () => {
    expect(buildReportHtml(base, { sections: ['cover'], paper: 'letter', mapOrientation: 'auto' })).not.toContain('Prepared with Meshwork');
    const credit = { ...base, branding: { ...base.branding, credit: true } };
    expect(buildReportHtml(credit, { sections: ['cover'], paper: 'letter', mapOrientation: 'auto' })).toContain('Prepared with Meshwork');
  });
});

describe('summaryLines', () => {
  it('says when nothing needs attention', () => {
    expect(summaryLines({ ...base, devices: [], gear: 0 })).toEqual(['0 devices were found on 10.0.0.0/24.', 'No problems were found that need attention.']);
  });
});

describe('inCidr', () => {
  it('matches addresses in the range', () => {
    expect(inCidr('10.10.0.81', '10.10.0.0/24')).toBe(true);
    expect(inCidr('10.0.0.81', '10.10.0.0/24')).toBe(false);
    expect(inCidr(undefined, '10.10.0.0/24')).toBe(false);
    expect(inCidr('192.168.5.4', '0.0.0.0/0')).toBe(true);
  });
});

describe('public address in the report', () => {
  it('names both addresses and the reverse name, or says nothing without an address', () => {
    expect(publicAddressText({ ipv4: '203.0.113.7', ipv6: '2001:db8::7', name: 'c-203-0-113-7.example.net' })).toBe(
      'Public address 203.0.113.7 (c-203-0-113-7.example.net) · IPv6 2001:db8::7',
    );
    expect(publicAddressText({ ipv6: '2001:db8::7' })).toBe('Public address 2001:db8::7');
    expect(publicAddressText({ ipv4: '203.0.113.7', provider: 'Example Cable', asn: 64500 })).toBe('Public address 203.0.113.7 · provider Example Cable (AS64500)');
    expect(publicAddressText({ name: 'x.example.net' })).toBeUndefined();
    expect(publicAddressText(undefined)).toBeUndefined();
  });
});
