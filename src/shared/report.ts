/**
 * Site-visit report: turns what Meshwork knows about one network into a printable HTML document,
 * which the main process prints to PDF. Every section is optional; the technician's own name and
 * logo brand it.
 */
import type { Asset, DeviceType, Severity } from './types';
import type { PublicAddress } from './diagnose';
import type { NetworkLoop } from './loops';
import { describeLoop } from './loops';
import { type LinkMismatch, type MismatchEnd, describeEnd, mismatchAdvice } from './link-mismatch';

/** The technician's branding, saved once and reused for every report. */
export interface ReportBranding {
  company: string;
  preparedBy: string;
  /** Logo as a PNG or JPEG data URL. */
  logo?: string;
  /** Adds "Prepared with Meshwork" to the footer. */
  credit: boolean;
}

export type ReportSection = 'cover' | 'findings' | 'map' | 'connectivity' | 'inventory' | 'signoff';
export type ReportPaper = 'letter' | 'a4';

export interface ReportOptions {
  sections: ReportSection[];
  paper: ReportPaper;
  /** Orientation of the map page; auto picks landscape for wide maps. */
  mapOrientation: 'auto' | 'portrait' | 'landscape';
  /** Summary written by the technician for the cover; replaces the generated one when set. */
  summary?: string;
}

/** One problem worth the client's attention, with what to do about it. */
export interface ReportFinding {
  severity: Severity;
  title: string;
  detail: string;
  /** Devices or ports it applies to. */
  affected: string[];
}

/** One step of the connectivity check, as shown in Diagnose. */
export interface ReportCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skipped';
  summary: string;
  target?: string;
}

export interface ReportDevice {
  name: string;
  ip: string;
  mac?: string;
  vendor?: string;
  type: DeviceType;
  ports: number;
  risks: number;
  worst?: Severity;
}

export interface ReportData {
  /** Site or network name: the report's title. */
  title: string;
  cidr: string;
  /** When the report was made (ISO 8601). */
  date: string;
  branding: ReportBranding;
  devices: ReportDevice[];
  findings: ReportFinding[];
  /** Number of managed devices read over SNMP. */
  gear: number;
  map?: { dataUrl: string; width: number; height: number };
  checks?: ReportCheck[];
  /** When the connectivity check ran (ISO 8601). */
  checkedAt?: string;
  /** Public addresses seen during the connectivity check. */
  publicAddress?: PublicAddress;
  /** Embedded fonts as data URLs, so the PDF looks the same on every computer. */
  fonts?: { sans?: string; mono?: string };
}

/** "Public address 203.0.113.7 (reverse name) · IPv6 2001:db8::7 · provider X (AS1)", or nothing. */
export function publicAddressText(p?: PublicAddress): string | undefined {
  if (!p || (!p.ipv4 && !p.ipv6)) return undefined;
  const v4 = p.ipv4 ? `${p.ipv4}${p.name ? ` (${p.name})` : ''}` : undefined;
  const v6 = p.ipv6 ? (v4 ? `IPv6 ${p.ipv6}` : p.ipv6) : undefined;
  const provider = p.provider ? `provider ${p.provider}${p.asn ? ` (AS${p.asn})` : ''}` : undefined;
  return `Public address ${[v4, v6, provider].filter(Boolean).join(' · ')}`;
}

const publicAddressLine = (p?: PublicAddress) => {
  const text = publicAddressText(p);
  return text ? `\n  <p class="intro">${esc(text)}.</p>` : '';
};

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const SEVERITY_LABEL: Record<Severity, string> = { high: 'High', medium: 'Medium', low: 'Low' };

/**
 * Findings for a network: a loop on a switch, each security risk the scan found (one finding per
 * risk, listing every device it affects) and each connectivity step that did not pass. Most severe first.
 */
