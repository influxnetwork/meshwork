/**
 * WiFi survey: the current connection, a channel advisor, a channel graph, signal history and
 * every access point in range. Scans repeat every few seconds while the page is open.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronUp, Lock, LockOpen, MapPin, Pause, Play, Search, ShieldX, SlidersHorizontal, Wifi as WifiIcon, WifiOff, X } from 'lucide-react';
import type { WifiBand, WifiConnection, WifiNetwork, WifiReport } from '@shared/types';
import { cleanError, useStore } from './store';
import { Copyable, EmptyState } from './ui';
import {
  ago,
  formatSignal,
  KEEP_CHOICES,
  matchesSecurity,
  mergeScan,
  modeLabel,
  readOptions,
  signalPercent,
  type SecurityFilter,
  type SeenNetwork,
  type SignalSample,
  type WifiOptions,
} from './wifi-model';

const SCAN_EVERY_MS = 5000;
const HISTORY_MS = 10 * 60_000; // signal history window

type BandFilter = 'all' | WifiBand;
type SortKey = 'ssid' | 'channel' | 'signal' | 'security' | 'generation' | 'seen';

const OPTIONS_KEY = 'wifi-options';
const DOCK_KEY = 'wifi-dock';
const DOCK_MIN = 160;
const DOCK_MAX = 560;

type DockTab = 'graph' | 'signal' | 'advisor';
const DOCK_TABS: { id: DockTab; label: string }[] = [
  { id: 'graph', label: 'Channel graph' },
  { id: 'signal', label: 'Signal' },
  { id: 'advisor', label: 'Channel advisor' },
];

/** Bottom charts panel: open or collapsed, active tab and height in pixels. */
interface DockState {
  open: boolean;
  tab: DockTab;
  height: number;
}

function readDock(raw: string | null): DockState {
  const d: DockState = { open: true, tab: 'graph', height: 250 };
  try {
    const v = raw ? (JSON.parse(raw) as Partial<DockState>) : {};
    if (typeof v.open === 'boolean') d.open = v.open;
    if (v.tab === 'graph' || v.tab === 'signal' || v.tab === 'advisor') d.tab = v.tab;
    if (typeof v.height === 'number' && Number.isFinite(v.height)) d.height = Math.max(DOCK_MIN, Math.min(DOCK_MAX, v.height));
  } catch {
    // Unreadable stored state falls back to the defaults.
  }
  return d;
}
const NOTES_KEY = 'wifi-notes';

/** Notes the user attached to access points, keyed by BSSID. */
function readNotes(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NOTES_KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------- helpers

function quality(rssi: number): { label: string; tone: 'good' | 'fair' | 'poor' } {
  if (rssi >= -55) return { label: 'Excellent', tone: 'good' };
  if (rssi >= -67) return { label: 'Good', tone: 'good' };
  if (rssi >= -75) return { label: 'Fair', tone: 'fair' };
  return { label: 'Poor', tone: 'poor' };
}

function generationLabel(gen: number | undefined, band: WifiBand | undefined): string {
  if (!gen) return '—';
  if (gen === 6 && band === '6') return 'Wi-Fi 6E';
  return `Wi-Fi ${gen}`;
}

function bandLabel(band: WifiBand | undefined): string {
  return band ? `${band} GHz` : '—';
}

/** Channels a network occupies, from its primary channel and width. */
function span(n: { channel?: { number: number; band?: WifiBand; width?: number } }): [number, number] | undefined {
  const c = n.channel;
  if (!c) return undefined;
  const width = c.width ?? 20;
  if (c.band === '2.4') {
    const half = Math.max(2, width / 10);
    return [c.number - half, c.number + half];
  }
  const per = Math.max(1, width / 20);
  const base = c.band === '6' ? 1 : c.number >= 149 ? 149 : 36;
  const start = base + Math.floor((c.number - base) / (4 * per)) * 4 * per;
  return [start, start + 4 * (per - 1)];
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Channels worth moving to, for the width the network uses. 2.4 GHz has three channels that do
 * not overlap; 5 GHz lists the first channel of each block (52–144 need radar detection, DFS);
 * 6 GHz lists preferred scanning channels.
 */
function candidates(band: WifiBand, width: number): number[] {
  if (band === '2.4') return [1, 6, 11];
  if (band === '6') return [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229];
  if (width >= 160) return [36, 100];
  if (width >= 80) return [36, 52, 100, 116, 132, 149];
  if (width >= 40) return [36, 44, 52, 60, 100, 108, 116, 124, 132, 140, 149, 157];
  return [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165];
}

/** 5 GHz channels 52–144 require radar detection (DFS) and may move if radar is detected. */
function isDfs(channel: number, band: WifiBand): boolean {
  return band === '5' && channel >= 52 && channel <= 144;
}

/** Channel axes for the graph. */
const AXIS: Record<WifiBand, number[]> = {
  '2.4': [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  '5': [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144, 149, 153, 157, 161, 165],
  '6': Array.from({ length: 59 }, (_, i) => 1 + i * 4),
};

interface Advice {
  band: WifiBand;
  width: number;
  current?: number;
  best: number;
  rows: { channel: number; label: string; count: number; strongest?: number; score: number }[];
}

/** Ranks the non-overlapping channels of a band by how much airtime other networks use on them. */
function advise(networks: WifiNetwork[], band: WifiBand, own?: WifiConnection): Advice | undefined {
  const others = networks.filter((n) => n.channel?.band === band && !(own?.ssid && n.ssid === own.ssid));
  const width = own?.channel?.band === band ? (own.channel.width ?? 20) : 20;
  const rows = candidates(band, width).map((channel) => {
    const range = span({ channel: { number: channel, band, width } }) as [number, number];
    const label = band !== '2.4' && range[1] > range[0] ? `${range[0]}–${range[1]}` : String(channel);
    const hits = others.filter((n) => {
      const s = span(n);
      return s && overlaps(s, range);
    });
    // Received power in milliwatts, so one strong neighbour outweighs several faint ones.
    const score = hits.reduce((sum, n) => sum + 10 ** ((n.rssi + 100) / 10), 0);
    // DFS channels can be interrupted by radar; prefer them only when clearly better.
    const penalty = isDfs(channel, band) ? 10 ** 1.5 : 0;
    return { channel, label, count: hits.length, strongest: hits.length ? Math.max(...hits.map((n) => n.rssi)) : undefined, score: score + penalty };
  });
  if (!rows.length) return undefined;
  const best = rows.reduce((a, b) => (b.score < a.score ? b : a));
  // The current channel maps to the block that contains it.
  const ownRange = own?.channel?.band === band ? span(own) : undefined;
  const current = ownRange ? rows.find((r) => overlaps(span({ channel: { number: r.channel, band, width } }) as [number, number], ownRange))?.channel : undefined;
  return { band, width, current, best: best.channel, rows };
}

function describe(a: Advice): string {
  const best = a.rows.find((r) => r.channel === a.best);
  const cur = a.rows.find((r) => r.channel === a.current);
  const bestText = best?.count
    ? `${best.count} other ${best.count === 1 ? 'network' : 'networks'}, strongest ${best.strongest} dBm.`
    : 'No other networks on it.';
  const dfs = isDfs(a.best, a.band) ? ' Needs radar detection (DFS) support.' : '';
  if (cur && cur.channel !== a.best) {
    return `${bestText}${dfs} Your channels share airtime with ${cur.count} ${cur.count === 1 ? 'network' : 'networks'}.`;
  }
  return bestText + dfs;
}

/** Highest airtime score among the advisor's channels, for scaling its bars (never below 1). */
function maxScore(a: Advice): number {
  return Math.max(1, ...a.rows.map((r) => r.score));
}

function channelName(a: Advice, channel: number): string {
  return a.rows.find((r) => r.channel === channel)?.label ?? String(channel);
}

function SignalBars({ rssi, mine, text }: { rssi: number; mine?: boolean; text: string }) {
  const n = rssi >= -55 ? 4 : rssi >= -67 ? 3 : rssi >= -75 ? 2 : 1;
  return (
    <span className={`sigbar${mine ? ' mine' : ''}`}>
      <span className="bars" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <i key={i} className={i <= n ? 'on' : ''} style={{ height: 2 + i * 3 }} />
        ))}
      </span>
      <span className="mono">{text}</span>
    </span>
  );
}

