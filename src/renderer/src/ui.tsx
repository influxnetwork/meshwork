import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
  BrickWall,
  CircleAlert,
  CircleCheck,
  CircleHelp,
  Box,
  Check,
  Copy,
  Cctv,
  Cpu,
  HardDrive,
  Info,
  Laptop,
  Monitor,
  Network,
  OctagonAlert,
  Printer,
  Router,
  Server,
  Smartphone,
  Tablet,
  TriangleAlert,
  Tv,
  Wifi,
  X,
  type LucideProps,
} from 'lucide-react';
import type { Asset, DeviceType, Severity } from '@shared/types';
import { useStore } from './store';

type Icon = ComponentType<LucideProps>;

const DEVICE: Record<DeviceType, { icon: Icon; tile: string; label: string }> = {
  router: { icon: Router, tile: 'router', label: 'Router' },
  switch: { icon: Network, tile: 'switch', label: 'Switch' },
  firewall: { icon: BrickWall, tile: 'firewall', label: 'Firewall' },
  ap: { icon: Wifi, tile: 'ap', label: 'Access point' },
  server: { icon: Server, tile: 'server', label: 'Server' },
  vm: { icon: Box, tile: 'server', label: 'Virtual machine' },
  computer: { icon: Monitor, tile: 'endpoint', label: 'Computer' },
  laptop: { icon: Laptop, tile: 'endpoint', label: 'Laptop' },
  phone: { icon: Smartphone, tile: 'endpoint', label: 'Phone' },
  tablet: { icon: Tablet, tile: 'endpoint', label: 'Tablet' },
  printer: { icon: Printer, tile: 'iot', label: 'Printer' },
  camera: { icon: Cctv, tile: 'iot', label: 'Camera' },
  tv: { icon: Tv, tile: 'iot', label: 'Media device' },
  iot: { icon: Cpu, tile: 'iot', label: 'IoT device' },
  storage: { icon: HardDrive, tile: 'storage', label: 'Storage' },
  unknown: { icon: CircleHelp, tile: 'endpoint', label: 'Unknown' },
};

export function typeLabel(type: DeviceType): string {
  return DEVICE[type].label;
}

export function DeviceTile({ type, size }: { type: DeviceType; size?: 'sm' | 'lg' }) {
  const { icon: I, tile } = DEVICE[type];
  return (
    <div className={`dev ${size ?? ''}`} style={{ background: `var(--device-${tile})` }} aria-hidden>
      <I className="icon" />
    </div>
  );
}

/** Names makers go by when their registered name is long or its first word means nothing alone. */
const VENDOR_SHORT: [RegExp, string][] = [
  [/^aruba\b/i, 'Aruba'],
  [/^hewlett[\s-]*packard\s+enterprise/i, 'HPE'],
  [/^hewlett[\s-]*packard/i, 'HP'],
  [/^hon\s*hai/i, 'Foxconn'],
  [/^super\s*micro/i, 'Supermicro'],
  [/^texas\s+instruments/i, 'TI'],
  [/^palo\s+alto/i, 'Palo Alto'],
  [/^silicon\s+lab/i, 'Silicon Labs'],
  [/^tp-?link/i, 'TP-Link'],
  [/^d-?link/i, 'D-Link'],
  [/^american\s+power/i, 'APC'],
  [/^international\s+business\s+machines/i, 'IBM'],
];

/** Short maker name for labels: "Hewlett Packard Enterprise" → "HPE", "Cisco Systems, Inc" → "Cisco". */
export function shortVendor(vendor: string): string {
  for (const [re, name] of VENDOR_SHORT) if (re.test(vendor)) return name;
  return vendor.split(/[ ,]/)[0] ?? vendor;
}

export function displayName(a: Pick<Asset, 'hostname' | 'vendor' | 'ip'>): string {
  if (a.hostname) return a.hostname;
  if (a.vendor && a.vendor !== 'Private address') return `${shortVendor(a.vendor)} device`;
  return a.ip;
}

const SEV: Record<Severity, { icon: Icon; label: string }> = {
  high: { icon: OctagonAlert, label: 'High' },
  medium: { icon: TriangleAlert, label: 'Medium' },
  low: { icon: Info, label: 'Low' },
};

export function SeverityBadge({ severity, children }: { severity: Severity; children?: ReactNode }) {
  const { icon: I, label } = SEV[severity];
  return (
    <span className={`sev ${severity}`}>
      <I className="icon" />
      {children ?? label}
    </span>
  );
}

export function topSeverity(a: Asset): Severity | undefined {
  return a.risks[0]?.severity;
}

const RISKY_PORTS = new Set([21, 23, 2375, 3389, 5900, 5901, 623, 7547]);

export function PortChips({ ports, max = 4 }: { ports: Asset['ports']; max?: number }) {
  if (!ports.length) return <span className="muted">none</span>;
  return (
    <div className="ports">
      {ports.slice(0, max).map((p) => (
        <span key={p.port} className={`port ${RISKY_PORTS.has(p.port) ? 'risk' : ''}`} title={p.service}>
          {p.port}
        </span>
      ))}
      {ports.length > max && <span className="port">+{ports.length - max}</span>}
    </div>
  );
}

/** Small button that copies `value` and briefly shows a check mark. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const toast = useStore((s) => s.toast);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className={`copy-btn${copied ? ' done' : ''}`}
      aria-label={copied ? `${label} copied` : `Copy ${label}`}
      title={copied ? 'Copied' : `Copy ${label}`}
      onClick={(e) => {
        e.stopPropagation();
        window.api.app
          .copyText(value)
          .then(() => setCopied(true))
          .catch(() => toast('error', `Could not copy the ${label}.`));
      }}
    >
      {copied ? <Check className="icon" /> : <Copy className="icon" />}
    </button>
  );
}

/** Marks a device that also has IPv6 addresses; the addresses show on hover. */
export function V6Pill({ addresses }: { addresses: string[] }) {
  return (
    <span className="v6-pill" title={addresses.join('\n')} aria-label={`${addresses.length} IPv6 addresses`}>
      IPv6
    </span>
  );
}

/** A value with a copy button beside it. */
export function Copyable({ value, label, mono, children }: { value: string; label: string; mono?: boolean; children?: ReactNode }) {
  return (
    <span className="copyable">
      <span className={mono ? 'mono' : undefined}>{children ?? value}</span>
      <CopyButton value={value} label={label} />
    </span>
  );
}

export function EmptyState({ icon: I, title, children, action }: { icon: Icon; title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="ring">
        <I className="icon" />
      </div>
      <h3>{title}</h3>
      <p>{children}</p>
      {action}
    </div>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.kind === 'error' ? <CircleAlert className="icon" /> : t.kind === 'success' ? <CircleCheck className="icon" /> : <Info className="icon" />}
          <span style={{ flex: 1 }}>{t.text}</span>
          <button className="icon-btn" style={{ width: 22, height: 22 }} aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X className="icon" />
          </button>
        </div>
      ))}
    </div>
  );
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(iso: string): string {
  const diff = (Date.parse(iso) - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'just now';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(iso).toLocaleDateString();
}