export function reportFindings<A extends Pick<Asset, 'ip' | 'risks'>>(
  assets: A[],
  name: (a: A) => string,
  loops: NetworkLoop[] = [],
  checks: ReportCheck[] = [],
  mismatches: LinkMismatch[] = [],
): ReportFinding[] {
  const out: ReportFinding[] = [];
  for (const m of mismatches) {
    const who = (e: MismatchEnd) => e.name ?? e.ip ?? 'unknown device';
    out.push({
      severity: 'medium',
      title: `${m.kind === 'nativeVlan' ? 'Native VLAN' : 'Duplex'} mismatch between ${who(m.local)} and ${who(m.remote)}`,
      detail: mismatchAdvice(m.kind),
      affected: [describeEnd(m.kind, m.local), describeEnd(m.kind, m.remote)],
    });
  }
  for (const loop of loops) {
    out.push({
      severity: 'high',
      title: `Network loop on ${loop.switchName ?? loop.switchIp}`,
      detail: `${describeLoop(loop)}. The switch may block one of these ports, and devices behind it can lose their connection or never get an address. Unplug one of the cables.`,
      affected: loop.ports.map((p) => `${loop.switchName ?? loop.switchIp} ${p}`),
    });
  }
  const byRule = new Map<string, ReportFinding>();
  for (const a of assets) {
    for (const r of a.risks) {
      const f = byRule.get(r.ruleId) ?? { severity: r.severity, title: r.title, detail: r.detail, affected: [] };
      const n = name(a);
      f.affected.push(n === a.ip ? a.ip : `${n} (${a.ip})`);
      byRule.set(r.ruleId, f);
    }
  }
  out.push(...byRule.values());
  for (const c of checks) {
    if (c.status !== 'fail' && c.status !== 'warn') continue;
    out.push({ severity: c.status === 'fail' ? 'high' : 'medium', title: `${c.name}: ${c.summary}`, detail: checkAdvice(c.name), affected: c.target ? [c.target] : [] });
  }
  return out.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

/** What to check when a connectivity step does not pass. */
function checkAdvice(step: string): string {
  const s = step.toLowerCase();
  if (s.includes('gateway')) return 'This computer could not reach the router reliably. Check the cable or WiFi, the switch port and the router.';
  if (s.includes('dns')) return 'Names were slow or failed to resolve. Check the DNS servers handed out by DHCP, or use a reliable public resolver.';
  if (s.includes('internet')) return 'The router answered but the internet did not. Check the modem and the provider connection.';
  if (s.includes('service')) return 'The service did not answer. Check that it is running and that no firewall blocks it.';
  return 'This step did not pass. Check the connection from this computer to the network.';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
/** Only raster images embedded as data URLs are placed in the document. */
const image = (url: string | undefined) => (url && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : undefined);
const font = (url: string | undefined) => (url && /^data:(font\/woff2|application\/font-woff2|application\/octet-stream);base64,[A-Za-z0-9+/=]+$/.test(url) ? url : undefined);

/** True when an IPv4 address is inside a CIDR range ("10.0.0.0/24"). */
export function inCidr(address: string | undefined, cidr: string): boolean {
  const m = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(cidr);
  if (!address || !m) return false;
  const n = (ip: string) => ip.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 255), 0) >>> 0;
  const bits = Number(m[2]);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (n(address) & mask) === (n(m[1] as string) & mask);
}

/** Page width and height in inches for a paper and orientation. */
export function pageSize(paper: ReportPaper, landscape: boolean): { w: number; h: number } {
  const p = paper === 'a4' ? { w: 8.27, h: 11.69 } : { w: 8.5, h: 11 };
  return landscape ? { w: p.h, h: p.w } : p;
}

const MARGIN_X = 0.65;
const MARGIN_Y = 0.75;

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

const typeLabel = (t: DeviceType) => t.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());

type Numbered = Exclude<ReportSection, 'cover'>;
const SECTION_TITLE: Record<Numbered, string> = {
  findings: 'Findings and recommendations',
  map: 'Network map',
  connectivity: 'Connectivity checks',
  inventory: 'Device inventory',
  signoff: 'Sign-off',
};
/** Sections in the order they appear. */
const SECTION_ORDER: ReportSection[] = ['cover', 'findings', 'map', 'connectivity', 'inventory', 'signoff'];