function SecurityChip({ security }: { security: string[] }) {
  const top = security[0];
  if (!top) return <span className="muted">—</span>;
  if (top === 'Open') {
    return (
      <span className="sec bad">
        <LockOpen className="icon" /> Open
      </span>
    );
  }
  if (top.includes('WEP')) {
    return (
      <span className="sec bad">
        <ShieldX className="icon" /> WEP · insecure
      </span>
    );
  }
  return (
    <span className="sec">
      <Lock className="icon" /> {top}
    </span>
  );
}

function SignalRing({ rssi, options }: { rssi: number; options: WifiOptions }) {
  const r = 38;
  const c = 2 * Math.PI * r;
  const known = rssi < 0;
  const frac = known ? Math.max(0, Math.min(1, (rssi + 100) / 70)) : 0;
  const tone = known ? quality(rssi).tone : 'fair';
  return (
    <svg className={`conn-ring ${tone}`} viewBox="0 0 92 92" role="img" aria-label={`Signal ${rssi} dBm`}>
      <circle cx="46" cy="46" r={r} className="ring-track" />
      <circle cx="46" cy="46" r={r} className="ring-value" strokeDasharray={`${(frac * c).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 46 46)" />
      <text x="46" y="49" textAnchor="middle" className="ring-num">
        {known ? (options.unit === 'percent' ? signalPercent(rssi, options) : rssi) : '—'}
      </text>
      <text x="46" y="63" textAnchor="middle" className="ring-unit">
        {options.unit === 'percent' ? '%' : 'dBm'}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------- charts

/** dBm grid lines for a plot whose −90…−30 dBm span is `span` pixels tall, at least 14 px apart. */
function dbmTicks(span: number): number[] {
  const step = span / 6 >= 14 ? 10 : span / 3 >= 14 ? 20 : 30;
  const ticks: number[] = [];
  for (let v = -30; v >= -90; v -= step) ticks.unshift(v);
  return ticks;
}

/**
 * Measures the space it is given and renders a chart for exactly that size, so charts grow and
 * shrink with the window without stretching text.
 */
function ChartBox({ children }: { children: (size: { width: number; height: number }) => React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      const { width, height } = entry.contentRect;
      setSize((s) => (Math.round(width) === s.width && Math.round(height) === s.height ? s : { width: Math.round(width), height: Math.round(height) }));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="chart-box">
      {size.width > 0 && size.height > 0 && children(size)}
    </div>
  );
}

interface Curve {
  n: SeenNetwork;
  x0: number;
  x1: number;
  yT: number;
  mine: boolean;
  sibling: boolean;
  stale: boolean;
}

interface Tag {
  key: string;
  text: string;
  x: number;
  y: number;
  w: number;
  /** Top of the curve the label names, for a leader line when the label had to move up. */
  top: number;
}

/** Approximate rendered width of label text at the graph's label size. */
function textWidth(text: string): number {
  return text.length * 6.1 + 4;
}

/**
 * Places one name per curve above its top, strongest (and selected/own) first. A label that would
 * cover an earlier one is moved up a line or two, and dropped when there is no room.
 */
function placeTags(curves: Curve[], label: (n: SeenNetwork) => string, priority: (c: Curve) => number, bounds: { l: number; r: number; t: number }): Tag[] {
  const placed: Tag[] = [];
  const order = [...curves].sort((a, b) => priority(b) - priority(a) || b.n.rssi - a.n.rssi);
  for (const c of order) {
    let text = label(c.n);
    if (text.length > 22) text = `${text.slice(0, 21)}…`;
    const w = textWidth(text);
    const x = Math.max(bounds.l + w / 2, Math.min(bounds.r - w / 2, (c.x0 + c.x1) / 2));
    for (const dy of [0, -13, -26, 13]) {
      const y = c.yT - 5 + dy;
      if (y < bounds.t) continue;
      const hit = placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 + 3 && Math.abs(p.y - y) < 12);
      if (!hit) {
        placed.push({ key: c.n.key, text, x, y, w, top: c.yT });
        break;
      }
    }
  }
  return placed;
}

function ChannelGraph({
  networks,
  band,
  own,
  notes,
  freshSince,
  selected,
  onSelect,
  hiddenName,
  width = 760,
  height = 250,
}: {
  networks: SeenNetwork[];
  band: WifiBand;
  own?: WifiConnection;
  notes: Record<string, string>;
  /** Networks last seen before this time are drawn as no longer in range. */
  freshSince: number;
  selected?: string;
  onSelect: (key: string | undefined) => void;
  hiddenName: string;
  /** Drawing size in CSS pixels; the graph is laid out for it instead of being scaled. */
  width?: number;
  height?: number;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string>();
  const axis = AXIS[band];
  const W = width;
  const H = height;
  const m = { l: 40, r: 10, t: 14, b: 26 };
  const step = (W - m.l - m.r) / axis.length;
  const xOf = (ch: number) => {
    let i = axis.indexOf(ch);
    if (i < 0) i = Math.max(0, axis.findIndex((a) => a > ch)) - 0.5;
    return m.l + (i + 0.5) * step;
  };
  // Headroom above −20 dBm leaves space for the names of the strongest networks.
  const yOf = (dbm: number) => m.t + 30 + (1 - (Math.max(-100, Math.min(-20, dbm)) + 100) / 80) * (H - m.t - 30 - m.b);
  const pad = band === '2.4' ? 0 : step * 0.45;
  const yB = H - m.b;

  const curves: Curve[] = networks
    .filter((n) => n.channel?.band === band)
    .flatMap((n) => {
      const s = span(n);
      if (!s) return [];
      return [
        {
          n,
          x0: xOf(s[0]) - pad,
          x1: xOf(s[1]) + pad,
          yT: yOf(n.rssi),
          mine: !!own?.bssid && n.bssid === own.bssid,
          sibling: !!own?.ssid && n.ssid === own.ssid,
          stale: n.lastSeen < freshSince,
        },
      ];
    });
  // Weaker networks first, so stronger and highlighted curves are drawn on top.
  const drawOrder = [...curves].sort(
    (a, b) =>
      Number(a.n.key === selected) - Number(b.n.key === selected) ||
      Number(a.mine || a.sibling) - Number(b.mine || b.sibling) ||
      a.n.rssi - b.n.rssi,
  );
  const nameOf = (n: SeenNetwork) => (n.bssid && notes[n.bssid]) || n.ssid || (n.vendor ? `${n.vendor} (hidden)` : hiddenName);
  const tags = placeTags(
    curves.filter((c) => !c.stale || c.n.key === selected),
    nameOf,
    (c) => (c.n.key === selected ? 3 : c.mine ? 2 : 0),
    { l: m.l, r: W - m.r, t: m.t + 4 },
  );
  const labels = band === '6' ? axis.filter((_, i) => i % 6 === 0) : band === '5' ? axis.filter((_, i) => i % 2 === 0) : axis;

  /** Networks whose curve covers a point, top-most (strongest) first. */
  const under = (x: number, y: number) =>
    curves.filter((c) => x >= c.x0 && x <= c.x1 && y >= c.yT - 6 && y <= yB).sort((a, b) => b.n.rssi - a.n.rssi);

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return;
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const tag = tags.find((t) => Math.abs(t.x - pt.x) <= t.w / 2 && pt.y <= t.y + 3 && pt.y >= t.y - 11);
    if (tag) return onSelect(tag.key);
    const hits = under(pt.x, pt.y);
    if (!hits.length) return onSelect(undefined);
    // Repeated clicks on the same spot step through the networks stacked there.
    const at = hits.findIndex((c) => c.n.key === selected);
    onSelect(hits[(at + 1) % hits.length]?.n.key);
  };

  return (
    <svg
      ref={svgRef}
      className={`chart channel-graph${selected && curves.some((c) => c.n.key === selected) ? ' has-selection' : ''}`}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={`Networks by channel, ${band} GHz`}
      onClick={onClick}
    >
      {dbmTicks(yOf(-90) - yOf(-30)).map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={yOf(v)} y2={yOf(v)} className="grid-line" />
          <text x={m.l - 6} y={yOf(v) + 3} className="axis-label" textAnchor="end">
            {v}
          </text>
        </g>
      ))}
      {labels.map((ch) => (
        <text key={ch} x={xOf(ch)} y={H - 8} className="axis-label" textAnchor="middle">
          {ch}
        </text>
      ))}
      {drawOrder.map(({ n, x0, x1, yT, mine, sibling, stale }) => {
        const sl = Math.min(10, (x1 - x0) / 4);
        const d = `M${x0},${yB} C${x0 + sl},${yB} ${x0 + sl},${yT} ${x0 + sl * 2},${yT} L${x1 - sl * 2},${yT} C${x1 - sl},${yT} ${x1 - sl},${yB} ${x1},${yB}`;
        return (
          <g
            key={n.key}
            className={`ch-net${mine || sibling ? ' mine' : ''}${stale ? ' stale' : ''}${n.key === selected ? ' selected' : ''}${n.key === hover ? ' hover' : ''}`}
          >
            <path d={d} />
            <title>
              {`${n.ssid ?? 'Hidden network'}${mine ? ' (connected)' : ''}${n.bssid && notes[n.bssid] ? ` · ${notes[n.bssid]}` : ''}\n${n.rssi} dBm · channel ${n.channel?.number} · ${n.channel?.width ?? 20} MHz\n${n.security[0] ?? ''} · ${generationLabel(n.generation, n.channel?.band)}${stale ? '\nNot in the last scan' : ''}`}
            </title>
          </g>
        );
      })}
      {tags.map((t) => {
        const c = curves.find((x) => x.n.key === t.key);
        return (
          <g key={t.key} onMouseEnter={() => setHover(t.key)} onMouseLeave={() => setHover(undefined)}>
            {t.y < t.top - 8 && <line x1={t.x} x2={t.x} y1={t.y + 3} y2={t.top} className="ch-leader" />}
            <text
              x={t.x}
              y={t.y}
              textAnchor="middle"
              className={`ch-tag${c?.mine || c?.sibling ? ' mine' : ''}${t.key === selected ? ' selected' : ''}${c && !c.n.ssid && !(c.n.bssid && notes[c.n.bssid]) ? ' anon' : ''}`}
            >
              {t.text}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function SignalHistory({ points, label, width = 420, height = 230 }: { points: SignalSample[]; label: string; width?: number; height?: number }) {
  const W = width;
  const H = height;
  const m = { l: 40, r: 10, t: 14, b: 26 };
  const yOf = (dbm: number) => m.t + (1 - (Math.max(-100, Math.min(-30, dbm)) + 100) / 70) * (H - m.t - m.b);
  const now = points.at(-1)?.t ?? Date.now();
  const xOf = (t: number) => m.l + (1 - (now - t) / HISTORY_MS) * (W - m.l - m.r);
  // Scans can take longer than the interval, so samples are kept by age, not by count.
  const visible = points.filter((p) => now - p.t <= HISTORY_MS);
  const path = visible.map((p, i) => `${i ? 'L' : 'M'}${xOf(p.t).toFixed(1)},${yOf(p.rssi).toFixed(1)}`).join(' ');
  const last = points.at(-1);
  const clipId = `sig-plot-${useId().replace(/:/g, '')}`;
  return (
    <svg className="chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <rect x={m.l} width={W - m.l - m.r} y={yOf(-30)} height={yOf(-67) - yOf(-30)} className="good-band" />
      {dbmTicks(yOf(-90) - yOf(-30)).map((v) => (
        <g key={v}>
          <line x1={m.l} x2={W - m.r} y1={yOf(v)} y2={yOf(v)} className="grid-line" />
          <text x={m.l - 6} y={yOf(v) + 3} className="axis-label" textAnchor="end">
            {v}
          </text>
        </g>
      ))}
      {[10, 5, 0].map((min) => (
        <text key={min} x={xOf(now - min * 60_000)} y={H - 8} className="axis-label" textAnchor={min === 10 ? 'start' : min ? 'middle' : 'end'}>
          {min ? `−${min} min` : 'now'}
        </text>
      ))}
      <clipPath id={clipId}>
        <rect x={m.l} y={0} width={W - m.l - m.r + 6} height={H - m.b} />
      </clipPath>
      {visible.length > 1 && <path d={path} className="sig-line" clipPath={`url(#${clipId})`} />}
      {last && (
        <circle cx={xOf(last.t)} cy={yOf(last.rssi)} r={4} className="sig-dot">
          <title>{`${last.rssi} dBm now`}</title>
        </circle>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------- options dialog

function OptionsDialog({ open, onOpenChange, options, onChange }: { open: boolean; onOpenChange: (o: boolean) => void; options: WifiOptions; onChange: (o: WifiOptions) => void }) {
  const [full, setFull] = useState(String(options.fullDbm));
  const [empty, setEmpty] = useState(String(options.emptyDbm));
  useEffect(() => {
    if (open) {
      setFull(String(options.fullDbm));
      setEmpty(String(options.emptyDbm));
    }
  }, [open, options.fullDbm, options.emptyDbm]);
  const fullN = Number(full);
  const emptyN = Number(empty);
  const scaleOk = Number.isInteger(fullN) && Number.isInteger(emptyN) && fullN <= 0 && emptyN >= -120 && fullN > emptyN;
  const commitScale = () => scaleOk && onChange({ ...options, fullDbm: fullN, emptyDbm: emptyN });

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog wifi-options">
          <Dialog.Title asChild>
            <h2>WiFi options</h2>
          </Dialog.Title>
          <Dialog.Description className="muted" style={{ margin: '0 0 14px', fontSize: 12.5 }}>
            Saved on this computer.
          </Dialog.Description>
          <div className="opt-row">
            <div>
              <b>Keep networks after they disappear</b>
              <p>Access points stay listed, greyed out, for this long after a scan stops reporting them.</p>
            </div>
            <span className="seg" role="group" aria-label="Keep networks">
              {KEEP_CHOICES.map((m) => (
                <button key={m} aria-pressed={options.keepMinutes === m} onClick={() => onChange({ ...options, keepMinutes: m })}>
                  {m ? `${m} min` : 'Off'}
                </button>
              ))}
            </span>
          </div>
          <div className="opt-row">
            <div>
              <b>Show signal as</b>
              <p>Graphs keep their dBm scale.</p>
            </div>
            <span className="seg" role="group" aria-label="Signal unit">
              <button aria-pressed={options.unit === 'dbm'} onClick={() => onChange({ ...options, unit: 'dbm' })}>
                dBm
              </button>
              <button aria-pressed={options.unit === 'percent'} onClick={() => onChange({ ...options, unit: 'percent' })}>
                Percent
              </button>
            </span>
          </div>
          <div className={`opt-row${options.unit === 'percent' ? '' : ' off'}`}>
            <div>
              <b>Percent scale</b>
              <p>{scaleOk ? `${options.fullDbm} dBm or stronger is 100%, ${options.emptyDbm} dBm or weaker is 0%.` : 'The 100% level must be stronger (closer to 0) than the 0% level.'}</p>
            </div>
            <div className="opt-scale">
              <label>
                100% at
                <span className="input">
                  <input
                    value={full}
                    inputMode="numeric"
                    disabled={options.unit !== 'percent'}
                    aria-label="Signal level shown as 100 percent, in dBm"
                    aria-invalid={!scaleOk}
                    onChange={(e) => setFull(e.target.value)}
                    onBlur={commitScale}
                    onKeyDown={(e) => e.key === 'Enter' && commitScale()}
                  />
                  dBm
                </span>
              </label>
              <label>
                0% at
                <span className="input">
                  <input
                    value={empty}
                    inputMode="numeric"
                    disabled={options.unit !== 'percent'}
                    aria-label="Signal level shown as 0 percent, in dBm"
                    aria-invalid={!scaleOk}
                    onChange={(e) => setEmpty(e.target.value)}
                    onBlur={commitScale}
                    onKeyDown={(e) => e.key === 'Enter' && commitScale()}
                  />
                  dBm
                </span>
              </label>
            </div>
          </div>
          <div className="row">
            <Dialog.Close asChild>
              <button className="btn primary">Done</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------- access point details

function NetworkDetail({
  n,
  own,
  options,
  note,
  onNote,
  hiddenName,
  now,
  onClose,
}: {
  n: SeenNetwork;
  own?: WifiConnection;
  options: WifiOptions;
  note: string;
  onNote: (text: string) => void;
  hiddenName: string;
  now: number;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(note);
  useEffect(() => setDraft(note), [n.key, note]);
  const mine = !!own?.bssid && n.bssid === own.bssid;
  const save = () => draft.trim() !== note && onNote(draft.trim());

  return (
    <aside className="detail drawer" aria-label="Access point details">
      <div className="insp-head">
        <div className="ap-tile">
          <WifiIcon className="icon" />
        </div>
        <div style={{ minWidth: 0 }}>
          <h3>{n.ssid ?? hiddenName}</h3>
          <p className="mono muted">{n.bssid ?? 'Address hidden'}</p>
          <p style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {mine && <span className="chip connected">Connected</span>}
            <span className={`quality ${quality(n.rssi).tone}`}>{quality(n.rssi).label}</span>
          </p>
        </div>
        <button className="icon-btn insp-close" aria-label="Close access point details" onClick={onClose}>
          <X className="icon" />
        </button>
      </div>
      <div className="insp-body">
        <div className="section-title">Note</div>
        {n.bssid ? (
          <textarea
            className="note-input"
            rows={2}
            value={draft}
            maxLength={200}
            placeholder="Add a note, e.g. where this access point is"
            aria-label="Note for this access point"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                save();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
          />
        ) : (
          <p className="muted" style={{ fontSize: 12.5 }}>
            Notes need the access point address, which appears once Location access is allowed.
          </p>
        )}

        <div className="section-title">Signal · last 10 min</div>
        {n.samples.length > 1 ? (
          <SignalHistory points={n.samples} label={`Signal of ${n.ssid ?? 'this access point'} over the last 10 minutes`} width={328} height={170} />
        ) : (
          <p className="muted" style={{ fontSize: 12.5 }}>
            The history fills in with each scan.
          </p>
        )}

        <div className="section-title">Access point</div>
        <dl className="kv">
          <dt>Network</dt>
          <dd>{n.ssid ? <Copyable value={n.ssid} label="network name" /> : <span className="muted">{hiddenName}</span>}</dd>
          <dt>BSSID</dt>
          <dd>{n.bssid ? <Copyable value={n.bssid} label="BSSID" mono /> : <span className="muted">Hidden</span>}</dd>
          <dt>Vendor</dt>
          <dd>{n.vendor ?? <span className="muted">Unknown</span>}</dd>
          <dt>Signal</dt>
          <dd>
            {n.rssi} dBm <span className="muted">· {signalPercent(n.rssi, options)}%</span>
          </dd>
          <dt>Noise</dt>
          <dd>{n.noise ? `${n.noise} dBm · SNR ${n.rssi - n.noise} dB` : <span className="muted">Not reported</span>}</dd>
          <dt>Channel</dt>
          <dd>
            {n.channel?.number ?? '—'}
            <span className="muted">
              {' '}
              · {bandLabel(n.channel?.band)}
              {n.channel?.width ? ` · ${n.channel.width} MHz` : ''}
              {n.channel && isDfs(n.channel.number, n.channel.band ?? '5') ? ' · DFS' : ''}
            </span>
          </dd>
          <dt>Security</dt>
          <dd>{n.security.length ? n.security.join(', ') : <span className="muted">Not reported</span>}</dd>
          <dt>Mode</dt>
          <dd>{n.phy.length ? `802.11${modeLabel(n.phy)}` : <span className="muted">Not reported</span>}</dd>
          <dt>Standard</dt>
          <dd>{generationLabel(n.generation, n.channel?.band)}</dd>
          <dt>First seen</dt>
          <dd>{new Date(n.firstSeen).toLocaleTimeString()}</dd>
          <dt>Last seen</dt>
          <dd>
            {new Date(n.lastSeen).toLocaleTimeString()} <span className="muted">· {ago(n.lastSeen, now)}</span>
          </dd>
        </dl>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------- page

export function Wifi() {
  const toast = useStore((s) => s.toast);
  const [report, setReport] = useState<WifiReport>();
  const [seen, setSeen] = useState<SeenNetwork[]>([]);
  const [lastScanAt, setLastScanAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string>();
  const [paused, setPaused] = useState(false);
  const [band, setBand] = useState<BandFilter>('all');
  /** Band drawn in the channel graph and advisor while the list shows all bands; defaults to the connection's. */
  const [chartBand, setChartBand] = useState<WifiBand>();
  const [security, setSecurity] = useState<SecurityFilter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'signal', dir: -1 });
  const [history, setHistory] = useState<SignalSample[]>([]);
  const [asking, setAsking] = useState(false);
  const [options, setOptions] = useState<WifiOptions>(() => readOptions(localStorage.getItem(OPTIONS_KEY)));
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>(readNotes);
  const [openKey, setOpenKey] = useState<string>();
  const [dock, setDockState] = useState<DockState>(() => readDock(localStorage.getItem(DOCK_KEY)));
  const dockOpen = dock.open;
  const dockTab = dock.tab;
  const dockHeight = dock.height;
  const setDock = (patch: Partial<DockState>) =>
    setDockState((d) => {
      const next = { ...d, ...patch };
      localStorage.setItem(DOCK_KEY, JSON.stringify(next));
      return next;
    });
  const showDock = (tab: DockTab) => setDock({ tab, open: true });
  const resizeDock = (h: number) => setDock({ height: Math.round(Math.max(DOCK_MIN, Math.min(DOCK_MAX, h))) });
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = dockHeight;
    const move = (ev: PointerEvent) => resizeDock(h0 + (y0 - ev.clientY));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-rows');
    };
    document.body.classList.add('resizing-rows');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const busy = useRef(false);
  const keepMs = useRef(options.keepMinutes * 60_000);
  keepMs.current = options.keepMinutes * 60_000;

  const updateOptions = (o: WifiOptions) => {
    setOptions(o);
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  };

  const updateNote = (bssid: string, text: string) => {
    setNotes((prev) => {
      const next = { ...prev };
      if (text) next[bssid] = text;
      else delete next[bssid];
      localStorage.setItem(NOTES_KEY, JSON.stringify(next));
      return next;
    });
  };

  const scan = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const next = await window.api.wifi.scan();
      const t = Date.now();
      setError(undefined);
      setReport(next);
      setNow(t);
      // macOS throttles back-to-back scans and may return an empty list; that is not "all gone".
      if (next.networks.length > 0 || !next.poweredOn) {
        setLastScanAt(t);
        setSeen((prev) => mergeScan(prev, next.networks, t, keepMs.current, HISTORY_MS));
      }
      const rssi = next.connection?.rssi;
      if (rssi !== undefined && rssi < 0) {
        setHistory((h) => [...h.filter((p) => t - p.t < HISTORY_MS), { t, rssi }]);
      }
    } catch (err) {
      setError(cleanError(err));
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void scan();
    if (paused) return;
    const timer = setInterval(() => void scan(), SCAN_EVERY_MS);
    return () => clearInterval(timer);
  }, [scan, paused]);

  // Keeps "last seen" ages current while scanning is paused.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  // A shorter retention applies right away instead of at the next scan.
  useEffect(() => {
    setSeen((prev) => prev.filter((n) => n.lastSeen >= lastScanAt || Date.now() - n.lastSeen <= options.keepMinutes * 60_000));
  }, [options.keepMinutes, lastScanAt]);

  useEffect(() => {
    if (!openKey) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && !optionsOpen && setOpenKey(undefined);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openKey, optionsOpen]);

  const allowLocation = async () => {
    setAsking(true);
    try {
      const state = await window.api.wifi.authorize();
      if (state === 'authorized') toast('success', 'Location access allowed. Network names appear on the next scan.');
      else if (state === 'denied') toast('error', 'Location access is off for Meshwork Wi-Fi. Turn it on in System Settings.');
      await scan();
    } catch (err) {
      toast('error', cleanError(err));
    } finally {
      setAsking(false);
    }
  };

  const own = report?.connection;
  const graphBand: WifiBand = band !== 'all' ? band : (chartBand ?? own?.channel?.band ?? '5');
  const advice = useMemo(() => (report ? advise(seen, graphBand, own) : undefined), [report, seen, graphBand, own]);
  const ownBand = own?.channel?.band;
  const ownAdvice = useMemo(() => (report && ownBand ? advise(seen, ownBand, own) : undefined), [report, seen, ownBand, own]);
  const inRange = seen.filter((n) => n.lastSeen >= lastScanAt).length;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = seen
      .filter((n) => band === 'all' || n.channel?.band === band)
      .filter((n) => matchesSecurity(n, security))
      .filter(
        (n) =>
          !q ||
          [n.ssid, n.bssid, n.vendor, n.bssid ? notes[n.bssid] : undefined, String(n.channel?.number ?? '')].some((v) => v?.toLowerCase().includes(q)),
      );
    const value = (n: SeenNetwork): number | string => {
      switch (sort.key) {
        case 'ssid':
          return (n.ssid ?? '~').toLowerCase();
        case 'channel':
          return n.channel?.number ?? 0;
        case 'signal':
          return n.rssi;
        case 'security':
          return n.security[0] ?? '';
        case 'generation':
          return n.generation ?? 0;
        case 'seen':
          return n.lastSeen;
      }
    };
    return [...list].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [seen, band, security, query, sort, notes]);

  const counts = useMemo(() => {
    const c: Record<BandFilter, number> = { all: 0, '2.4': 0, '5': 0, '6': 0 };
    for (const n of seen) {
      c.all++;
      if (n.channel?.band) c[n.channel.band]++;
    }
    return c;
  }, [seen]);

  const header = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        onClick={() =>
          setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'signal' || key === 'generation' || key === 'seen' ? -1 : 1 }))
        }
      >
        {label}
        {sort.key === key &&
          (sort.dir === 1 ? <ArrowUp className="icon" style={{ width: 12, height: 12 }} /> : <ArrowDown className="icon" style={{ width: 12, height: 12 }} />)}
      </button>
    </th>
  );

  const needsLocation =
    report && (report.location === 'not-determined' || report.location === 'denied' || report.location === 'restricted');
  const hiddenName = report?.location === 'authorized' || report?.location === 'not-required' ? 'Hidden network' : 'Name hidden';
  const opened = openKey ? seen.find((n) => n.key === openKey) : undefined;
  // The signal tab follows the selected access point, or the connection when none is selected.
  const signalPoints = opened ? opened.samples : history;
  const signalTitle = opened ? (opened.ssid ?? hiddenName) : (own?.ssid ?? 'Your connection');

  if (error && !report) {
    return (
      <div className="page">
        <EmptyState icon={WifiOff} title="Wi-Fi survey is not available">
          {error}
        </EmptyState>
      </div>
    );
  }

  return (
    <>
      <div className="page fit wifi-page">
        <div className="page-h">
          <div>
            <h1>WiFi</h1>
            <p>
              {!report
                ? 'Looking for networks…'
                : !report.poweredOn
                  ? 'Wi-Fi is turned off'
                  : `${paused ? 'Paused' : `Scanning every ${SCAN_EVERY_MS / 1000} s`}${own ? ` on ${own.interface}` : ''} · ${inRange} access points nearby`}
            </p>
          </div>
          <div className="right">
            <span className="seg" role="group" aria-label="Band">
              {(['all', '2.4', '5', '6'] as BandFilter[]).map((b) => (
                <button
                  key={b}
                  aria-pressed={band === b}
                  onClick={() => setBand(b)}
                  disabled={b !== 'all' && counts[b] === 0}
                  title={b === '6' ? '6 GHz band, used by Wi-Fi 6E and Wi-Fi 7 access points. Wi-Fi 6 (802.11ax) also runs on 2.4 and 5 GHz.' : undefined}
                >
                  {b === 'all' ? 'All' : `${b} GHz`}
                  <span className="seg-count">{counts[b]}</span>
                </button>
              ))}
            </span>
            <button className="btn" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
              {paused ? <Play className="icon" /> : <Pause className="icon" />} {paused ? 'Resume' : 'Pause'}
            </button>
            <button className="btn" onClick={() => setOptionsOpen(true)} aria-label="WiFi options" title="WiFi options">
              <SlidersHorizontal className="icon" /> Options
            </button>
          </div>
        </div>

        {needsLocation && (
          <div className="panel notice" role="alert">
            <MapPin className="icon" style={{ color: 'var(--accent)' }} />
            <div style={{ flex: 1, lineHeight: 1.45 }}>
              <b>Network names need Location access.</b>{' '}
              <span className="t2">
                {report.platform === 'win32'
                  ? 'Windows only lists Wi-Fi details for apps when Location is on.'
                  : 'macOS only shares Wi-Fi names and access point addresses with apps that have Location access. Your location itself is not used or stored.'}
              </span>
            </div>
            {report.location === 'not-determined' ? (
              <button className="btn primary sm" disabled={asking} onClick={() => void allowLocation()}>
                {asking ? 'Waiting for your answer…' : 'Allow Location access'}
              </button>
            ) : (
              <button className="btn sm" onClick={() => void window.api.wifi.openLocationSettings()}>
                Open Location settings
              </button>
            )}
          </div>
        )}

        {report && !report.poweredOn ? (
          <div className="panel">
            <EmptyState icon={WifiOff} title="Wi-Fi is turned off">
              Turn on Wi-Fi to see nearby networks. You do not need to join one.
            </EmptyState>
          </div>
        ) : (
          <>
            <div className="panel conn-strip">
              {own ? (
                <>
                  <SignalRing rssi={own.rssi} options={options} />
                  <div className="cs-name">
                    <div className="cs-title">
                      <b>{own.ssid ?? hiddenName}</b>
                      {own.rssi < 0 && <span className={`quality ${quality(own.rssi).tone}`}>{quality(own.rssi).label}</span>}
                    </div>
                    <span className="muted">
                      {own.security ?? 'Security not reported'}
                      {own.bssid && notes[own.bssid] ? ` · ${notes[own.bssid]}` : ''}
                    </span>
                  </div>
                  <dl className="cs-stats">
                    <div>
                      <dt>Channel</dt>
                      <dd>
                        {own.channel?.number ?? '—'}
                        {own.channel?.width ? <span className="muted"> · {own.channel.width} MHz</span> : null}
                      </dd>
                    </div>
                    <div>
                      <dt>Band</dt>
                      <dd>{bandLabel(own.channel?.band)}</dd>
                    </div>
                    <div>
                      <dt>SNR</dt>
                      <dd>{own.noise && own.rssi < 0 ? `${own.rssi - own.noise} dB` : '—'}</dd>
                    </div>
                    <div>
                      <dt>Noise</dt>
                      <dd>{own.noise ? `${own.noise} dBm` : '—'}</dd>
                    </div>
                    <div>
                      <dt>Tx rate</dt>
                      <dd>{own.txRateMbps ? `${Math.round(own.txRateMbps).toLocaleString()} Mbps` : '—'}</dd>
                    </div>
                    <div>
                      <dt>Standard</dt>
                      <dd>{generationLabel(own.generation, own.channel?.band)}</dd>
                    </div>
                    <div>
                      <dt>BSSID</dt>
                      <dd>{own.bssid ? <Copyable value={own.bssid} label="BSSID" mono /> : <span className="muted">{hiddenName}</span>}</dd>
                    </div>
                    <div className="cs-vendor">
                      <dt>Vendor</dt>
                      <dd title={own.vendor}>{own.vendor ?? '—'}</dd>
                    </div>
                  </dl>
                  {ownAdvice?.current && ownAdvice.current !== ownAdvice.best && (
                    <button
                      className="cs-tip"
                      onClick={() => {
                        if (band === 'all') setChartBand(ownAdvice.band);
                        showDock('advisor');
                      }}
                      title="Open the channel advisor"
                    >
                      <span className="num">{ownAdvice.best}</span>
                      <span>
                        {ownAdvice.width > 20 && ownAdvice.band !== '2.4' ? 'Channels' : 'Channel'} {channelName(ownAdvice, ownAdvice.best)} {ownAdvice.width > 20 && ownAdvice.band !== '2.4' ? 'are' : 'is'} clearer
                      </span>
                      <ChevronRight className="icon" />
                    </button>
                  )}
                </>
              ) : (
                <div className="cs-off">
                  <WifiOff className="icon" /> Not connected to Wi-Fi. Nearby networks are listed below.
                </div>
              )}
            </div>

            <div className="panel fill networks-panel">
              <div className="panel-h">
                Networks{' '}
                <span className="sub">
                  · {rows.length} access points
                  {seen.length > inRange ? ` · ${seen.length - inRange} not in the last scan` : ''}
                </span>
                <div className="right">
                  <span className="seg" role="group" aria-label="Security">
                    {(['all', 'open', 'secure'] as SecurityFilter[]).map((f) => (
                      <button key={f} aria-pressed={security === f} onClick={() => setSecurity(f)}>
                        {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Secure'}
                      </button>
                    ))}
                  </span>
                  <div className="input" style={{ width: 270 }}>
                    <Search className="icon" />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
                      placeholder="Filter name, BSSID, vendor, note"
                      aria-label="Filter networks"
                    />
                    {query && (
                      <button className="input-clear" aria-label="Clear filter" onClick={() => setQuery('')}>
                        <X className="icon" />
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="wifi-table-scroll">
                <table className="data-table wifi-table">
                  <thead>
                    <tr>
                      {header('ssid', 'Network')}
                      <th>BSSID</th>
                      <th>Vendor</th>
                      {header('channel', 'Channel')}
                      <th>Width</th>
                      {header('signal', 'Signal')}
                      {header('security', 'Security')}
                      <th>Mode</th>
                      {header('generation', 'Standard')}
                      {header('seen', 'Last seen')}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((n) => {
                      const mine = !!own?.bssid && n.bssid === own.bssid;
                      const sibling = !!own?.ssid && n.ssid === own.ssid;
                      const stale = n.lastSeen < lastScanAt;
                      const note = n.bssid ? notes[n.bssid] : undefined;
                      return (
                        <tr
                          key={n.key}
                          className={`clickable${mine ? ' mine' : ''}${stale ? ' stale' : ''}`}
                          aria-selected={openKey === n.key}
                          tabIndex={0}
                          onClick={() => setOpenKey(n.key)}
                          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpenKey(n.key))}
                        >
                          <td className="clip">
                            <div className="cell-net">
                              <span className={`swatch ${mine || sibling ? 'mine' : 'other'}`} />
                              <span className="cell-net-text">
                                <span className={n.ssid ? 'n' : 'n muted'}>{n.ssid ?? hiddenName}</span>
                                {note && (
                                  <span className="note" title={note}>
                                    {note}
                                  </span>
                                )}
                              </span>
                              {mine && <span className="chip connected">Connected</span>}
                            </div>
                          </td>
                          <td className="mono t2">{n.bssid ?? '—'}</td>
                          <td className="t2 clip" title={n.vendor}>
                            {n.vendor ?? '—'}
                          </td>
                          <td className="mono">
                            {n.channel?.number ?? '—'} <span className="muted">· {bandLabel(n.channel?.band)}</span>
                          </td>
                          <td className="mono t2">{n.channel?.width ? `${n.channel.width} MHz` : '—'}</td>
                          <td>
                            <SignalBars rssi={n.rssi} mine={mine} text={formatSignal(n.rssi, options)} />
                          </td>
                          <td>
                            <SecurityChip security={n.security} />
                          </td>
                          <td className="mono t2">{modeLabel(n.phy)}</td>
                          <td className="t2">{generationLabel(n.generation, n.channel?.band)}</td>
                          <td className="t2">{stale ? ago(n.lastSeen, now) : 'In range'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {rows.length === 0 && (
                <EmptyState icon={Search} title={report ? 'No networks match' : 'Scanning…'}>
                  {report ? 'Try another band or filter.' : 'Nearby access points appear here.'}
                </EmptyState>
              )}
            </div>

            <section className={`panel dock${dockOpen ? '' : ' collapsed'}`} style={dockOpen ? { height: dockHeight } : undefined} aria-label="Charts">
              {dockOpen && (
                <div
                  className="dock-resize"
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize the charts panel"
                  aria-valuenow={dockHeight}
                  aria-valuemin={DOCK_MIN}
                  aria-valuemax={DOCK_MAX}
                  tabIndex={0}
                  onPointerDown={startResize}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      e.preventDefault();
                      resizeDock(dockHeight + (e.key === 'ArrowUp' ? 20 : -20));
                    }
                  }}
                />
              )}
              <div className="dock-h">
                <div className="dock-tabs" role="tablist" aria-label="Charts">
                  {DOCK_TABS.map((t) => (
                    <button key={t.id} role="tab" aria-selected={dockOpen && dockTab === t.id} onClick={() => showDock(t.id)}>
                      {t.label}
                    </button>
                  ))}
                </div>
                {dockOpen && dockTab !== 'signal' && (
                  band === 'all' ? (
                    <span className="seg graph-band" role="group" aria-label="Band shown in the charts">
                      {(['2.4', '5', '6'] as WifiBand[]).map((b) => (
                        <button
                          key={b}
                          aria-pressed={graphBand === b}
                          disabled={counts[b] === 0 && graphBand !== b}
                          onClick={() => setChartBand(b)}
                          title={b === own?.channel?.band ? 'Band of your connection' : undefined}
                        >
                          {b} GHz
                        </button>
                      ))}
                    </span>
                  ) : (
                    <span className="sub">{graphBand} GHz</span>
                  )
                )}
                {dockOpen && dockTab === 'graph' && (
                  <>
                    <span className="sub graph-hint" title="Click a network to select it; click the same spot again to step through the networks behind it.">
                      Click to select, again for the ones behind
                    </span>
                    <div className="legend">
                      <span>
                        <i className="swatch mine" /> Your network
                      </span>
                      <span>
                        <i className="swatch other" /> Other networks
                      </span>
                    </div>
                  </>
                )}
                {dockOpen && dockTab === 'signal' && <span className="sub graph-hint">{signalTitle} · last 10 min, dBm</span>}
                {dockOpen && dockTab === 'advisor' && <span className="sub graph-hint">Channel use by nearby networks{advice && advice.width > 20 ? ` · ${advice.width} MHz blocks` : ''}</span>}
                <button
                  className="icon-btn dock-toggle"
                  aria-label={dockOpen ? 'Collapse the charts panel' : 'Expand the charts panel'}
                  aria-expanded={dockOpen}
                  onClick={() => setDock({ open: !dockOpen })}
                >
                  {dockOpen ? <ChevronDown className="icon" /> : <ChevronUp className="icon" />}
                </button>
              </div>
              {dockOpen && (
                <div className="dock-body" role="tabpanel">
                  {dockTab === 'graph' &&
                    (report ? (
                      <ChartBox>
                        {({ width, height }) => (
                          <ChannelGraph
                            networks={seen}
                            band={graphBand}
                            own={own}
                            notes={notes}
                            freshSince={lastScanAt}
                            selected={openKey}
                            onSelect={setOpenKey}
                            hiddenName={hiddenName}
                            width={width}
                            height={height}
                          />
                        )}
                      </ChartBox>
                    ) : null)}
                  {dockTab === 'signal' &&
                    (signalPoints.length ? (
                      <ChartBox>
                        {({ width, height }) => (
                          <SignalHistory points={signalPoints} label={`Signal of ${signalTitle} over the last 10 minutes`} width={width} height={height} />
                        )}
                      </ChartBox>
                    ) : (
                      <div className="muted dock-empty">Signal history appears after the first scans.</div>
                    ))}
                  {dockTab === 'advisor' &&
                    (advice ? (
                      <div className="advice">
                        <div className="advice-text">
                          <div className="best">
                            <div className="num">{advice.best}</div>
                            <div>
                              <b>
                                {advice.current && advice.current !== advice.best
                                  ? `Consider ${advice.width > 20 && advice.band !== '2.4' ? 'channels' : 'channel'} ${channelName(advice, advice.best)}`
                                  : `${advice.width > 20 && advice.band !== '2.4' ? 'Channels' : 'Channel'} ${channelName(advice, advice.best)} ${advice.width > 20 && advice.band !== '2.4' ? 'are' : 'is'} the clearest`}
                              </b>
                              <div className="muted" style={{ fontSize: 12 }}>
                                {describe(advice)}
                              </div>
                            </div>
                          </div>
                          <p className="advice-note">
                            {advice.current ? (
                              <>
                                You are on channel <b>{own?.channel?.number}</b>
                                {advice.width > 20 ? ` (${channelName(advice, advice.current)}, ${advice.width} MHz)` : ''}.{' '}
                              </>
                            ) : null}
                            Change the channel in your router or access point settings.
                          </p>
                        </div>
                        <div className="advice-bars">
                          <div className="cong" style={{ gridTemplateColumns: `repeat(${advice.rows.length}, 1fr)` }}>
                            {advice.rows.map((r) => (
                              <div
                                key={r.channel}
                                className={r.channel === advice.best ? 'best-bar' : r.channel === advice.current ? 'current-bar' : ''}
                                style={{ height: `${10 + (Math.log10(1 + r.score) / Math.log10(1 + maxScore(advice))) * 90}%` }}
                                title={`Channel ${r.label}: ${r.count} ${r.count === 1 ? 'network' : 'networks'}${r.strongest ? `, strongest ${r.strongest} dBm` : ''}`}
                              />
                            ))}
                          </div>
                          <div className="cong-labels" style={{ gridTemplateColumns: `repeat(${advice.rows.length}, 1fr)` }}>
                            {advice.rows.map((r) => (
                              <span key={r.channel} className={r.channel === advice.best ? 'best' : r.channel === advice.current ? 'current' : ''}>
                                {r.label}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="muted dock-empty">No networks on this band yet.</div>
                    ))}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      {opened && (
        <NetworkDetail
          n={opened}
          own={own}
          options={options}
          note={opened.bssid ? (notes[opened.bssid] ?? '') : ''}
          onNote={(text) => opened.bssid && updateNote(opened.bssid, text)}
          hiddenName={hiddenName}
          now={now}
          onClose={() => setOpenKey(undefined)}
        />
      )}
      <OptionsDialog open={optionsOpen} onOpenChange={setOptionsOpen} options={options} onChange={updateOptions} />
    </>
  );
}
