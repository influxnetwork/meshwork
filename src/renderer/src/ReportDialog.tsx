/**
 * Site-visit report export: the technician's branding, which sections to include and how to print
 * the map, then a preview in the system's PDF viewer or a saved PDF. Branding and options are kept
 * on this computer; the cover summary is kept per network.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Eye, FileDown, ImagePlus, Trash2 } from 'lucide-react';
import type { Asset, GearSnapshot, Network, Severity } from '@shared/types';
import { findLoops } from '@shared/loops';
import { findLinkMismatches } from '@shared/link-mismatch';
import {
  buildReportHtml,
  inCidr,
  printedSections,
  reportFindings,
  type ReportBranding,
  type ReportData,
  type ReportOptions,
  type ReportSection,
} from '@shared/report';
import sansFont from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?inline';
import monoFont from '@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?inline';
import { cleanError, useStore } from './store';
import { displayName } from './ui';
import { connectivityForReport } from './Diagnose';

const BRANDING_KEY = 'report-branding';
const OPTIONS_KEY = 'report-options';
const summaryKey = (networkId: string) => `report-summary:${networkId}`;

const DEFAULT_BRANDING: ReportBranding = { company: '', preparedBy: '', credit: true };

export function loadBranding(): ReportBranding {
  try {
    const raw = JSON.parse(localStorage.getItem(BRANDING_KEY) ?? 'null') as Partial<ReportBranding> | null;
    return { ...DEFAULT_BRANDING, ...(raw ?? {}) };
  } catch {
    return DEFAULT_BRANDING;
  }
}

export function saveBranding(b: ReportBranding) {
  localStorage.setItem(BRANDING_KEY, JSON.stringify(b));
}

/** Options remembered between reports. */
interface SavedOptions {
  sections: ReportSection[];
  paper: ReportOptions['paper'];
  mapOrientation: ReportOptions['mapOrientation'];
  /** Topology: every device. Infrastructure: network gear only. */
  mapView: 'topology' | 'infrastructure';
}

const DEFAULT_OPTIONS: SavedOptions = {
  sections: ['cover', 'findings', 'map', 'connectivity', 'inventory'],
  // Letter in the Americas where it is the norm; A4 elsewhere.
  paper: /-(US|CA|MX|PR|CO|VE|CL|PH)$/.test(navigator.language) ? 'letter' : 'a4',
  mapOrientation: 'auto',
  mapView: 'infrastructure',
};

function loadOptions(): SavedOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? 'null') as Partial<SavedOptions> | null;
    return { ...DEFAULT_OPTIONS, ...(raw ?? {}) };
  } catch {
    return DEFAULT_OPTIONS;
  }
}

/** Longest side of a stored logo, in pixels: sharp in print, small enough to keep. */
const LOGO_PX = 480;

/**
 * Reads an image file and scales it down to a PNG data URL. The file is read as a data URL (not a
 * blob URL), which is what the page's content security policy allows for images.
 */