/** The generated cover summary: one line per point the client should know. */
export function summaryLines(data: Pick<ReportData, 'devices' | 'findings' | 'gear' | 'cidr' | 'checks'>): string[] {
  const high = data.findings.filter((f) => f.severity === 'high').length;
  const lines: string[] = [];
  lines.push(`${data.devices.length} ${data.devices.length === 1 ? 'device was' : 'devices were'} found on ${data.cidr}${data.gear ? `, ${data.gear} of them managed network gear` : ''}.`);
  if (!data.findings.length) lines.push('No problems were found that need attention.');
  else lines.push(`${data.findings.length} ${data.findings.length === 1 ? 'finding needs' : 'findings need'} attention${high ? `, ${high} of them high priority` : ''}.`);
  const failed = data.checks?.filter((c) => c.status === 'fail') ?? [];
  if (data.checks?.length) lines.push(failed.length ? `The connectivity check failed at: ${failed.map((c) => c.name.toLowerCase()).join(', ')}.` : 'The connectivity check from this site passed.');
  return lines;
}

/** Sections that will actually be printed: the map and checks only when there is something to show. */
export function printedSections(data: Pick<ReportData, 'map' | 'checks'>, options: Pick<ReportOptions, 'sections'>): ReportSection[] {
  const on = new Set(options.sections);
  return SECTION_ORDER.filter((s) => on.has(s) && (s !== 'map' || !!image(data.map?.dataUrl)) && (s !== 'connectivity' || !!data.checks?.length));
}

/** The whole report as one HTML document, ready to print. */
export function buildReportHtml(data: ReportData, options: ReportOptions): string {
  const sections = printedSections(data, options);
  const numbered = sections.filter((s): s is Numbered => s !== 'cover');
  const title = (s: Numbered) => `<h2 class="title"><span>${numbered.indexOf(s) + 1}</span>${SECTION_TITLE[s]}</h2>`;
  const b = data.branding;
  const logo = image(b.logo);
  const map = data.map && image(data.map.dataUrl) ? data.map : undefined;
  const mapLandscape = options.mapOrientation === 'landscape' || (options.mapOrientation === 'auto' && !!map && map.width / map.height > 1.15);
  const mapPage = pageSize(options.paper, mapLandscape);
  const paperName = options.paper === 'a4' ? 'A4' : 'letter';
  const company = b.company.trim();
  const head = [company, data.title].filter(Boolean).join(' · ');
  const foot = b.credit ? 'Prepared with Meshwork' : '';
  // Text placed in CSS content strings: quotes and backslashes escaped, line breaks dropped.
  const cssText = (s: string) => `"${s.replace(/[\r\n]+/g, ' ').replace(/["\\]/g, '\\$&').replace(/</g, '\\3c ')}"`;

  const parts: string[] = [];

  if (sections.includes('cover')) {
    const high = data.findings.filter((f) => f.severity === 'high').length;
    const verdict = !data.findings.length ? 'ok' : high ? 'bad' : 'warn';
    const verdictText = !data.findings.length ? 'No problems found' : `${data.findings.length} ${data.findings.length === 1 ? 'finding' : 'findings'} to review`;
    const custom = options.summary?.trim();
    parts.push(`<section class="cover">
  <div class="cover-top">
    <div class="brand">${logo ? `<img src="${logo}" alt="">` : ''}${company ? `<b>${esc(company)}</b>` : ''}</div>
    <span class="kind">Site visit report</span>
  </div>
  <h1>${esc(data.title)}</h1>
  <p class="lede">Network ${esc(data.cidr)}</p>
  <dl class="meta">
    <div><dt>Date</dt><dd>${esc(formatDate(data.date))}</dd></div>
    <div><dt>Prepared by</dt><dd>${esc(b.preparedBy.trim() || company || '—')}</dd></div>
    <div><dt>Network</dt><dd class="mono">${esc(data.cidr)}</dd></div>
    <div><dt>Devices</dt><dd>${data.devices.length}</dd></div>
  </dl>
  <div class="verdict ${verdict}"><i></i><div><b>${esc(verdictText)}</b>${high ? `<p>${high} high priority</p>` : ''}</div></div>
  <div class="stats">
    <div><b>${data.devices.length}</b><span>Devices</span></div>
    <div><b>${data.gear}</b><span>Managed gear</span></div>
    <div><b>${data.devices.filter((d) => d.risks).length}</b><span>Devices with risks</span></div>
    <div><b class="${high ? 'red' : ''}">${data.findings.length}</b><span>Findings</span></div>
  </div>
  <h3>Summary</h3>
  ${
    custom
      ? `<div class="custom">${custom
          .split(/\n{2,}/)
          .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
          .join('')}</div>`
      : `<ul class="summary">${summaryLines(data)
          .map((l) => `<li>${esc(l)}</li>`)
          .join('')}</ul>`
  }
  ${numbered.length ? `<h3>Contents</h3><ol class="toc">${numbered.map((s) => `<li>${SECTION_TITLE[s]}</li>`).join('')}</ol>` : ''}
</section>`);
  }

  if (sections.includes('findings')) {
    const counts = (['high', 'medium', 'low'] as Severity[]).map((s) => [s, data.findings.filter((f) => f.severity === s).length] as const);
    const list = data.findings
      .map(
        (f, i) => `<div class="finding">
    <div class="fhead"><span class="fnum">${String(i + 1).padStart(2, '0')}</span><span class="sev ${f.severity}">${SEVERITY_LABEL[f.severity]}</span><h4>${esc(f.title)}</h4></div>
    <p>${esc(f.detail)}</p>
    ${
      f.affected.length
        ? `<p class="affected"><b>Affects${f.affected.length === 1 ? '' : ` ${f.affected.length}`}:</b> ${f.affected.slice(0, 12).map(esc).join(', ')}${f.affected.length > 12 ? `, and ${f.affected.length - 12} more` : ''}</p>`
        : ''
    }
  </div>`,
      )
      .join('\n');
    parts.push(`<section class="break">
  ${title('findings')}
  <p class="intro">Problems found on this visit, most important first, with what to do about each.</p>
  ${
    data.findings.length
      ? `<p class="sevbar">${counts.map(([s, n]) => `<span class="sev ${s}">${n} ${SEVERITY_LABEL[s].toLowerCase()}</span>`).join('')}</p>\n${list}`
      : '<p class="none">No problems were found that need attention.</p>'
  }
</section>`);
  }

  if (sections.includes('map') && map) {
    // Room left for the image under the section title, inside the page margins.
    const maxW = mapPage.w - MARGIN_X * 2 - 0.3;
    const maxH = mapPage.h - MARGIN_Y * 2 - 0.8;
    parts.push(`<section class="break map-page">
  ${title('map')}
  <div class="map"><img src="${map.dataUrl}" alt="Network map" style="max-width:${maxW.toFixed(2)}in;max-height:${maxH.toFixed(2)}in"></div>
</section>`);
  }

  if (sections.includes('connectivity') && data.checks?.length) {
    parts.push(`<section class="break">
  ${title('connectivity')}
  <p class="intro">From this computer to the internet, step by step${data.checkedAt ? `, checked ${esc(formatDate(data.checkedAt))}` : ''}. The first step that fails is where the problem is.</p>
  <table class="checks"><thead><tr><th>Step</th><th>Result</th><th>Target</th></tr></thead><tbody>
  ${data.checks.map((c) => `<tr><td><i class="st ${c.status}"></i>${esc(c.name)}</td><td>${esc(c.summary)}</td><td class="mono">${esc(c.target ?? '')}</td></tr>`).join('\n')}
  </tbody></table>${publicAddressLine(data.publicAddress)}
</section>`);
  }

  if (sections.includes('inventory')) {
    parts.push(`<section class="break">
  ${title('inventory')}
  <p class="intro">${data.devices.length} ${data.devices.length === 1 ? 'device' : 'devices'} found on ${esc(data.cidr)}.</p>
  <table class="inv"><thead><tr><th>Name</th><th>Address</th><th>MAC address</th><th>Manufacturer</th><th>Type</th><th class="num">Open ports</th><th class="num">Risks</th></tr></thead><tbody>
  ${data.devices
    .map(
      (d) =>
        `<tr${d.worst === 'high' ? ' class="r-high"' : ''}><td>${d.name === d.ip ? '<span class="muted">—</span>' : esc(d.name)}</td><td class="mono">${esc(d.ip)}</td><td class="mono">${esc(d.mac ?? '')}</td><td>${esc(d.vendor ?? '')}</td><td>${esc(typeLabel(d.type))}</td><td class="num">${d.ports || ''}</td><td class="num">${d.risks ? `<span class="sev ${d.worst ?? 'low'}">${d.risks}</span>` : ''}</td></tr>`,
    )
    .join('\n')}
  </tbody></table>
</section>`);
  }

  if (sections.includes('signoff')) {
    parts.push(`<section class="break signoff">
  ${title('signoff')}
  <p class="intro">The work and findings in this report were reviewed with the client.</p>
  <div class="signs">
    <div><h4>Technician</h4><div class="line"></div><p>${esc(b.preparedBy.trim() || 'Name')}</p>${company ? `<p class="muted">${esc(company)}</p>` : ''}<div class="line"></div><p class="muted">Date</p></div>
    <div><h4>Client</h4><div class="line"></div><p class="muted">Name</p><div class="line"></div><p class="muted">Signature and date</p></div>
  </div>
</section>`);
  }

  const sans = font(data.fonts?.sans);
  const mono = font(data.fonts?.mono);
  const margin = `font:8px "Report Sans",sans-serif;color:#667085`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${esc(data.title)} · Site visit report</title>
<style>
${sans ? `@font-face{font-family:"Report Sans";src:url(${sans}) format("woff2");font-weight:100 900}` : ''}
${mono ? `@font-face{font-family:"Report Mono";src:url(${mono}) format("woff2");font-weight:100 900}` : ''}
@page{size:${paperName};margin:${MARGIN_Y}in ${MARGIN_X}in;
  @top-left{content:${cssText(head)};${margin};vertical-align:bottom;padding-bottom:10px}
  @top-right{content:${cssText(formatDate(data.date))};${margin};vertical-align:bottom;padding-bottom:10px}
  @bottom-left{content:${cssText(foot)};${margin};vertical-align:top;padding-top:10px}
  @bottom-right{content:counter(page) " / " counter(pages);${margin};vertical-align:top;padding-top:10px}}
@page cover{@top-left{content:none}@top-right{content:none}}
@page map{size:${paperName} ${mapLandscape ? 'landscape' : 'portrait'}}
*{box-sizing:border-box}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{margin:0;font:10px/1.5 "Report Sans",-apple-system,"Segoe UI",Roboto,sans-serif;color:#101828}
.mono{font-family:"Report Mono",ui-monospace,Menlo,Consolas,monospace;font-size:.92em}
.muted{color:#667085}
.break{break-before:page}
.cover{page:cover}
.cover-top{display:flex;justify-content:space-between;align-items:center;padding-bottom:22px;border-bottom:3px solid #3e4ee0}
.brand{display:flex;align-items:center;gap:10px;font-size:14px}
.brand img{max-height:44px;max-width:180px;object-fit:contain}
.kind{font-weight:600;font-size:9px;letter-spacing:.14em;text-transform:uppercase;color:#3e4ee0}
h1{font-size:32px;letter-spacing:-.03em;line-height:1.1;margin:40px 0 4px}
.lede{font-size:12px;color:#475467;margin:0 0 22px}
.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:0 0 20px;padding:14px 0;border-top:1px solid #e4e7ec;border-bottom:1px solid #e4e7ec}
.meta dt{font-size:8px;text-transform:uppercase;letter-spacing:.08em;color:#667085;margin-bottom:3px}
.meta dd{margin:0;font-weight:500}
.verdict{display:flex;gap:12px;align-items:flex-start;padding:13px 16px;border-radius:10px;margin-bottom:16px}
.verdict i{flex:none;width:12px;height:12px;border-radius:50%;margin-top:3px}
.verdict b{font-size:13px}.verdict p{margin:2px 0 0;color:#475467}
.verdict.ok{background:#ecf8ef;border:1px solid #b7e2c2}.verdict.ok i{background:#17a34a}
.verdict.warn{background:#fdf5e4;border:1px solid #f3d699}.verdict.warn i{background:#f5a524}
.verdict.bad{background:#fdeeee;border:1px solid #f4c2c2}.verdict.bad i{background:#d92d20}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:22px}
.stats div{border:1px solid #e4e7ec;border-radius:9px;padding:10px 12px}
.stats b{display:block;font-size:22px;letter-spacing:-.02em;line-height:1.1}
.stats span{color:#667085;font-size:8.5px}
.red{color:#d92d20}
h3{font-size:12px;margin:18px 0 6px}
.summary{margin:0;padding-left:18px}.summary li{margin-bottom:5px;font-size:10.5px}
.custom p{margin:0 0 8px;font-size:10.5px}
.toc{margin:0;padding-left:18px;max-width:60%}.toc li{padding:3px 0;border-bottom:1px dashed #d0d5dd}
h2.title{display:flex;align-items:center;gap:10px;font-size:18px;letter-spacing:-.02em;margin:0 0 4px}
h2.title span{font:600 11px/22px "Report Mono",monospace;width:22px;height:22px;text-align:center;border-radius:6px;background:#eceefe;color:#3e4ee0}
.intro{color:#475467;margin:0 0 14px;font-size:10.5px}
.none{padding:12px 14px;border-radius:9px;background:#ecf8ef;border:1px solid #b7e2c2}
.sev{display:inline-block;font-size:8px;font-weight:600;padding:1px 7px;border-radius:999px;letter-spacing:.02em}
.sev.high{background:#fdeeee;color:#b42318}.sev.medium{background:#fdf5e4;color:#93570a}.sev.low{background:#eef2f6;color:#475467}
.sevbar{display:flex;gap:8px;margin:0 0 12px}
.finding{border:1px solid #e4e7ec;border-radius:10px;padding:10px 14px;margin-bottom:8px;break-inside:avoid}
.finding p{margin:0 0 4px}
.fhead{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.fhead h4{margin:0;font-size:11.5px}
.fnum{font:600 10px "Report Mono",monospace;color:#667085}
.affected{color:#475467;font-size:9px}
.map{display:flex;justify-content:center;align-items:center;border:1px solid #e4e7ec;border-radius:10px;padding:10px;background:#fbfcfd}
.map img{display:block;width:auto;height:auto}
.map-page{page:map}
table{width:100%;border-collapse:collapse;font-size:9px}
thead{display:table-header-group}
tr{break-inside:avoid}
th{text-align:left;font-size:7.5px;text-transform:uppercase;letter-spacing:.07em;color:#667085;font-weight:600;padding:5px 6px;border-bottom:1.5px solid #d0d5dd}
td{padding:4px 6px;border-bottom:1px solid #eef0f3;vertical-align:top}
.num{text-align:right}
tr.r-high td{background:#fef6f6}
.st{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px;background:#98a2b3}
.st.ok{background:#17a34a}.st.warn{background:#f5a524}.st.fail{background:#d92d20}
table.checks td:first-child{width:30%;font-weight:500;white-space:nowrap}
.signs{display:grid;grid-template-columns:1fr 1fr;gap:40px;margin-top:40px}
.signs h4{margin:0 0 30px;font-size:11px}
.signs .line{border-bottom:1px solid #98a2b3;height:34px}
.signs p{margin:4px 0 0}
</style></head>
<body>
${parts.join('\n')}
</body></html>`;
}