function readLogo(file: File): Promise<string> {
  const fail = () => new Error('That file is not an image Meshwork can read. Use a PNG or JPEG.');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(fail());
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const w = img.naturalWidth || LOGO_PX;
        const h = img.naturalHeight || LOGO_PX;
        const scale = Math.min(1, LOGO_PX / Math.max(w, h));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.onerror = () => reject(fail());
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** Company name, technician's name, logo and the footer credit. Used here and in Settings. */
export function BrandingFields({ value, onChange }: { value: ReportBranding; onChange: (b: ReportBranding) => void }) {
  const file = useRef<HTMLInputElement>(null);
  const toast = useStore((s) => s.toast);
  const pick = async (f: File | undefined) => {
    if (!f) return;
    try {
      onChange({ ...value, logo: await readLogo(f) });
    } catch (err) {
      toast('error', cleanError(err));
    }
  };
  return (
    <div className="rp-brand">
      <div className="rp-logo">
        {value.logo ? <img src={value.logo} alt="Your logo" /> : <span className="muted">No logo</span>}
        <div className="rp-logo-actions">
          <button className="btn sm" onClick={() => file.current?.click()}>
            <ImagePlus className="icon" /> {value.logo ? 'Change' : 'Add logo'}
          </button>
          {value.logo && (
            <button className="btn sm" aria-label="Remove logo" title="Remove logo" onClick={() => onChange({ ...value, logo: undefined })}>
              <Trash2 className="icon" />
            </button>
          )}
        </div>
        <input
          ref={file}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      <div className="rp-fields">
        <label className="rp-label">
          Company name
          <span className="input">
            <input value={value.company} placeholder="Your company" onChange={(e) => onChange({ ...value, company: e.target.value })} />
          </span>
        </label>
        <label className="rp-label">
          Prepared by
          <span className="input">
            <input value={value.preparedBy} placeholder="Your name" onChange={(e) => onChange({ ...value, preparedBy: e.target.value })} />
          </span>
        </label>
        <label className="map-check">
          <input type="checkbox" checked={value.credit} onChange={(e) => onChange({ ...value, credit: e.target.checked })} /> Show &quot;Prepared with Meshwork&quot; in the footer
        </label>
      </div>
    </div>
  );
}

/** Settings tab: the branding every report uses. */
export function ReportSettings() {
  const [branding, setBranding] = useState(loadBranding);
  const change = (b: ReportBranding) => {
    setBranding(b);
    saveBranding(b);
  };
  return (
    <section className="settings-section" aria-labelledby="settings-report">
      <h3 id="settings-report">Site visit report</h3>
      <p className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Your logo and names appear on every report you export from Map. Meshwork&apos;s name only appears if you keep the footer credit.
      </p>
      <BrandingFields value={branding} onChange={change} />
    </section>
  );
}

const SECTIONS: { id: ReportSection; label: string }[] = [
  { id: 'cover', label: 'Cover and summary' },
  { id: 'findings', label: 'Findings and recommendations' },
  { id: 'map', label: 'Network map' },
  { id: 'connectivity', label: 'Connectivity checks' },
  { id: 'inventory', label: 'Device inventory' },
  { id: 'signoff', label: 'Sign-off' },
];

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const ipKey = (ip: string) => ip.split('.').reduce((acc, o) => acc * 256 + (Number(o) || 0), 0);

export interface MapCapture {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Export dialog for one network. `captureMap` draws the map in the chosen view, in the light theme,
 * and returns it as a PNG.
 */
export function ReportDialog({
  open,
  onOpenChange,
  network,
  members,
  gear,
  captureMap,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  network: Network;
  members: Asset[];
  gear: GearSnapshot | null;
  captureMap: (view: 'topology' | 'infrastructure') => Promise<MapCapture | undefined>;
}) {
  const toast = useStore((s) => s.toast);
  const [branding, setBranding] = useState(loadBranding);
  const [opts, setOpts] = useState(loadOptions);
  const [title, setTitle] = useState(network.name);
  const [summary, setSummary] = useState('');
  const [busy, setBusy] = useState<'preview' | 'save' | undefined>();

  useEffect(() => {
    if (!open) return;
    setBranding(loadBranding());
    setTitle(network.name);
    setSummary(localStorage.getItem(summaryKey(network.id)) ?? '');
  }, [open, network.id, network.name]);

  const updateOpts = (patch: Partial<SavedOptions>) =>
    setOpts((o) => {
      const next = { ...o, ...patch };
      localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
      return next;
    });
  const changeBranding = (b: ReportBranding) => {
    setBranding(b);
    saveBranding(b);
  };
  const toggle = (id: ReportSection) => updateOpts({ sections: opts.sections.includes(id) ? opts.sections.filter((s) => s !== id) : [...opts.sections, id] });

  // The connectivity check counts only if it ran from this network.
  const connectivity = useMemo(() => {
    if (!open) return undefined;
    const c = connectivityForReport();
    return c && inCidr(c.address, network.cidr) ? c : undefined;
  }, [open, network.cidr]);
  const loops = useMemo(() => findLoops(gear?.networkId === network.id ? gear.devices : []), [gear, network.id]);
  const mismatches = useMemo(() => findLinkMismatches(gear?.networkId === network.id ? gear.devices : []), [gear, network.id]);
  const findings = useMemo(() => reportFindings(members, displayName, loops, connectivity?.checks, mismatches), [members, loops, connectivity, mismatches]);
  const sections = connectivity ? opts.sections : opts.sections.filter((s) => s !== 'connectivity');

  const note: Partial<Record<ReportSection, string>> = {
    findings: `${findings.length}`,
    inventory: `${members.length} devices`,
    connectivity: connectivity ? undefined : 'not run on this network',
  };

  const make = async (mode: 'preview' | 'save') => {
    setBusy(mode);
    try {
      localStorage.setItem(summaryKey(network.id), summary);
      const map = sections.includes('map') ? await captureMap(opts.mapView) : undefined;
      const devices = [...members]
        .sort((a, b) => ipKey(a.ip) - ipKey(b.ip))
        .map((a) => ({
          name: displayName(a),
          ip: a.ip,
          mac: a.mac,
          vendor: a.vendor,
          type: a.type,
          ports: a.ports.length,
          risks: a.risks.length,
          worst: a.risks.length ? [...a.risks].sort((x, y) => SEVERITY_RANK[x.severity] - SEVERITY_RANK[y.severity])[0]?.severity : undefined,
        }));
      const data: ReportData = {
        title: title.trim() || network.name,
        cidr: network.cidr,
        date: new Date().toISOString(),
        branding,
        devices,
        findings,
        gear: gear?.networkId === network.id ? gear.devices.length : 0,
        map,
        checks: connectivity?.checks,
        checkedAt: connectivity?.checkedAt,
        publicAddress: connectivity?.publicAddress,
        fonts: { sans: sansFont, mono: monoFont },
      };
      const html = buildReportHtml(data, { sections, paper: opts.paper, mapOrientation: opts.mapOrientation, summary });
      const safe = data.title.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
      // The file is named by the local date, the one on the cover.
      const now = new Date();
      const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const path = await window.api.report.pdf(html, `${safe}-report-${day}`, mode);
      if (path && mode === 'save') {
        toast('success', `Saved the report to ${path}`);
        void window.api.report.show(path);
      }
    } catch (err) {
      toast('error', `Could not make the report: ${cleanError(err)}`);
    } finally {
      setBusy(undefined);
    }
  };

  // The map section counts as printable here; it is dropped later only if the map cannot be drawn.
  const printed = printedSections({ map: { dataUrl: 'data:image/png;base64,AA==', width: 1, height: 1 }, checks: connectivity?.checks }, { sections });
  const mapOn = sections.includes('map');

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog report">
          <Dialog.Title asChild>
            <h2>Export report · {network.name}</h2>
          </Dialog.Title>
          <Dialog.Description className="muted" style={{ margin: '0 0 14px', fontSize: 12.5 }}>
            A PDF for your client with what you found on this network. Every section is optional.
          </Dialog.Description>
          <div className="rp-layout">
            <div>
              <h4 className="rp-h">Branding</h4>
              <BrandingFields value={branding} onChange={changeBranding} />
              <h4 className="rp-h">Report</h4>
              <label className="rp-label">
                Site name
                <span className="input">
                  <input value={title} onChange={(e) => setTitle(e.target.value)} />
                </span>
              </label>
              <label className="rp-label">
                <span>
                  Summary for the cover <span className="muted">(optional)</span>
                </span>
                <textarea
                  className="rp-text"
                  rows={4}
                  value={summary}
                  placeholder="What you did on this visit and what the client should do next. Leave empty for a summary written from the findings."
                  onChange={(e) => setSummary(e.target.value)}
                />
              </label>
            </div>
            <div>
              <h4 className="rp-h">Sections</h4>
              <ul className="rp-sections">
                {SECTIONS.map((s) => {
                  const disabled = s.id === 'connectivity' && !connectivity;
                  return (
                    <li key={s.id}>
                      <label className="map-check">
                        <input type="checkbox" checked={sections.includes(s.id)} disabled={disabled} onChange={() => toggle(s.id)} /> {s.label}
                      </label>
                      {note[s.id] && <span className="muted">{note[s.id]}</span>}
                    </li>
                  );
                })}
              </ul>
              <h4 className="rp-h">Network map</h4>
              <div className="rp-opt">
                <span>Show</span>
                <span className="seg" role="group" aria-label="Map view">
                  {(['infrastructure', 'topology'] as const).map((v) => (
                    <button key={v} aria-pressed={opts.mapView === v} disabled={!mapOn} onClick={() => updateOpts({ mapView: v })}>
                      {v === 'topology' ? 'Every device' : 'Network gear'}
                    </button>
                  ))}
                </span>
              </div>
              <div className="rp-opt">
                <span>Orientation</span>
                <span className="seg" role="group" aria-label="Map orientation">
                  {(['auto', 'portrait', 'landscape'] as const).map((v) => (
                    <button key={v} aria-pressed={opts.mapOrientation === v} disabled={!mapOn} onClick={() => updateOpts({ mapOrientation: v })}>
                      {v === 'auto' ? 'Auto' : v === 'portrait' ? 'Portrait' : 'Landscape'}
                    </button>
                  ))}
                </span>
              </div>
              <div className="rp-opt">
                <span>Paper</span>
                <span className="seg" role="group" aria-label="Paper size">
                  {(['letter', 'a4'] as const).map((v) => (
                    <button key={v} aria-pressed={opts.paper === v} onClick={() => updateOpts({ paper: v })}>
                      {v === 'a4' ? 'A4' : 'Letter'}
                    </button>
                  ))}
                </span>
              </div>
            </div>
          </div>
          <div className="row">
            <span className="muted rp-count">{printed.length ? `${printed.length} ${printed.length === 1 ? 'section' : 'sections'}` : 'Choose at least one section'}</span>
            <Dialog.Close asChild>
              <button className="btn">Close</button>
            </Dialog.Close>
            <button className="btn" disabled={!!busy || !printed.length} onClick={() => void make('preview')}>
              <Eye className="icon" /> {busy === 'preview' ? 'Making…' : 'Preview'}
            </button>
            <button className="btn primary" disabled={!!busy || !printed.length} onClick={() => void make('save')}>
              <FileDown className="icon" /> {busy === 'save' ? 'Making…' : 'Save PDF'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
