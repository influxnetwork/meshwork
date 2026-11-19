/**
 * Network map: one network drawn as a tree on a pan-and-zoom canvas. Network gear sits under the
 * gateway and end devices are grouped by category; nodes can be dragged and the arrangement is
 * remembered per network. Clicking a device opens its details.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import * as Dialog from '@radix-ui/react-dialog';
import {
  BaseEdge,
  Background,
  BackgroundVariant,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  getNodesBounds,
  getSmoothStepPath,
  useReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { toPng, toSvg } from 'html-to-image';
import {
  AlertTriangle,
  ArrowUpFromLine,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Globe,
  ImageDown,
  FileSpreadsheet,
  FileText,
  LayoutGrid,
  MapPin,
  Maximize,
  Network as NetworkIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  X,
  RefreshCw,
  Waypoints,
  Wifi,
  Zap,
} from 'lucide-react';
import type { Asset, DeviceType, GearSnapshot, SnmpSettings } from '@shared/types';
import { describeLoop, findLoops } from '@shared/loops';
import { inCidr } from '@shared/report';
import { scannedRanges, unscannedNetworks } from '@shared/unscanned';
import { describeMismatch, findLinkMismatches, mismatchAdvice } from '@shared/link-mismatch';
import { cleanError } from './store';
import { useStore } from './store';
import { RouterIcon } from './icons';
import { DeviceTile, EmptyState, displayName, relativeTime } from './ui';
import { Detail, NodeDetail } from './Inventory';
import { ReportDialog, type MapCapture } from './ReportDialog';
import {
  CATEGORIES,
  CONNECTION_COLUMNS,
  attachLinks,
  buildTopology,
  connectionCells,
  connectionRows,
  gearRole,
  isPhysicalPort,
  layoutTree,
  placeCableLabels,
  gatewayLine,
  searchMap,
  vlanLabel,
  type Attachment,
  type Box,
  type CableLabels,
  type Category,
  type ConnectionRow,
  type MapNode,
  type MapSearchEntry,
  type NodeFacts,
  type Positions,
  type SharedGateway,
  type Side,
} from './map-model';
import { toCsv } from '@shared/csv';

const NETWORK_KEY = 'map-network';
const VIEW_KEY = 'map-view';
const layoutKey = (networkId: string) => `map-layout:${networkId}`;

interface ViewPrefs {
  clients: boolean;
  ip: boolean;
  vendor: boolean;
  /** Animate links with live port traffic. */
  live: boolean;
  collapsed: string[];
}

const DEFAULT_PREFS: ViewPrefs = { clients: true, ip: true, vendor: false, live: true, collapsed: [] };
const TRAFFIC_EVERY_MS = 5000;
const SIDE_KEY = 'map-side';
/**
 * VLAN colours in a fixed order. They leave out the accent (used for live traffic) and amber (used
 * for PoE) so a coloured cable always means a VLAN; the default VLAN 1 stays neutral grey.
 */
const VLAN_COLORS = ['#0ea5e9', '#10b981', '#f43f5e', '#d946ef', '#84cc16', '#0d9488'];
const VLAN_DEFAULT_COLOR = 'var(--text-muted)';
/** Length of each colour's stretch on a trunk cable. */
const TRUNK_STRIPE = 9;
const SECTIONS_KEY = 'map-sections';
const DEFAULT_SECTIONS: Record<string, boolean> = { network: true, snmp: true, view: true, arrange: true, legend: false };
/** Traffic from which a cable shows moving dots: even a ping (about 1.6 kbps); below it is background chatter. */
const FLOW_MIN_BPS = 400;

/** "34 Mbps", "820 kbps". */
function formatRate(bps: number): string {
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(1)} Gbps`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e8 ? 0 : 1)} Mbps`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kbps`;
  return `${bps} bps`;
}

function readJson<T extends object>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- nodes

interface DeviceData extends Record<string, unknown> {
  asset?: Asset;
  ip?: string;
  /** Gateway addresses the router shares with others and holds. */
  gateways?: SharedGateway[];
  /** Name, detail and type for devices that are not in the inventory. */
  label?: string;
  detail?: string;
  deviceType?: DeviceType;
  managed?: boolean;
  /** True when `label` is the device's own LLDP or CDP name. */
  announced?: boolean;
  /** True when `deviceType` comes from the device's own reading. */
  typeRead?: boolean;
  /** A stretch of network nobody manages, drawn where several devices share one switch port. */
  segment?: boolean;
  /** True for the computer the map is drawn from. */
  self?: boolean;
  /** A loop found on this switch, told on its card. */
  loop?: string;
  /** Address range of a separate network behind the gateway. */
  network?: string;
  /** Traffic on a contained device's switch port, in bits per second. */
  rate?: number;
  /** Switch port a contained device was learned on, and the power it draws from it. */
  port?: string;
  poe?: boolean;
  poeWatts?: number;
  /** VLAN the device was seen on, when it is not the default VLAN 1. */
  vlan?: number;
  vlanColor?: string;
  /** Behind an access point, usually over Wi-Fi. */
  wireless?: boolean;
  /** VLANs this router routes, with their colours; picking one shows that VLAN on the map. */
  routes?: { vlan: number; network: string; port: string; color: string }[];
  shownVlan?: number;
  onVlan?: (vlan: number) => void;
  showIp: boolean;
  showVendor: boolean;
  gateway: boolean;
}

interface ExitData extends Record<string, unknown> {
  /** Set when the way out is not the internet itself. */
  label?: string;
  detail?: string;
  /** Next hop of the default route that leads out. */
  via?: string;
  /** Set when the next hop's network was not scanned: the range to scan to identify it. */
  scan?: { cidr: string; busy: boolean; run: () => void };
}

interface LinkData extends Record<string, unknown> {
  /** Position in the drawing order: a cable keeps its labels clear of those of the cables before it. */
  order?: number;
  sourcePort?: string;
  targetPort?: string;
  poe?: boolean;
  poeWatts?: number;
  speedMbps?: number;
  /** Bits per second in both directions, while live traffic is on. */
  rate?: number;
  /** Where the link meets each node, on the sides that face each other. */
  at?: Attachment;
  /** A link between two routers that each head their own tree: both ends are drawn as plain ports. */
  peer?: boolean;
  /** The link runs over a tunnel. */
  tunnel?: boolean;
  /** True when the router that routes `routes` is at the target end of the link. */
  routesAtTarget?: boolean;
  /** Networks a router routes on this link, on its own interface and on VLAN subinterfaces. */
  routes?: { vlan?: number; network: string; ip: string; port: string }[];
  /** VLANs on the switch port: "V69" for an access port, "1, 69" for a trunk. */
  vlanText?: string;
  /** Outside the VLAN being shown. */
  dim?: boolean;
  /** Every port behind a group's cable, shown on hover. */
  sourcePortsAll?: string;
  /** Colours of the VLANs on the cable: one for an access port, several (striped) for a trunk. */
  vlanColors?: string[];
  /** A redundant cable (it closes a ring): whether spanning tree blocks it, and on which end. */
  redundant?: { blocked: boolean; blockedEnd?: 'source' | 'target' };
  /** A link bundle: how many cables it is made of and their ports at each end, shown on hover. */
  bundle?: { cables: number; sourcePorts?: string[]; targetPorts?: string[] };
}

const POSITION: Record<Side, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };

/** Same position within half a pixel; both absent counts as the same. */
const near = (a?: { x: number; y: number }, b?: { x: number; y: number }) =>
  a === b || (!!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5);

interface GroupData extends Record<string, unknown> {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

const hidden = { opacity: 0 };

/** Marks the computer the map is drawn from. */
function YouBadge() {
  return (
    <span className="map-you" title="You are here: this is the computer running Meshwork. The map is drawn from what it can reach.">
      <MapPin className="icon" aria-hidden /> You are here
    </span>
  );
}

function DeviceNode({ data, selected }: NodeProps<Node<DeviceData>>) {
  const a = data.asset;
  // The line of shared gateway addresses shows their detail while the pointer or the keyboard is on it.
  const [sharedAt, sharedProps] = useTipAt<HTMLSpanElement>();
  const [loopTipAt, loopProps] = useTipAt<HTMLSpanElement>();
  const sub = [data.showIp ? (a?.ip ?? data.ip) : undefined, data.showVendor && a?.vendor && a.vendor !== 'Private address' ? a.vendor : undefined]
    .filter(Boolean)
    .join(' · ');
  // Names announced over SNMP or LLDP win over a bare address.
  const known = a ? displayName(a) : undefined;
  const name =
    ((data.managed || data.announced) && data.label) ||
    a?.hostname ||
    (known && known !== a?.ip ? known : (data.label ?? known ?? (data.gateway || data.gateways?.length ? 'Gateway' : 'Unknown device')));
  // A type the device announced over LLDP beats the scan's guess.
  const type = (data.announced || data.typeRead) && data.deviceType && data.deviceType !== 'unknown' ? data.deviceType : a?.type && a.type !== 'unknown' ? a.type : data.deviceType;
  return (
    <div className={`map-node device${data.gateway ? ' gateway' : ''}${data.routes?.length ? ' routes' : ''}${data.gateways?.length ? ' shared' : ''}${data.self ? ' self' : ''}${selected ? ' selected' : ''}`} title={data.detail}>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      {data.managed && <span className="map-managed">SNMP</span>}
      {data.loop && (
        <span className="map-loop-mark" role="note" aria-label={data.loop} {...loopProps}>
          <AlertTriangle className="icon" aria-hidden /> Loop
        </span>
      )}
      {data.self && <YouBadge />}
      {data.network ? (
        <div className="map-glyph net">
          <NetworkIcon className="icon" />
        </div>
      ) : type ? (
        <DeviceTile type={type} size="sm" as={data.segment ? 'segment' : data.routes?.length ? 'routing' : undefined} />
      ) : (
        <div className="map-glyph">
          <RouterIcon className="icon" />
        </div>
      )}
      <div className="map-text">
        <b title={name}>{name}</b>
        {sub && sub !== name && <span title={sub}>{sub}</span>}
        {data.routes?.length ? (
          <div className="map-routes" aria-label="VLANs this router routes">
            <span>VLAN</span>
            {data.routes.map((r) => (
              <button
                key={r.vlan}
                className={`map-route nodrag${data.shownVlan === r.vlan ? ' on' : ''}`}
                style={{ '--vlan': r.color } as React.CSSProperties}
                title={`VLAN ${r.vlan} · ${r.network} on ${r.port}. Show this VLAN on the map.`}
                aria-pressed={data.shownVlan === r.vlan}
                onClick={(e) => {
                  e.stopPropagation();
                  data.onVlan?.(r.vlan);
                }}
              >
                {r.vlan}
              </button>
            ))}
          </div>
        ) : null}
        {data.gateways?.length ? (
          <span className="map-shared" {...sharedProps}>
            {gatewayLine(data.gateways)}
          </span>
        ) : null}
        {sharedAt && data.gateways?.length ? createPortal(<GatewaysTip at={sharedAt} gateways={data.gateways} />, document.body) : null}
        {loopTipAt && data.loop
          ? createPortal(
              <AnchoredTip at={loopTipAt} title="Loop on this switch">
                <span className="map-port-tip-row">{data.loop.replace(/^Loop: /, '')}</span>
              </AnchoredTip>,
              document.body,
            )
          : null}
      </div>
      {a?.risks.length ? <span className="map-risk" title={`${a.risks.length} ${a.risks.length === 1 ? 'risk' : 'risks'}`} /> : null}
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </div>
  );
}

/** Shown on devices behind an access point, where live traffic cannot pulse. */
const WIRELESS_NOTE = 'Connected through this access point, usually over Wi-Fi. Switches only measure the access point’s port, so this device’s own traffic is not shown.';

/** A device inside a group container: a compact card. */
function MemberNode({ data, selected }: NodeProps<Node<DeviceData>>) {
  const a = data.asset;
  // Addresses a switch learned that are not in the inventory show their manufacturer and MAC.
  const sub = a
    ? [data.showIp ? a.ip : undefined, data.showVendor && a.vendor && a.vendor !== 'Private address' ? a.vendor : undefined].filter(Boolean).join(' · ')
    : (data.detail ?? '');
  const name = (data.announced && data.label) || a?.hostname || (a ? displayName(a) : (data.label ?? 'Unknown device'));
  // Announced over LLDP, or a virtual machine by its network card: that beats the scan's guess.
  const firm = (data.announced || data.deviceType === 'vm') && data.deviceType && data.deviceType !== 'unknown';
  const type = firm ? (data.deviceType as DeviceType) : a?.type && a.type !== 'unknown' ? a.type : (data.deviceType ?? 'unknown');
  return (
    <div className={`map-member${selected ? ' selected' : ''}${a ? '' : ' learned'}${data.self ? ' self' : ''}`} title={a ? undefined : 'Seen by a switch; not in the inventory yet'}>
      {data.self && <YouBadge />}
      <DeviceTile type={type} size="sm" />
      <div className="map-text">
        <b title={name}>{name}</b>
        {sub && sub !== name && <span title={sub}>{sub}</span>}
      </div>
      {data.port && (
        <span
          className={`map-port-badge${data.poe ? ' poe' : ''}${(data.rate ?? 0) >= FLOW_MIN_BPS ? ' active' : ''}`}
          title={`Switch port ${data.port}${data.poeWatts ? ` · ${data.poeWatts} W PoE` : data.poe ? ' · PoE' : ''}${(data.rate ?? 0) >= FLOW_MIN_BPS ? ` · ${formatRate(data.rate ?? 0)}` : ''}`}
        >
          {data.poe && <Zap className="icon" />}
          {data.port}
          {data.poeWatts ? ` · ${data.poeWatts} W` : ''}
          {data.vlan ? <span className="map-vlan-tag" style={{ color: data.vlanColor }}> · V{data.vlan}</span> : null}
        </span>
      )}
      {!data.port && data.wireless && (
        <span className="map-port-badge wireless" title={WIRELESS_NOTE} aria-label={WIRELESS_NOTE}>
          <Wifi className="icon" />
        </span>
      )}
      {a?.risks.length ? <span className="map-risk" title={`${a.risks.length} ${a.risks.length === 1 ? 'risk' : 'risks'}`} /> : null}
    </div>
  );
}

/** A way out of the network: the internet, or the next hop that was not read ("Upstream"). */
function InternetNode({ data }: NodeProps<Node<ExitData>>) {
  const upstream = !!data.label;
  return (
    <div className={`map-node internet${upstream ? ' upstream' : ''}`} title={data.detail}>
      <div className="map-glyph">{upstream ? <ArrowUpFromLine className="icon" /> : <Globe className="icon" />}</div>
      <div className="map-text">
        <b>{data.label ?? 'Internet'}</b>
        {data.via && <span title={`Next hop of the default route: ${data.via}`}>via {data.via}</span>}
      </div>
      {data.scan && (
        <button
          className="map-exit-scan nodrag"
          disabled={data.scan.busy}
          title={`${data.via} was not scanned. Scan ${data.scan.cidr} to find out what it is.`}
          aria-label={`Scan ${data.scan.cidr}`}
          onClick={(e) => {
            e.stopPropagation();
            data.scan?.run();
          }}
        >
          <Search className="icon" aria-hidden />
        </button>
      )}
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </div>
  );
}

function GroupNode({ data }: NodeProps<Node<GroupData>>) {
  return (
    <div className={`map-node group${data.collapsed ? ' collapsed' : ''}`}>
      <Handle type="target" position={Position.Top} style={hidden} isConnectable={false} />
      {/* The header moves the whole container; the chevron shows or hides its devices. */}
      <div className="map-group-head" title="Drag to move this group">
        <button
          className="map-group-toggle nodrag"
          onClick={data.onToggle}
          aria-expanded={!data.collapsed}
          aria-label={`${data.collapsed ? 'Show' : 'Hide'} ${data.label}`}
          title={data.collapsed ? 'Show these devices' : 'Hide these devices'}
        >
          {data.collapsed ? <ChevronRight className="icon" /> : <ChevronDown className="icon" />}
        </button>
        <span className="map-group-label">{data.label}</span>
        <span className="map-count">{data.count}</span>
      </div>
      <Handle type="source" position={Position.Bottom} style={hidden} isConnectable={false} />
    </div>
  );
}

/**
 * Label boxes each cable has placed on the canvas, so later cables keep their labels clear of them.
 * A cable only looks at cables earlier in the drawing order, so placement settles instead of looping,
 * and it redraws only when one of those earlier cables moved a label.
 */
const cableLabelBoxes = (() => {
  const boxes = new Map<string, { order: number; list: Box[] }>();
  const listeners = new Set<() => void>();
  let version = 0;
  const signatures = new Map<number, { version: number; value: string }>();
  const notify = () => {
    version++;
    for (const fn of listeners) fn();
  };
  const key = (list: Box[]) => list.map((b) => `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)},${Math.round(b.h)}`).join(';');
  // While a node is dragged or the view pans or zooms, labels skip the cross-cable pass; it runs once
  // when both have ended. Kept as two flags, since a zoom can end in the middle of a drag.
  const active = { drag: false, view: false };
  let moving = false;
  return {
    get moving() {
      return moving;
    },
    setMoving(kind: 'drag' | 'view', on: boolean) {
      active[kind] = on;
      const now = active.drag || active.view;
      if (now === moving) return;
      moving = now;
      if (!now) notify();
    },
    /** Ends every gesture, for a canvas that goes away in the middle of one. */
    reset() {
      active.drag = active.view = false;
      if (moving) {
        moving = false;
        notify();
      }
    },
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    before(order: number): Box[] {
      const out: Box[] = [];
      for (const v of boxes.values()) if (v.order < order) out.push(...v.list);
      return out;
    },
    /** A short text that changes only when a label before `order` moved. */
    signature(order: number): string {
      if (moving) return 'moving';
      const cached = signatures.get(order);
      if (cached?.version === version) return cached.value;
      const value = key(this.before(order));
      signatures.set(order, { version, value });
      return value;
    },
    set(id: string, order: number, list: Box[]) {
      const prev = boxes.get(id);
      if (prev && prev.order === order && key(prev.list) === key(list)) return;
      boxes.set(id, { order, list });
      if (!moving) notify();
    },
    drop(id: string) {
      if (boxes.delete(id)) notify();
    },
  };
})();

/** The ports a link bundle is made of at one end, beside the name of the bundle: " (Et0/2, Et0/3)", or their number when they are many. */
function bundlePorts(ports?: string[]): string {
  if (!ports?.length) return '';
  return ports.length > 4 ? ` (${ports.length} ports)` : ` (${ports.join(', ')})`;
}

/** Text in the middle of a cable: what spanning tree does on a redundant one, or that it is a link bundle; else PoE and traffic. */
function middleLabel(data?: LinkData): string[] {
  const bundle = data?.bundle ? `Link bundle · ${data.bundle.cables} cables` : '';
  if (data?.redundant) return [data.redundant.blocked ? 'Blocked by spanning tree' : bundle || 'Redundant link'];
  const rate = data?.rate ?? 0;
  return [bundle, data?.tunnel ? 'Tunnel' : '', data?.poe ? (data.poeWatts ? `${data.poeWatts} W` : 'PoE') : '', rate >= FLOW_MIN_BPS ? formatRate(rate) : ''].filter(Boolean);
}

/**
 * The networks a router port carries, shown at once beside the port while the pointer is on it.
 * It is drawn over the whole window so device cards never cover it, and kept inside the window.
 */
function RoutesTip({ at, port, routes }: { at: DOMRect; port?: string; routes: { vlan?: number; network: string; ip: string; port: string }[] }) {
  return (
    <AnchoredTip at={at} title={`Networks routed on ${port}`}>
      {routes.map((r) => (
        <span key={`${r.port}|${r.ip}`} className="map-port-tip-row">
          <span>{r.port}</span>
          <span>{`${r.ip}/${r.network.split('/')[1]}`}</span>
          <span>{r.vlan !== undefined ? `VLAN ${r.vlan}` : ''}</span>
        </span>
      ))}
    </AnchoredTip>
  );
}

/** The shared gateway addresses a router holds: address, network and VLAN, and whether the last reading shows it answering. */
function GatewaysTip({ at, gateways }: { at: DOMRect; gateways: SharedGateway[] }) {
  return (
    <AnchoredTip at={at} title="Gateway addresses shared with other routers">
      {gateways.map((g) => (
        <span key={g.ip} className="map-port-tip-row">
          <span>{`${g.ip} · ${g.protocol}`}</span>
          <span>{`${g.network}${g.vlan !== undefined ? ` · VLAN ${g.vlan}` : ''}`}</span>
          <span>{g.active ? 'answers for it (last reading)' : 'who answers for it was not read'}</span>
        </span>
      ))}
    </AnchoredTip>
  );
}

/**
 * Where on screen the element a tip belongs to is, while the pointer or the keyboard is on it, and
 * the properties that element takes. The map moving under the pointer (a zoom, a drag, a click)
 * would leave the tip in the wrong place: it closes.
 */
function useTipAt<T extends HTMLElement>() {
  const [at, setAt] = useState<DOMRect>();
  useEffect(() => {
    if (!at) return;
    const close = () => setAt(undefined);
    window.addEventListener('wheel', close, { passive: true });
    window.addEventListener('pointerdown', close);
    return () => {
      window.removeEventListener('wheel', close);
      window.removeEventListener('pointerdown', close);
    };
  }, [at]);
  const props = {
    tabIndex: 0,
    onMouseEnter: (e: React.MouseEvent<T>) => setAt(e.currentTarget.getBoundingClientRect()),
    onMouseLeave: () => setAt(undefined),
    onFocus: (e: React.FocusEvent<T>) => setAt(e.currentTarget.getBoundingClientRect()),
    onBlur: () => setAt(undefined),
  };
  return [at, props] as const;
}

/** A tip of three-column rows under a title, beside the element at `at`, kept inside the window. */
function AnchoredTip({ at, title, children }: { at: DOMRect; title: string; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: at.right + 8, top: at.top });
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    const fitsRight = at.right + 8 + box.width <= window.innerWidth - 8;
    const left = fitsRight ? at.right + 8 : Math.max(8, at.left - 8 - box.width);
    const top = Math.min(Math.max(8, at.top + at.height / 2 - box.height / 2), window.innerHeight - box.height - 8);
    setPos({ left, top });
  }, [at]);
  return (
    <div ref={ref} className="map-port-tip" role="tooltip" style={pos}>
      <b>{title}</b>
      {children}
    </div>
  );
}

/** A link with port names at both ends, PoE colour and, while traffic flows, a moving dash. */
function LinkEdge(props: EdgeProps<Edge<LinkData>>) {
  const { id, data } = props;
  // Links meet each node on the side facing the other end; the handles only anchor them.
  const at = data?.at;
  const sx = at?.sx ?? props.sourceX;
  const sy = at?.sy ?? props.sourceY;
  const tx = at?.tx ?? props.targetX;
  const ty = at?.ty ?? props.targetY;
  const sourceSide: Side = at?.sourceSide ?? 'bottom';
  const targetSide: Side = at?.targetSide ?? 'top';
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: POSITION[sourceSide],
    targetX: tx,
    targetY: ty,
    targetPosition: POSITION[targetSide],
    borderRadius: 12,
    // Each link sharing a side turns in its own lane.
    ...(at?.turn !== undefined ? (sourceSide === 'top' || sourceSide === 'bottom' ? { centerY: at.turn } : { centerX: at.turn }) : {}),
  });
  // Labels ride on the drawn cable: each port name towards the device that owns it, the PoE and
  // traffic label at the middle. They are placed from their rendered sizes so they never cover each
  // other, and follow the line wherever either end is dragged.
  const measure = useRef<SVGPathElement>(null);
  const srcRef = useRef<HTMLDivElement>(null);
  const dstRef = useRef<HTMLDivElement>(null);
  const midRef = useRef<HTMLDivElement>(null);
  const [placed, setPlaced] = useState<CableLabels>({});
  const [retry, setRetry] = useState(0);
  const middleText = middleLabel(data).join(' · ');
  const size = (el: HTMLDivElement | null) => (el ? { w: el.offsetWidth, h: el.offsetHeight } : undefined);
  const order = data?.order ?? 0;
  const earlier = useSyncExternalStore(cableLabelBoxes.subscribe, () => cableLabelBoxes.signature(order));
  useEffect(() => () => cableLabelBoxes.drop(id), [id]);
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    // Labels mount in a separate layer and can arrive a frame after the cable; measure again then.
    const missing = (data?.sourcePort && !srcRef.current) || (data?.targetPort && !dstRef.current) || (middleText && !midRef.current);
    if (missing) {
      const frame = requestAnimationFrame(() => setRetry((n) => n + 1));
      return () => cancelAnimationFrame(frame);
    }
    const sizes = { src: size(srcRef.current), dst: size(dstRef.current), mid: size(midRef.current) };
    // The cable is measured once, every 2 px; placement then reads these points instead of asking the
    // browser for each one, which is the costly part.
    const total = el.getTotalLength();
    const step = 2;
    const last = Math.ceil(total / step);
    // Points are read lazily and kept, so a cable with few labels asks for few points.
    const samples = new Map<number, { x: number; y: number }>();
    const sample = (k: number) => {
      let p = samples.get(k);
      if (!p) {
        const q = el.getPointAtLength(Math.min(k * step, total));
        p = { x: q.x, y: q.y };
        samples.set(k, p);
      }
      return p;
    };
    const at = (d: number) => {
      const i = Math.max(0, Math.min(last, (Number.isFinite(d) ? d : 0) / step));
      const a = sample(Math.floor(i));
      const b = sample(Math.ceil(i));
      const t = i - Math.floor(i);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    };
    const next = placeCableLabels(total, at, sizes, cableLabelBoxes.moving ? [] : cableLabelBoxes.before(order));
    setPlaced((prev) => (near(prev.src, next.src) && near(prev.dst, next.dst) && near(prev.mid, next.mid) ? prev : next));
    const boxOf = (p?: { x: number; y: number }, sz?: { w: number; h: number }) => (p && sz ? [{ x: p.x - sz.w / 2, y: p.y - sz.h / 2, w: sz.w, h: sz.h }] : []);
    cableLabelBoxes.set(id, order, [...boxOf(next.src, sizes.src), ...boxOf(next.dst, sizes.dst), ...boxOf(next.mid, sizes.mid)]);
    // Label sizes change only with their text, so the cable, the texts and earlier cables' labels are enough to watch.
  }, [path, data?.sourcePort, data?.vlanText, data?.targetPort, middleText, retry, earlier, order, id]);
  const { src: srcAt, dst: dstAt, mid } = placed;
  const onLine = (p: { x: number; y: number } | undefined, x: number, y: number) =>
    `translate(-50%, -50%) translate(${p?.x ?? x}px, ${p?.y ?? y}px)`;
  const midX = mid?.x ?? labelX;
  const midY = mid?.y ?? labelY;
  const rate = data?.rate ?? 0;
  const flowing = rate >= FLOW_MIN_BPS;
  // Faster dash for busier links: about 2 s per cycle when idle-ish, 0.4 s near 1 Gbps.
  const level = Math.min(1, Math.log10(1 + rate) / 9);
  const redundant = data?.redundant;
  const middle = middleLabel(data);
  const subinterfaces = data?.routes?.filter((r) => r.vlan !== undefined).length ?? 0;
  // The port that carries the routed networks shows them while the pointer or the keyboard is on it.
  const routedAt = data?.routes?.length ? (data.routesAtTarget ? 'target' : 'source') : undefined;
  const [tipAt, tipProps] = useTipAt<HTMLDivElement>();
  return (
    <>
      <path ref={measure} d={path} fill="none" stroke="none" aria-hidden />
      {/* One VLAN colours the whole cable; a trunk alternates the colours of the VLANs it carries. */}
      <BaseEdge
        id={id}
        path={path}
        style={data?.vlanColors?.length === 1 ? { stroke: data.vlanColors[0], strokeWidth: 2 } : data?.vlanColors?.length ? { stroke: 'transparent' } : undefined}
      />
      {data?.vlanColors && data.vlanColors.length > 1 &&
        data.vlanColors.map((color, i, all) => (
          <path
            key={i}
            d={path}
            className="map-trunk"
            stroke={color}
            strokeDasharray={`${TRUNK_STRIPE} ${TRUNK_STRIPE * (all.length - 1)}`}
            strokeDashoffset={-TRUNK_STRIPE * i}
          />
        ))}
      {flowing && <path d={path} className="map-flow" style={{ animationDuration: `${(1.6 - level * 1.2).toFixed(2)}s` }} />}
      <EdgeLabelRenderer>
        <div className={data?.dim ? 'map-labels dim' : 'map-labels'}>
        {/* Each port name sits on the cable, on the side of the device that owns the port. */}
        {data?.sourcePort && (
          <div
            ref={srcRef}
            className={`map-port src${redundant?.blockedEnd === 'source' ? ' blocked' : ''}${routedAt === 'source' ? ' has-tip' : ''}`}
            title={redundant?.blockedEnd === 'source' ? 'Spanning tree blocks this port' : routedAt === 'source' ? undefined : (data.sourcePortsAll ?? data.bundle?.sourcePorts?.join(', '))}
            style={{ transform: onLine(srcAt, sx, sy) }}
            {...(routedAt === 'source' ? tipProps : {})}
          >
            {data.sourcePort}
            {bundlePorts(data.bundle?.sourcePorts)}
            {data.vlanText ? <span className="map-vlan-tag"> · {data.vlanText}</span> : null}
            {routedAt === 'source' && subinterfaces ? <span className="map-sub-count"> ({subinterfaces})</span> : null}
          </div>
        )}
        {tipAt && data?.routes?.length
          ? createPortal(<RoutesTip at={tipAt} port={routedAt === 'target' ? data.targetPort : data.sourcePort} routes={data.routes} />, document.body)
          : null}
        {data?.targetPort && (redundant || data.peer) && (
          <div
            ref={dstRef}
            className={`map-port dst${redundant?.blockedEnd === 'target' ? ' blocked' : ''}${routedAt === 'target' ? ' has-tip' : ''}`}
            title={redundant?.blockedEnd === 'target' ? 'Spanning tree blocks this port' : data.bundle?.targetPorts?.join(', ')}
            style={{ transform: onLine(dstAt, tx, ty) }}
            {...(routedAt === 'target' ? tipProps : {})}
          >
            {data.targetPort}
            {bundlePorts(data.bundle?.targetPorts)}
            {routedAt === 'target' && subinterfaces ? <span className="map-sub-count"> ({subinterfaces})</span> : null}
          </div>
        )}
        {data?.targetPort && !redundant && !data.peer && (
          <div
            ref={dstRef}
            className={`map-port dst uplink${routedAt === 'target' ? ' has-tip' : ''}`}
            title={routedAt === 'target' ? undefined : `Uplink: the port this device uses to reach the network above it`}
            style={{ transform: onLine(dstAt, tx, ty) }}
            {...(routedAt === 'target' ? tipProps : {})}
          >
            <span aria-hidden>↑</span> {data.targetPort}
            {bundlePorts(data.bundle?.targetPorts)}
            {routedAt === 'target' && subinterfaces ? <span className="map-sub-count"> ({subinterfaces})</span> : null}
          </div>
        )}
        {middle.length > 0 && (
          <div
            ref={midRef}
            className={`map-link-label${data?.poe && !redundant ? ' poe' : ''}${redundant ? ' redundant' : ''}`}
            style={{ transform: `translate(-50%, -50%) translate(${midX}px, ${midY}px)` }}
          >
            {data?.poe && !redundant && <Zap className="icon" />}
            {middle.join(' · ')}
          </div>
        )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

/** A titled part of the side panel that folds away; which parts are open is remembered. */
function MapSection({
  id,
  title,
  count,
  open,
  onToggle,
  children,
}: {
  id: string;
  title: string;
  count?: number;
  open: Record<string, boolean>;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}) {
  const expanded = open[id] ?? true;
  return (
    <section className="map-section">
      <button className="map-section-h" aria-expanded={expanded} aria-controls={`map-section-${id}`} onClick={() => onToggle(id)}>
        {expanded ? <ChevronDown className="icon" /> : <ChevronRight className="icon" />}
        <span>{title}</span>
        {count !== undefined && <span className="map-count">{count}</span>}
      </button>
      {expanded && (
        <div className="map-section-body" id={`map-section-${id}`}>
          {children}
        </div>
      )}
    </section>
  );
}

const NODE_TYPES = { device: DeviceNode, member: MemberNode, internet: InternetNode, cluster: GroupNode };
const EDGE_TYPES = { link: LinkEdge };
const FIT = { padding: 0.08, minZoom: 0.5, maxZoom: 1, duration: 200 };

// ---------------------------------------------------------------- page

/**
 * Export of where each device is connected: kinds of device to include, an optional text filter
 * (name, IP, MAC or vendor, like the map search) and a preview of the first rows.
 */
function ExportConnectionsDialog({
  open,
  onOpenChange,
  rows,
  hasSwitchData,
  fileBase,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rows: ConnectionRow[];
  hasSwitchData: boolean;
  fileBase: string;
}) {
  const toast = useStore((s) => s.toast);
  const [kinds, setKinds] = useState<Set<Category>>(() => new Set(CATEGORIES.map((c) => c.id)));
  const [text, setText] = useState('');
  const [seenOnly, setSeenOnly] = useState(false);
  const counts = useMemo(() => {
    const m = new Map<Category, number>();
    for (const r of rows) m.set(r.category, (m.get(r.category) ?? 0) + 1);
    return m;
  }, [rows]);
  const chosen = useMemo(() => {
    let list = rows.filter((r) => kinds.has(r.category) && (!seenOnly || r.confirmed));
    if (text.trim()) {
      const match = new Set(
        searchMap(
          list.map((r) => ({ id: r.id, ...r.device, port: r.switchPort })),
          text,
          Infinity,
        ).map((e) => e.id),
      );
      list = list.filter((r) => match.has(r.id));
    }
    return list;
  }, [rows, kinds, text, seenOnly]);

  const toggle = (c: Category) =>
    setKinds((k) => {
      const next = new Set(k);
      if (next.has(c)) next.delete(c);
      else next.add(c);
      return next;
    });

  const save = async () => {
    try {
      const path = await window.api.map.saveCsv(toCsv(CONNECTION_COLUMNS, chosen.map(connectionCells)), fileBase);
      if (path) {
        toast('success', `Exported ${chosen.length} ${chosen.length === 1 ? 'device' : 'devices'} to ${path}`);
        onOpenChange(false);
      }
    } catch (err) {
      toast('error', cleanError(err));
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog export-connections">
          <Dialog.Title asChild>
            <h2>Export connections</h2>
          </Dialog.Title>
          <Dialog.Description className="muted" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
            One row per scanned device: what it is plugged into, the switch and port, VLAN, PoE and the path to the
            gateway. Connections come from the switches read over SNMP; one no switch has seen is left blank, never guessed.
          </Dialog.Description>
          {!hasSwitchData && (
            <div className="export-notice" role="note">
              <b>No switch data for this network.</b> Without an SNMP community the app cannot tell where devices are
              plugged in: the file will list the devices with their addresses and leave the connection columns empty. Set
              up the SNMP community in the map panel and read the switches first.
            </div>
          )}

          <div className="export-label">Kinds of device</div>
          <div className="export-kinds" role="group" aria-label="Kinds of device">
            {CATEGORIES.filter((c) => counts.get(c.id)).map((c) => (
              <button key={c.id} className="chip-toggle" aria-pressed={kinds.has(c.id)} onClick={() => toggle(c.id)}>
                {c.label} <span className="muted">{counts.get(c.id)}</span>
              </button>
            ))}
          </div>

          <label className="export-label" htmlFor="export-text">
            Only devices matching <span className="muted">(optional)</span>
          </label>
          <div className="input">
            <Search className="icon" aria-hidden />
            <input id="export-text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, IP, MAC or vendor, e.g. Hikvision or 10.0.0." spellCheck={false} />
          </div>

          <label className="export-check">
            <input type="checkbox" checked={seenOnly} onChange={(e) => setSeenOnly(e.target.checked)} disabled={!hasSwitchData} />
            Only devices a switch has seen (skip assumed links)
          </label>

          <div className="export-preview" aria-label="Preview">
            {chosen.length ? (
              <table>
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Connected to</th>
                    <th>Switch · port</th>
                  </tr>
                </thead>
                <tbody>
                  {chosen.slice(0, 6).map((r) => (
                    <tr key={r.id}>
                      <td>
                        <b>{r.device.name}</b>
                        <span className="mono">{r.device.ip ?? r.device.mac ?? ''}</span>
                      </td>
                      {r.confirmed ? (
                        <>
                          <td>{r.connectedTo?.name ?? '—'}</td>
                          <td>{r.switch ? `${r.switch.name}${r.switchPort ? ` · ${r.switchPort}` : ''}` : '—'}</td>
                        </>
                      ) : (
                        <td colSpan={2} className="muted">
                          Not known: no switch has seen it
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No device matches these filters.</p>
            )}
            {chosen.length > 6 && <p className="muted">…and {chosen.length - 6} more in the file.</p>}
          </div>

          <div className="row">
            <Dialog.Close asChild>
              <button className="btn">Cancel</button>
            </Dialog.Close>
            <button className="btn primary" disabled={!chosen.length} onClick={() => void save()}>
              <FileSpreadsheet className="icon" /> Export {chosen.length} {chosen.length === 1 ? 'device' : 'devices'}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Floating search over the canvas: finds a device by name, IP address, MAC address or vendor. */
function MapSearch({ entries, shifted, onPick }: { entries: MapSearchEntry[]; shifted: boolean; onPick: (id: string) => void }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => searchMap(entries, query), [entries, query]);

  // Cmd/Ctrl+F puts the cursor in the search box while the map is shown.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.current?.focus();
        input.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const pick = (e: MapSearchEntry) => {
    onPick(e.id);
    setOpen(false);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[active]) {
      pick(results[active]);
    } else if (e.key === 'Escape') {
      if (query) setQuery('');
      else input.current?.blur();
      setOpen(false);
    }
  };

  return (
    <div className={`map-search${shifted ? ' shifted' : ''}`} role="search">
      <Search className="icon muted" aria-hidden />
      <input
        ref={input}
        value={query}
        placeholder="Find a device: name, IP or MAC"
        aria-label="Find a device on the map"
        role="combobox"
        aria-expanded={open && !!query.trim()}
        aria-controls="map-search-results"
        aria-activedescendant={open && results[active] ? `map-search-${active}` : undefined}
        spellCheck={false}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={onKeyDown}
      />
      {query && (
        <button className="map-search-clear" aria-label="Clear the search" onClick={() => { setQuery(''); input.current?.focus(); }}>
          <X className="icon" />
        </button>
      )}
      {open && query.trim() && (
        <ul className="map-search-results" id="map-search-results" role="listbox" aria-label="Devices found">
          {results.length ? (
            results.map((r, i) => (
              <li
                key={r.id}
                id={`map-search-${i}`}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : undefined}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
              >
                <b>{r.name}</b>
                <span className="mono">{[r.ip, r.mac].filter(Boolean).join(' · ') || '—'}</span>
                {(r.port || r.vendor) && <span>{[r.port && `Port ${r.port}`, r.vendor].filter(Boolean).join(' · ')}</span>}
              </li>
            ))
          ) : (
            <li className="empty">No device on this map matches.</li>
          )}
        </ul>
      )}
    </div>
  );
}

function MapCanvas() {
  const assets = useStore((s) => s.assets);
  const networks = useStore((s) => s.networks);
  const theme = useStore((s) => s.theme);
  const toast = useStore((s) => s.toast);
  const setView = useStore((s) => s.setView);
  const { fitView, getNodes } = useReactFlow();

  const sorted = useMemo(() => [...networks].sort((a, b) => b.lastScanAt.localeCompare(a.lastScanAt)), [networks]);
  // A request from another module to show one device opens its network.
  const [networkId, setNetworkId] = useState<string | undefined>(() => {
    const asked = useStore.getState().mapFocus?.networkId;
    if (asked) localStorage.setItem(NETWORK_KEY, asked);
    return asked ?? localStorage.getItem(NETWORK_KEY) ?? undefined;
  });
  const network = sorted.find((n) => n.id === networkId) ?? sorted[0];
  const [prefs, setPrefs] = useState<ViewPrefs>(() => readJson(VIEW_KEY, DEFAULT_PREFS));
  const [saved, setSaved] = useState<Positions>({});
  const [nodes, setNodes] = useState<Node[]>([]);
  const [openId, setOpenId] = useState<string>();
  /** A device on the map that is not in the inventory, shown in its own drawer. */
  const [openNodeId, setOpenNodeId] = useState<string>();
  const closeDrawer = () => {
    setOpenId(undefined);
    setOpenNodeId(undefined);
  };
  const [sideHidden, setSideHiddenState] = useState(() => localStorage.getItem(SIDE_KEY) === 'hidden');
  const setSideHidden = (hidden: boolean) => {
    setSideHiddenState(hidden);
    localStorage.setItem(SIDE_KEY, hidden ? 'hidden' : 'shown');
  };
  const [sections, setSections] = useState<Record<string, boolean>>(() => readJson(SECTIONS_KEY, DEFAULT_SECTIONS));
  const toggleSection = (id: string) =>
    setSections((s) => {
      const next = { ...s, [id]: !s[id] };
      localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      return next;
    });
  const [focused, setFocused] = useState<string>();
  const [vlanFilter, setVlanFilter] = useState<number>();
  /** Shows one VLAN on the map, or every VLAN again when it is already shown. */
  const showVlan = useCallback((vlan: number) => setVlanFilter((v) => (v === vlan ? undefined : vlan)), []);
  const [snmp, setSnmp] = useState<SnmpSettings>({ configured: false });
  const [gear, setGear] = useState<GearSnapshot | null>(null);
  const [reading, setReading] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const [traffic, setTraffic] = useState<Map<string, number>>(new Map());

  const updatePrefs = useCallback(
    (patch: Partial<ViewPrefs>) =>
      setPrefs((p) => {
        const next = { ...p, ...patch };
        localStorage.setItem(VIEW_KEY, JSON.stringify(next));
        return next;
      }),
    [],
  );

  const toggleGroup = useCallback(
    (id: string) =>
      setPrefs((p) => {
        const next = { ...p, collapsed: p.collapsed.includes(id) ? p.collapsed.filter((c) => c !== id) : [...p.collapsed, id] };
        localStorage.setItem(VIEW_KEY, JSON.stringify(next));
        return next;
      }),
    [],
  );

  const currentId = network?.id;
  useEffect(() => {
    if (!currentId) return;
    setSaved(readJson<Positions>(layoutKey(currentId), {}));
    setTraffic(new Map());
    setVlanFilter(undefined);
    let alive = true;
    void Promise.all([window.api.snmp.settings(currentId), window.api.snmp.snapshot(currentId)]).then(([settings, snapshot]) => {
      if (!alive) return;
      setSnmp(settings);
      setGear(snapshot);
    });
    return () => {
      alive = false;
    };
  }, [currentId]);

  const readGear = useCallback(async () => {
    if (!currentId) return;
    setReading(true);
    try {
      const snapshot = await window.api.snmp.read(currentId);
      setGear(snapshot);
      setTraffic(new Map());
      // MAC addresses read from routers and switches were added to the inventory: reload it.
      if (snapshot.macsFilled) await useStore.getState().load();
      const ports = snapshot.devices.reduce((n, d) => n + d.fdb.length, 0);
      const filled = snapshot.macsFilled ? ` ${snapshot.macsFilled} devices got their MAC address and vendor.` : '';
      toast(
        snapshot.devices.length ? 'success' : 'error',
        snapshot.devices.length
          ? `Read ${snapshot.devices.length} managed ${snapshot.devices.length === 1 ? 'device' : 'devices'}: ${ports} addresses on their ports.${filled}`
          : `None of the ${snapshot.probed} devices answered SNMP with this community.`,
      );
    } catch (err) {
      toast('error', cleanError(err));
    } finally {
      setReading(false);
    }
  }, [currentId, toast]);

  // Live traffic: port counters are sampled every few seconds while the map is open.
  const liveOn = prefs.live && snmp.configured && !!gear?.devices.length;
  useEffect(() => {
    if (!liveOn || !currentId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The next sample is scheduled once this one ends, so a slow network never has two in flight.
    const sample = async () => {
      try {
        const rates = await window.api.snmp.traffic(currentId);
        if (alive && rates.length) setTraffic(new Map(rates.map((r) => [`${r.ip}|${r.ifIndex}`, r.inBps + r.outBps])));
      } catch {
        // A missed sample keeps the previous rates; the next one retries.
      }
      if (alive) timer = setTimeout(() => void sample(), TRAFFIC_EVERY_MS);
    };
    void sample();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [liveOn, currentId, gear]);

  // This computer's addresses, to mark where the map is drawn from.
  const [selfIps, setSelfIps] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void window.api.scan
      .localTargets()
      .then((list) => {
        const next = list.map((t) => t.address);
        // The same addresses keep the same list, so the map is not rebuilt for nothing.
        if (alive) setSelfIps((prev) => (prev.length === next.length && prev.every((ip, i) => ip === next[i]) ? prev : next));
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [currentId]);
  const members = useMemo(() => (network ? Object.values(assets).filter((a) => a.networkId === network.id) : []), [assets, network]);
  const topo = useMemo(
    () =>
      network
        ? buildTopology(network, members, { clients: prefs.clients, collapsed: new Set(prefs.collapsed), self: selfIps }, gear)
        : { nodes: [], edges: [], confirmed: false },
    [network, members, prefs.clients, prefs.collapsed, gear, selfIps],
  );
  const layout = useMemo(() => layoutTree(topo), [topo]);

  // Networks the managed routers hold that were not scanned, offered to be scanned into this network.
  const scanInto = useStore((s) => s.scanInto);
  const scanning = useStore((s) => s.scan.running);
  const unscanned = useMemo(
    () => (network && gear?.devices.length ? unscannedNetworks(gear.devices, scannedRanges(network), members.map((a) => a.ip)) : []),
    [network, gear, members],
  );
  const scanNetwork = useCallback((cidr: string) => (currentId ? void scanInto(currentId, cidr) : undefined), [currentId, scanInto]);

  /**
   * Every device that can be drawn for this network, whatever the view and folded groups, so the
   * search finds devices that are hidden right now too.
   */
  const fullTopo = useMemo(
    () => (network ? buildTopology(network, members, { clients: true, collapsed: new Set() }, gear) : { nodes: [], edges: [], confirmed: false }),
    [network, members, gear],
  );
  /** A node's name and addresses, the way the map shows them. */
  const facts = useCallback(
    (n: MapNode): NodeFacts => {
      const a = n.assetId ? assets[n.assetId] : undefined;
      const mac = a?.mac ?? (n.id.startsWith('mac:') ? n.id.slice(4) : n.detail && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(n.detail) ? n.detail : undefined);
      return {
        name: ((n.managed || n.announced) && n.label) || (a ? displayName(a) : (n.label ?? (n.kind === 'gateway' ? 'Gateway' : 'Unknown device'))),
        ip: a?.ip ?? n.ip,
        mac,
        vendor: a?.vendor ?? (n.id.startsWith('mac:') && n.label !== 'Unknown device' ? n.label : undefined),
        type: n.announced && n.deviceType && n.deviceType !== 'unknown' ? n.deviceType : (a?.type ?? n.deviceType),
      };
    },
    [assets],
  );
  const searchIndex = useMemo(() => {
    const parent = new Map<string, string>();
    const entries: MapSearchEntry[] = [];
    for (const n of fullTopo.nodes) {
      if (n.kind === 'internet' || n.kind === 'group' || n.id.startsWith('segment:')) continue;
      if (n.parent) parent.set(n.id, n.parent);
      entries.push({ id: n.id, ...facts(n), port: n.port });
    }
    return { entries, parent };
  }, [fullTopo, facts]);
  const [exportOpen, setExportOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  // Where every device is plugged in: for the connections export and for each device's drawer.
  const connections = useMemo(() => connectionRows(fullTopo, facts), [fullTopo, facts]);
  /** Lookups into the full topology, so drawers do not scan every node on each render. */
  const fullIndex = useMemo(() => {
    const byId = new Map(fullTopo.nodes.map((n) => [n.id, n]));
    const byAsset = new Map(fullTopo.nodes.filter((n) => n.assetId).map((n) => [n.assetId as string, n]));
    // A node named after one inventory device and drawn as another (a gateway address routers
    // share, on the router that holds it) is found by either.
    for (const n of fullTopo.nodes) if (!byAsset.has(n.id)) byAsset.set(n.id, n);
    const members = new Map<string, number>();
    for (const n of fullTopo.nodes) if (n.parent) members.set(n.parent, (members.get(n.parent) ?? 0) + 1);
    return { byId, byAsset, members };
  }, [fullTopo]);
  const connectionByAsset = useMemo(() => {
    const out = new Map<string, ConnectionRow>();
    for (const r of connections) {
      const assetId = fullIndex.byId.get(r.id)?.assetId;
      if (assetId) out.set(assetId, r);
    }
    for (const r of connections) if (!out.has(r.id)) out.set(r.id, r);
    return out;
  }, [connections, fullIndex]);
  // A drawer whose device is no longer on the map (a rescan, another network) closes instead of lingering.
  useEffect(() => {
    if (openNodeId && !fullIndex.byId.has(openNodeId)) setOpenNodeId(undefined);
  }, [openNodeId, fullIndex]);
  const [pendingFocus, setPendingFocus] = useState<string>();

  const vlanColor = useCallback(
    (id: number) =>
      id === 1 ? VLAN_DEFAULT_COLOR : (VLAN_COLORS[(topo.vlans ?? []).filter((v) => v.id !== 1).findIndex((v) => v.id === id) % VLAN_COLORS.length] as string),
    [topo.vlans],
  );
  /** Nodes and links that belong to the VLAN being shown; everything else is dimmed. */
  const inVlan = useMemo(() => {
    if (vlanFilter === undefined) return undefined;
    // A cable carries the VLAN when its switch port does, or when the router at its top end routes it there.
    const carries = (e: (typeof topo.edges)[number]) =>
      e.vlan?.pvid === vlanFilter || !!e.vlan?.tagged?.includes(vlanFilter) || !!e.routes?.some((r) => r.vlan === vlanFilter);
    const edges = new Set([...topo.edges, ...(topo.redundant ?? []), ...(topo.peers ?? [])].filter(carries).map((e) => e.id));
    const nodes = new Set<string>();
    for (const e of topo.edges) if (edges.has(e.id)) nodes.add(e.source).add(e.target);
    for (const e of [...(topo.redundant ?? []), ...(topo.peers ?? [])]) if (edges.has(e.id)) nodes.add(e.source).add(e.target);
    // The networks routers serve on this VLAN: a device with an address in one belongs to it.
    const served = topo.nodes.flatMap((n) => (n.routes ?? []).filter((r) => r.vlan === vlanFilter).map((r) => r.network));
    for (const n of topo.nodes) {
      // The router that routes the VLAN is part of it.
      if (n.routes?.some((r) => r.vlan === vlanFilter)) nodes.add(n.id);
      const ip = (n.assetId ? assets[n.assetId]?.ip : undefined) ?? n.ip;
      const inServed = n.kind === 'device' && !n.managed && !!ip && served.some((net) => inCidr(ip, net));
      if (inServed) nodes.add(n.id);
      if (n.parent && (inServed || n.vlan === vlanFilter || n.tagged?.includes(vlanFilter))) nodes.add(n.id).add(n.parent);
    }
    // The cable to a group of devices in the VLAN is lit with it.
    const groups = new Set(topo.nodes.filter((n) => n.kind === 'group').map((n) => n.id));
    for (const e of topo.edges) if (groups.has(e.target) && nodes.has(e.source) && nodes.has(e.target)) edges.add(e.id);
    return { nodes, edges };
  }, [vlanFilter, topo, assets]);

  /** Node boxes on the canvas, following drags, for attaching links to the facing sides. */
  // Redundant cables are cabling between network gear: drawn in the infrastructure view only.
  const redundantShown = useMemo(() => {
    if (prefs.clients || !topo.redundant) return [];
    const cards = new Set(topo.nodes.filter((n) => !n.parent).map((n) => n.id));
    return topo.redundant.filter((e) => cards.has(e.source) && cards.has(e.target));
  }, [prefs.clients, topo.redundant, topo.nodes]);
  const attachments = useMemo(() => {
    const boxes = new Map<string, Box>();
    for (const n of nodes) {
      if (n.parentId) continue;
      const size = layout.sizes[n.id];
      const w = n.measured?.width ?? size?.w;
      const h = n.measured?.height ?? size?.h;
      if (w && h) boxes.set(n.id, { x: n.position.x, y: n.position.y, w, h });
    }
    return attachLinks(boxes, [...topo.edges, ...redundantShown, ...(topo.peers ?? [])]);
  }, [nodes, layout, topo.edges, topo.peers, redundantShown]);

  // Loops are told on the card of the switch they are on, besides the list beside the map.
  const loops = useMemo(() => findLoops(gear?.devices ?? []), [gear]);
  const loopAt = useMemo(() => {
    const byIp = new Map(loops.map((l) => [l.switchIp, `Loop: ${describeLoop(l)}`]));
    const out = new Map<string, string>();
    if (byIp.size) for (const n of topo.nodes) if (n.managed) for (const ip of [n.ip, n.assetId !== undefined ? assets[n.assetId]?.ip : undefined]) if (ip && byIp.has(ip)) out.set(n.id, byIp.get(ip) as string);
    return out;
  }, [loops, topo.nodes, assets]);
  useEffect(() => {
    const label = (n: MapNode) => n.title ?? CATEGORIES.find((c) => c.id === n.category)?.label ?? 'Devices';
    setNodes(
      topo.nodes.map((n): Node => {
        const auto = layout.positions[n.id] ?? { x: 0, y: 0 };
        const position = n.parent ? auto : (saved[n.id] ?? auto);
        const size = layout.sizes[n.id];
        // Showing one VLAN dims everything outside it.
        const className = inVlan && !inVlan.nodes.has(n.id) ? 'dim' : undefined;
        if (n.kind === 'internet') {
          const offer = n.label ? unscanned.find((u) => u.nextHop === n.ip) : undefined;
          const scan = offer ? { cidr: offer.cidr, busy: scanning, run: () => scanNetwork(offer.cidr) } : undefined;
          return { id: n.id, type: 'internet', position, data: { label: n.label, detail: n.detail, via: n.ip, scan } satisfies ExitData, selectable: false, className };
        }
        if (n.kind === 'group') {
          const data: GroupData = { label: label(n), count: n.count ?? 0, collapsed: !!n.collapsed, onToggle: () => toggleGroup(n.id) };
          return { id: n.id, type: 'cluster', position, selectable: false, data, className, style: { width: size?.w, height: size?.h } };
        }
        const data: DeviceData = {
          asset: n.assetId ? assets[n.assetId] : undefined,
          ip: n.ip,
          label: n.label,
          detail: n.detail,
          deviceType: n.deviceType,
          managed: n.managed,
          announced: n.announced,
          typeRead: n.typeRead,
          segment: n.id.startsWith('segment:') || undefined,
          self: n.self,
          loop: loopAt.get(n.id),
          network: n.network,
          port: n.port,
          poe: n.poe,
          poeWatts: n.poeWatts,
          vlan: n.vlan && n.vlan !== 1 ? n.vlan : undefined,
          vlanColor: n.vlan && n.vlan !== 1 ? vlanColor(n.vlan) : undefined,
          rate: n.traffic && liveOn ? traffic.get(`${n.traffic.ip}|${n.traffic.ifIndex}`) : undefined,
          wireless: n.wireless,
          routes: n.routes?.flatMap((r) => (r.vlan !== undefined ? [{ vlan: r.vlan, network: r.network, port: r.port, color: vlanColor(r.vlan) }] : [])),
          shownVlan: vlanFilter,
          onVlan: showVlan,
          showIp: prefs.ip,
          showVendor: prefs.vendor,
          gateway: n.kind === 'gateway' && !n.sharedGateway,
          gateways: n.parent ? undefined : n.gateways,
        };
        if (n.parent) return { id: n.id, type: 'member', position, data, className, parentId: n.parent, extent: 'parent', draggable: false };
        return { id: n.id, type: 'device', position, data, className };
      }),
    );
  }, [topo, layout, saved, assets, prefs.ip, prefs.vendor, toggleGroup, inVlan, vlanColor, traffic, liveOn, vlanFilter, showVlan, unscanned, scanning, scanNetwork, loopAt]);

  /**
   * Traffic on a cable to a group: the total of its devices, shown only while at least one of them is
   * busy on its own, so a moving group cable always has a pulsing device inside.
   */
  const groupRate = useCallback(
    (ports?: { ip: string; ifIndex: number }[]) => {
      if (!ports?.length) return undefined;
      const rates = ports.map((t) => traffic.get(`${t.ip}|${t.ifIndex}`) ?? 0);
      return rates.some((r) => r >= FLOW_MIN_BPS) ? rates.reduce((a, b) => a + b, 0) : 0;
    },
    [traffic],
  );

  const edges: Edge[] = useMemo(
    () => [
      ...topo.edges.map(
        (e, order): Edge<LinkData> => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'link',
          className: `map-edge${e.inferred ? ' inferred' : ''}${e.tunnel ? ' tunnel' : ''}${e.poe ? ' poe' : ''}${inVlan && !inVlan.edges.has(e.id) ? ' dim' : ''}`,
          selectable: false,
          data: {
            order,
            sourcePort: e.sourcePort,
            sourcePortsAll: e.sourcePortsAll,
            routes: e.routes,
            routesAtTarget: e.routesAtTarget,
            tunnel: e.tunnel,
            bundle: e.bundle,
            targetPort: e.targetPort,
            poe: e.poe,
            poeWatts: e.poeWatts,
            speedMbps: e.speedMbps,
            rate: !liveOn ? undefined : e.traffic ? traffic.get(`${e.traffic.ip}|${e.traffic.ifIndex}`) : groupRate(e.trafficPorts),
            at: attachments.get(e.id),
            dim: !!inVlan && !inVlan.edges.has(e.id),
            vlanColors: e.vlan?.tagged?.length
              ? [...new Set([e.vlan.pvid, ...e.vlan.tagged].filter((v): v is number => v !== undefined))].map((v) =>
                  v === 1 ? VLAN_DEFAULT_COLOR : vlanColor(v),
                )
              : e.vlan?.pvid && e.vlan.pvid !== 1
                ? [vlanColor(e.vlan.pvid)]
                : undefined,
            vlanText: vlanLabel(e.vlan),
          },
        }),
      ),
      // Redundant cables (rings, second links) are drawn apart, dotted, with what spanning tree does on them.
      ...redundantShown.map(
        (e, i): Edge<LinkData> => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'link',
          className: `map-edge redundant${inVlan && !inVlan.edges.has(e.id) ? ' dim' : ''}`,
          selectable: false,
          data: {
            order: topo.edges.length + i,
            sourcePort: e.sourcePort,
            targetPort: e.targetPort,
            speedMbps: e.speedMbps,
            // A blocked port forwards nothing: no moving traffic on that cable.
            rate: liveOn && e.traffic && e.stp !== 'blocked' ? traffic.get(`${e.traffic.ip}|${e.traffic.ifIndex}`) : undefined,
            at: attachments.get(e.id),
            dim: !!inVlan && !inVlan.edges.has(e.id),
            redundant: { blocked: e.stp === 'blocked', blockedEnd: e.blockedPort ? (e.blockedPort.node === e.source ? 'source' : 'target') : undefined },
            bundle: e.bundle,
          },
        }),
      ),
      // Links between routers that each have their own way out: drawn side to side, in every view.
      ...(topo.peers ?? []).map(
        (e, i): Edge<LinkData> => ({
          id: e.id,
          source: e.source,
          target: e.target,
          type: 'link',
          className: `map-edge peer${e.tunnel ? ' tunnel' : ''}${inVlan && !inVlan.edges.has(e.id) ? ' dim' : ''}`,
          selectable: false,
          data: {
            order: topo.edges.length + redundantShown.length + i,
            sourcePort: e.sourcePort,
            targetPort: e.targetPort,
            speedMbps: e.speedMbps,
            routes: e.routes,
            routesAtTarget: e.routesAtTarget,
            rate: liveOn && e.traffic ? traffic.get(`${e.traffic.ip}|${e.traffic.ifIndex}`) : undefined,
            at: attachments.get(e.id),
            dim: !!inVlan && !inVlan.edges.has(e.id),
            peer: true,
            tunnel: e.tunnel,
            vlanText: vlanLabel(e.vlan),
            bundle: e.bundle,
          },
        }),
      ),
    ],
    [topo.edges, topo.peers, redundantShown, traffic, liveOn, attachments, inVlan, groupRate],
  );

  // Fits the drawing whenever another network or view is shown.
  useEffect(() => {
    const t = setTimeout(() => void fitView(FIT), 60);
    return () => clearTimeout(t);
  }, [currentId, prefs.clients, fitView]);

  useEffect(() => {
    if (!openId && !openNodeId) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpenId(undefined);
      setOpenNodeId(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId, openNodeId]);

  const onNodesChange = useCallback((changes: NodeChange[]) => setNodes((ns) => applyNodeChanges(changes, ns)), []);

  // While the map or a node moves: traffic dots pause and labels skip the cross-cable pass.
  const canvasRef = useRef<HTMLDivElement>(null);
  const setMoving = useCallback((kind: 'drag' | 'view', on: boolean) => {
    cableLabelBoxes.setMoving(kind, on);
    canvasRef.current?.classList.toggle('moving', cableLabelBoxes.moving);
  }, []);
  const startDrag = useCallback(() => setMoving('drag', true), [setMoving]);
  const startView = useCallback(() => setMoving('view', true), [setMoving]);
  const stopView = useCallback(() => setMoving('view', false), [setMoving]);
  useEffect(() => () => cableLabelBoxes.reset(), []);

  /** Remembers where the user dropped nodes, per network. */
  const onNodeDragStop = useCallback(
    (_: unknown, _node: Node, dragged: Node[]) => {
      setMoving('drag', false);
      if (!currentId) return;
      setSaved((prev) => {
        const next = { ...prev };
        for (const n of dragged) next[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
        localStorage.setItem(layoutKey(currentId), JSON.stringify(next));
        return next;
      });
    },
    [currentId],
  );

  /** Node that draws a device read over SNMP (the gateway node when it is the gateway). */
  const gearNodeId = (ip: string) =>
    topo.nodes.find((n) => n.managed && (n.ip === ip || (n.assetId !== undefined && assets[n.assetId]?.ip === ip)))?.id;

  /** Centres the canvas on one node and selects it. */
  const focusNode = (id: string) => {
    setFocused(id);
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id })));
    void fitView({ nodes: [{ id }], duration: 300, maxZoom: 1.1, padding: 0.6 });
  };

  /** Shows a found device: switches to the full view or unfolds its group when needed, then zooms to it. */
  const goToDevice = (id: string) => {
    const parent = searchIndex.parent.get(id);
    const patch: Partial<ViewPrefs> = {};
    if (!topo.nodes.some((n) => n.id === id) && !prefs.clients) patch.clients = true;
    if (parent && prefs.collapsed.includes(parent)) patch.collapsed = prefs.collapsed.filter((c) => c !== parent);
    if (Object.keys(patch).length) updatePrefs(patch);
    setVlanFilter(undefined);
    setPendingFocus(id);
  };
  // Shows the device another module asked for, once the network's switch reading is loaded.
  const mapFocus = useStore((s) => s.mapFocus);
  useEffect(() => {
    if (!mapFocus || mapFocus.networkId !== currentId || gear?.networkId !== currentId) return;
    useStore.getState().clearMapFocus();
    goToDevice(mapFocus.nodeId);
  }, [mapFocus, currentId, gear]);
  useEffect(() => {
    if (!pendingFocus || !nodes.some((n) => n.id === pendingFocus)) return;
    const id = pendingFocus;
    // Waits until the canvas stops changing (a group just unfolded gets its size) before zooming;
    // any change in between restarts the wait.
    const t = setTimeout(() => {
      setPendingFocus(undefined);
      setFocused(id);
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === id, className: n.id === id ? 'found' : n.className === 'found' ? undefined : n.className })));
      void fitView({ nodes: [{ id }], duration: 400, maxZoom: 1.3, padding: 0.8 });
    }, 80);
    return () => clearTimeout(t);
  }, [pendingFocus, nodes, fitView]);

  const rearrange = () => {
    if (!currentId) return;
    localStorage.removeItem(layoutKey(currentId));
    setSaved({});
    setTimeout(() => void fitView(FIT), 60);
  };

  /**
   * Draws the whole map (not just what is on screen) as a PNG or SVG data URL. `credit` adds a small
   * line in the bottom margin.
   */
  const renderMap = async (format: 'png' | 'svg', credit: boolean): Promise<{ data: string; width: number; height: number } | undefined> => {
    const el = document.querySelector<HTMLElement>('.map-canvas .react-flow__viewport');
    if (!el) return undefined;
    const canvas = document.querySelector<HTMLElement>('.map-canvas');
    canvas?.classList.add('exporting');
    // The image renderer does not carry stylesheet rules into SVG shapes, so link colours and dashes
    // are written onto each path as attributes (stylesheet rules still win on screen).
    for (const path of document.querySelectorAll<SVGPathElement>('.map-canvas .react-flow__edges path')) {
      const cs = getComputedStyle(path);
      path.setAttribute('stroke', cs.stroke);
      path.setAttribute('stroke-width', cs.strokeWidth);
      path.setAttribute('stroke-dasharray', cs.strokeDasharray === 'none' ? '' : cs.strokeDasharray);
      path.setAttribute('fill', 'none');
    }
    const bounds = getNodesBounds(getNodes());
    const pad = 48;
    const width = Math.ceil(bounds.width + pad * 2);
    const height = Math.ceil(bounds.height + pad * 2);
    const options = {
      backgroundColor: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || undefined,
      width,
      height,
      pixelRatio: format === 'png' ? 2 : 1,
      style: { width: `${width}px`, height: `${height}px`, transform: `translate(${pad - bounds.x}px, ${pad - bounds.y}px) scale(1)` },
    };
    const line = credit ? document.createElement('div') : undefined;
    if (line) {
      line.className = 'map-export-credit';
      line.textContent = 'Made with Meshwork · meshwork.influxnetwork.com';
      line.style.left = `${bounds.x + bounds.width}px`;
      line.style.top = `${bounds.y + bounds.height + pad / 2}px`;
      el.appendChild(line);
    }
    try {
      const data = format === 'png' ? await toPng(el, options) : await toSvg(el, options);
      return { data, width, height };
    } finally {
      line?.remove();
      canvas?.classList.remove('exporting');
    }
  };

  const exportImage = async (format: 'png' | 'svg') => {
    if (!network) return;
    try {
      const image = await renderMap(format, true);
      if (!image) return;
      const safe = network.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'network';
      const view = prefs.clients ? 'topology' : 'infrastructure';
      const path = await window.api.map.saveImage(image.data, `${safe}-${view}-${new Date().toISOString().slice(0, 10)}.${format}`);
      if (path) toast('success', `Saved the map to ${path}`);
    } catch (err) {
      toast('error', `Could not export the map: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /**
   * The map for the report: drawn in the requested view and the light theme (paper is white), then
   * the screen is put back as it was.
   */
  const captureMap = async (view: 'topology' | 'infrastructure'): Promise<MapCapture | undefined> => {
    const clients = view === 'topology';
    const before = prefs.clients;
    const root = document.documentElement;
    const theme = root.dataset.theme;
    const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
    try {
      if (clients !== before) {
        updatePrefs({ clients });
        // The new view is laid out over a few frames.
        for (let i = 0; i < 4; i++) await frame();
        await new Promise((r) => setTimeout(r, 300));
      }
      root.dataset.theme = 'light';
      await frame();
      await frame();
      const image = await renderMap('png', false);
      return image ? { dataUrl: image.data, width: image.width, height: image.height } : undefined;
    } finally {
      if (theme) root.dataset.theme = theme;
      else delete root.dataset.theme;
      if (clients !== before) updatePrefs({ clients: before });
    }
  };

  if (!network) {
    return (
      <div className="page">
        <EmptyState
          icon={Waypoints}
          title="No network to draw yet"
          action={
            <button className="btn primary" onClick={() => setView('discover')}>
              Go to Discover
            </button>
          }
        >
          Scan a network and its devices are drawn here as a map.
        </EmptyState>
      </div>
    );
  }

  const opened = openId ? assets[openId] : undefined;
  const openedConnection = openId ? connectionByAsset.get(openId) : undefined;
  /** Devices drawn under a node: its direct children, counting each device inside a group. */
  const devicesBehind = (id: string) =>
    fullTopo.edges
      .filter((e) => e.source === id)
      .reduce((sum, e) => sum + (fullIndex.byId.get(e.target)?.kind === 'group' ? (fullIndex.members.get(e.target) ?? 0) : 1), 0);
  /** A segment's own connection: the switch port it hangs from. */
  const segmentConnection = (n: MapNode): ConnectionRow | undefined => {
    const up = n.id.startsWith('segment:') ? fullTopo.edges.find((e) => e.target === n.id) : undefined;
    const above = up ? fullTopo.nodes.find((x) => x.id === up.source) : undefined;
    if (!up || !above) return undefined;
    return {
      id: n.id,
      device: facts(n),
      category: 'other',
      connectedTo: facts(above),
      switch: above.managed ? facts(above) : undefined,
      switchPort: up.sourcePort,
      vlan: up.vlan?.pvid,
      poeWatts: up.poeWatts,
      path: '',
      confirmed: !up.inferred,
    };
  };
  const otherNode = openNodeId ? (fullIndex.byId.get(openNodeId) ?? topo.nodes.find((n) => n.id === openNodeId)) : undefined;
  // What the device says about itself over SNMP or LLDP: its name and description (model, firmware).
  const openedNode = openId ? fullIndex.byAsset.get(openId) : undefined;
  const openedGear =
    openedNode && (openedNode.managed || openedNode.announced)
      ? { name: openedNode.label, description: openedNode.detail, type: openedNode.deviceType, source: gearSource(openedNode), gateways: openedNode.gateways }
      : undefined;
  const risky = members.filter((a) => a.risks.length).length;
  const mismatches = findLinkMismatches(gear?.devices ?? []);

  return (
    <div className={`map-page${sideHidden ? ' side-hidden' : ''}`}>
      {sideHidden ? null : (
        <aside className="map-side" aria-label="Map options">
          <div className="map-side-h">
            <div>
              <h1>Map</h1>
              <p className="muted">Drawn from the latest scans of a network.</p>
            </div>
            <button className="icon-btn" aria-label="Hide the side panel" title="Hide the side panel" onClick={() => setSideHidden(true)}>
              <PanelLeftClose className="icon" />
            </button>
          </div>

          <MapSection id="network" title="Network" open={sections} onToggle={toggleSection}>
            <select
              className="select"
              aria-label="Network"
              value={network.id}
              onChange={(e) => {
                setNetworkId(e.target.value);
                localStorage.setItem(NETWORK_KEY, e.target.value);
                closeDrawer();
              }}
            >
              {sorted.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.name}
                </option>
              ))}
            </select>
            <span className="muted map-meta">
              {members.length} devices{risky ? ` · ${risky} with risks` : ''} · {network.cidr}
            </span>
          </MapSection>

          {loops.map((loop) => {
            const nodeId = gearNodeId(loop.switchIp);
            return (
              <div key={loop.switchIp} className="map-loop" role="alert">
                <p>
                  <AlertTriangle className="icon" aria-hidden /> <b>Loop on {loop.switchName ?? loop.switchIp}:</b> {describeLoop(loop)}.
                </p>
                <p className="muted">
                  The switch may block one of these ports to protect the network, and devices behind it can lose their connection or never get an address. Unplug
                  one of the cables, then read the devices again.
                </p>
                {nodeId && (
                  <button className="btn sm" onClick={() => focusNode(nodeId)}>
                    Show the switch
                  </button>
                )}
              </div>
            );
          })}

          {mismatches.map((m) => {
            const nodeId = m.local.ip ? gearNodeId(m.local.ip) : undefined;
            return (
              <div key={`${m.kind}|${m.local.ip}|${m.local.port}`} className="map-loop" role="alert">
                <p>
                  <AlertTriangle className="icon" aria-hidden /> <b>{m.kind === 'nativeVlan' ? 'Native VLAN mismatch' : 'Duplex mismatch'}:</b> {describeMismatch(m)}.
                </p>
                <p className="muted">{mismatchAdvice(m.kind)}</p>
                {nodeId && (
                  <button className="btn sm" onClick={() => focusNode(nodeId)}>
                    Show on the map
                  </button>
                )}
              </div>
            );
          })}

          {unscanned.length > 0 && (
            <div className="map-unscanned">
              <p>
                <Search className="icon" aria-hidden /> <b>{unscanned.length === 1 ? 'A network was not scanned' : `${unscanned.length} networks were not scanned`}.</b> The devices read over SNMP are on{' '}
                {unscanned.length === 1 ? 'it' : 'them'}; scanning adds what is there to this map.
              </p>
              <ul>
                {unscanned.slice(0, 6).map((u) => (
                  <li key={u.cidr}>
                    <span>
                      <b>{u.cidr}</b>
                      <small>
                        {u.device}
                        {u.port ? ` ${u.port}` : ''}
                        {u.nextHop ? ` · way out via ${u.nextHop}` : ''}
                      </small>
                    </span>
                    <button className="btn sm" disabled={scanning} onClick={() => scanNetwork(u.cidr)}>
                      Scan
                    </button>
                  </li>
                ))}
              </ul>
              {scanning && <p className="muted">Scanning…</p>}
            </div>
          )}

          <MapSection
            id="snmp"
            title="SNMP community"
            count={gear?.devices.length || undefined}
            open={sections}
            onToggle={toggleSection}
          >
            {snmp.configured ? (
              <>
                <p className="map-hint" style={{ marginTop: 0 }}>
                  {gear ? (gear.devices.length ? `Read ${relativeTime(gear.collectedAt)}` : 'No device answered this community.') : 'Not read yet.'}
                </p>
                <div className="map-row">
                  <button className="btn sm primary" onClick={() => void readGear()} disabled={reading}>
                    <RefreshCw className={`icon${reading ? ' spin' : ''}`} /> {reading ? 'Reading…' : gear ? 'Read again' : 'Read devices'}
                  </button>
                  <button className="btn sm" onClick={() => setSetupOpen(true)}>
                    Change…
                  </button>
                </div>
                {gear?.devices.length ? (
                  <>
                    <label className="map-check">
                      <input type="checkbox" checked={prefs.live} onChange={(e) => updatePrefs({ live: e.target.checked })} /> Live traffic on links
                    </label>
                    <ul className="gear-list" aria-label="Devices read over SNMP">
                      {gear.devices.map((d) => {
                        const nodeId = gearNodeId(d.ip);
                        const ports = d.interfaces.filter((i) => isPhysicalPort(i.name));
                        const up = ports.filter((i) => i.up).length;
                        const role = gearRole(d, !!nodeId && topo.nodes.find((n) => n.id === nodeId)?.kind === 'gateway');
                        return (
                          <li key={d.ip}>
                            <button
                              className={`gear-row${focused === nodeId ? ' active' : ''}`}
                              onClick={() => nodeId && focusNode(nodeId)}
                              disabled={!nodeId}
                              title={d.sysDescr ? `${d.sysDescr}\nShow on the map` : 'Show on the map'}
                            >
                              <DeviceTile type={role.startsWith('Switch') ? 'switch' : 'router'} size="sm" as={d.forwarding ? 'routing' : undefined} />
                              <span className="gear-text">
                                <b>{d.sysName ?? d.ip}</b>
                                <span>
                                  {d.ip} · {role}
                                </span>
                                <span>
                                  {ports.length ? `${up}/${ports.length} ports up` : `${d.interfaces.filter((i) => i.up).length} interfaces up`}
                                  {d.poe?.usedW !== undefined ? ` · ${d.poe.usedW}${d.poe.budgetW ? `/${d.poe.budgetW}` : ''} W PoE` : ''}
                                </span>
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <p className="map-hint" style={{ marginTop: 0 }}>
                  Read the devices that answer SNMP (routers, switches, access points…) to draw the real links, ports and PoE.
                </p>
                <div className="map-row">
                  <button className="btn sm primary" onClick={() => setSetupOpen(true)}>
                    Set up SNMP community…
                  </button>
                </div>
              </>
            )}
          </MapSection>

          {topo.vlans?.length ? (
            <MapSection id="vlans" title="VLANs" count={topo.vlans.length} open={sections} onToggle={toggleSection}>
              <ul className="vlan-list" aria-label="VLANs">
                <li>
                  <button className={`vlan-row${vlanFilter === undefined ? ' active' : ''}`} onClick={() => setVlanFilter(undefined)}>
                    <i className="vlan-swatch all" />
                    <span className="vlan-text">
                      <b>All VLANs</b>
                    </span>
                  </button>
                </li>
                {topo.vlans.map((v) => {
                  const ports = (gear?.devices ?? []).reduce(
                    (n, d) => n + d.interfaces.filter((i) => isPhysicalPort(i.name) && (i.pvid === v.id || i.tagged?.includes(v.id))).length,
                    0,
                  );
                  // Counted over every device, not only those drawn in the current view.
                  const devices = connections.filter((r) => r.vlan === v.id).length;
                  return (
                    <li key={v.id}>
                      <button
                        className={`vlan-row${vlanFilter === v.id ? ' active' : ''}`}
                        aria-pressed={vlanFilter === v.id}
                        title={vlanFilter === v.id ? 'Show every VLAN' : `Show only VLAN ${v.id} on the map`}
                        onClick={() => setVlanFilter((f) => (f === v.id ? undefined : v.id))}
                      >
                        <i className="vlan-swatch" style={{ background: vlanColor(v.id) }} />
                        <span className="vlan-text">
                          <b>
                            VLAN {v.id}
                            {v.name && <span className="vlan-name"> · {v.name}</span>}
                          </b>
                          <span>
                            {ports} {ports === 1 ? 'port' : 'ports'} · {devices} {devices === 1 ? 'device' : 'devices'}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </MapSection>
          ) : null}

          <MapSection id="view" title="View" open={sections} onToggle={toggleSection}>
            <span className="seg map-seg" role="group" aria-label="Map view">
              <button aria-pressed={prefs.clients} onClick={() => updatePrefs({ clients: true })}>
                Topology
              </button>
              <button aria-pressed={!prefs.clients} onClick={() => updatePrefs({ clients: false })}>
                Infrastructure
              </button>
            </span>
            <p className="map-hint">{prefs.clients ? 'Every device, grouped by kind.' : 'Network gear only: gateway, firewalls, switches and access points.'}</p>
            <div className="map-sub">Labels</div>
            <div className="map-checks">
              <label className="map-check">
                <input type="checkbox" checked={prefs.ip} onChange={(e) => updatePrefs({ ip: e.target.checked })} /> IP address
              </label>
              <label className="map-check">
                <input type="checkbox" checked={prefs.vendor} onChange={(e) => updatePrefs({ vendor: e.target.checked })} /> Vendor
              </label>
            </div>
            {prefs.clients && (
              <>
                <div className="map-sub">Groups</div>
                <div className="map-row">
                  <button className="btn sm" onClick={() => updatePrefs({ collapsed: [] })} disabled={!prefs.collapsed.length}>
                    Expand all
                  </button>
                  <button className="btn sm" onClick={() => updatePrefs({ collapsed: topo.nodes.filter((n) => n.kind === 'group').map((n) => n.id) })}>
                    Collapse all
                  </button>
                </div>
              </>
            )}
          </MapSection>

          <MapSection id="arrange" title="Arrange & export" open={sections} onToggle={toggleSection}>
            <div className="map-row">
              <button className="btn sm" onClick={() => void fitView(FIT)}>
                <Maximize className="icon" /> Fit
              </button>
              <button className="btn sm" onClick={rearrange} disabled={!Object.keys(saved).length} title="Discard moved nodes and arrange the map again">
                <LayoutGrid className="icon" /> Re-arrange
              </button>
            </div>
            <div className="map-row" style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={() => void exportImage('png')}>
                <ImageDown className="icon" /> PNG
              </button>
              <button className="btn sm" onClick={() => void exportImage('svg')}>
                <ImageDown className="icon" /> SVG
              </button>
            </div>
            <div className="map-row" style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={() => setExportOpen(true)} title="A spreadsheet of every device and where it is plugged in">
                <FileSpreadsheet className="icon" /> Connections (CSV)
              </button>
            </div>
            <div className="map-row" style={{ marginTop: 6 }}>
              <button className="btn sm" onClick={() => setReportOpen(true)} title="A PDF for your client: findings, map and inventory, with your logo">
                <FileText className="icon" /> Site report (PDF)
              </button>
            </div>
          </MapSection>

        </aside>
      )}

      <div className="map-canvas" ref={canvasRef}>
        {sideHidden && (
          <button className="btn map-side-open" onClick={() => setSideHidden(false)} aria-label="Show the side panel" title="Show the side panel">
            <PanelLeftOpen className="icon" />
          </button>
        )}
        <MapSearch entries={searchIndex.entries} shifted={sideHidden} onPick={goToDevice} />
        <div className={`map-legend-float${sections.legend ? ' open' : ''}`}>
          <button
            className="map-legend-h"
            aria-expanded={!!sections.legend}
            aria-controls="map-legend-body"
            onClick={() => toggleSection('legend')}
            title={
              topo.confirmed
                ? 'Devices sit on the switch port where their address was learned. Devices no switch has seen stay with the gateway.'
                : 'Links are drawn from what each device is. Read the network devices over SNMP to draw the real cabling and ports.'
            }
          >
            {sections.legend ? <ChevronLeft className="icon" /> : <ChevronRight className="icon" />}
            <span>Legend</span>
          </button>
          {sections.legend && (
            <div className="map-legend" id="map-legend-body">
              <span title="A cable a switch reported">
                <i className="line" /> Switch link
              </span>
              <span title="Powered over Ethernet">
                <i className="line poe" /> PoE
              </span>
              {topo.vlans?.some((v) => v.id !== 1) && (
                <>
                  <span title="A port in one VLAN, drawn in that VLAN's colour">
                    <i className="line vlan" style={{ borderTopColor: vlanColor(topo.vlans.find((v) => v.id !== 1)?.id ?? 1) }} /> VLAN
                  </span>
                  <span title="A port carrying several VLANs">
                    <i className="line trunk" /> Trunk
                  </span>
                  <span title="Untagged (U) and tagged (T) VLANs on the port">
                    <code className="map-legend-tag">U1 T10</code> Untagged / tagged
                  </span>
                </>
              )}
              <span title="A link drawn from what each device is, not reported by a switch">
                <i className="line inferred" /> Assumed
              </span>
              {[...topo.edges, ...(topo.peers ?? [])].some((e) => e.tunnel) ? (
                <span title="A link that runs over a tunnel between two routers">
                  <i className="line tunnel" /> Tunnel
                </span>
              ) : null}
              {redundantShown.length ? (
                <span title="A link that closes a ring">
                  <i className="line redundant" /> Redundant
                </span>
              ) : null}
            </div>
          )}
        </div>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodesChange={onNodesChange}
          onNodeDragStart={startDrag}
          onNodeDragStop={onNodeDragStop}
          onMoveStart={startView}
          onMoveEnd={stopView}
          onNodeClick={(_, n) => {
            const d = n.data as Partial<DeviceData>;
            if (d.asset) {
              setOpenNodeId(undefined);
              setOpenId(d.asset.id);
            } else if (!d.network && (n.type === 'device' || n.type === 'member')) {
              setOpenId(undefined);
              setOpenNodeId(n.id);
            } else if (d.network) {
              // A separate network behind the gateway: open its own map when it has been scanned.
              const other = sorted.find((x) => x.cidr === d.network);
              if (other) {
                setNetworkId(other.id);
                localStorage.setItem(NETWORK_KEY, other.id);
              } else toast('error', `${d.network} has not been scanned yet. Scan it in Discover to draw its map.`);
            }
          }}
          onPaneClick={closeDrawer}
          nodesConnectable={false}
          edgesFocusable={false}
          colorMode={theme}
          minZoom={0.15}
          maxZoom={2}
          fitView
          fitViewOptions={FIT}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} />
          <Controls showInteractive={false} position="bottom-right" />
        </ReactFlow>
        {opened && <Detail asset={opened} gear={openedGear} connection={openedConnection} className="drawer" onClose={closeDrawer} />}
        {!opened && otherNode && (
          <NodeDetail
            facts={facts(otherNode)}
            gear={
              otherNode.managed || otherNode.announced
                ? { name: otherNode.label, description: otherNode.detail, type: otherNode.deviceType, source: gearSource(otherNode) }
                : otherNode.deviceType && otherNode.deviceType !== 'unknown'
                  ? { type: otherNode.deviceType, source: gearSource(otherNode) }
                  : undefined
            }
            connection={connections.find((r) => r.id === otherNode.id) ?? segmentConnection(otherNode)}
            behind={otherNode.id.startsWith('segment:') ? devicesBehind(otherNode.id) : undefined}
            note={nodeNote(otherNode)}
            onClose={closeDrawer}
          />
        )}
      </div>
      <ExportConnectionsDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        rows={connections}
        hasSwitchData={!!gear?.devices.length}
        fileBase={`${network.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'network'}-connections-${new Date().toISOString().slice(0, 10)}`}
      />
      <ReportDialog open={reportOpen} onOpenChange={setReportOpen} network={network} members={members} gear={gear} captureMap={captureMap} />
      <SnmpDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        configured={snmp.configured}
        onSave={async (community) => {
          setSnmp(await window.api.snmp.save(network.id, community));
          setSetupOpen(false);
          await readGear();
        }}
        onRemove={async () => {
          setSnmp(await window.api.snmp.clear(network.id));
          setSetupOpen(false);
        }}
      />
    </div>
  );
}

/** Where the facts about a map device came from: SNMP for managed gear, else the protocol it announced itself over. */
function gearSource(n: MapNode): 'snmp' | 'lldp' | 'cdp' {
  return n.managed ? 'snmp' : n.announcedVia === 'CDP' ? 'cdp' : 'lldp';
}

/** Where Meshwork learned about a device that is not in the inventory. */
function nodeNote(n: MapNode): string {
  if (n.kind === 'gateway') return "The network's gateway, taken from this computer's settings or the switches. Scan this network in Discover to add it to the inventory.";
  if (n.id.startsWith('segment:')) return 'Several devices were learned on one switch port with no managed device behind it: an unmanaged switch, a hub or an access point that does not answer SNMP.';
  if (n.managed) return 'Read over SNMP. Scan this network in Discover to add it to the inventory.';
  if (n.id.startsWith('lldp:')) return `It announced itself to a switch over ${n.announcedVia ?? 'LLDP'} but did not answer the scan. Scan this network in Discover to add it to the inventory.`;
  if (n.id.startsWith('mac:')) return 'A switch learned its MAC address on this port, but it did not answer the scan: it may be off, asleep, firewalled or on another subnet.';
  return 'Drawn from what the switches report. Scan this network in Discover to add it to the inventory.';
}

/** How the community is protected at rest, in the terms of each operating system. */
function protectionNote(platform?: string): string {
  if (platform === 'darwin') return 'The community is stored encrypted with your Mac’s Keychain.';
  if (platform === 'win32') return 'The community is stored encrypted with Windows data protection, tied to your user account.';
  return 'The community is stored encrypted with your system’s keyring.';
}

/** Asks for the network's SNMP v2c read community. */
function SnmpDialog({
  open,
  onOpenChange,
  configured,
  onSave,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  configured: boolean;
  onSave: (community: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const platform = useStore((s) => s.info?.platform);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setValue('');
      setError(undefined);
    }
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(value);
    } catch (err) {
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog">
          <Dialog.Title asChild>
            <h2>SNMP community</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p>
              Enter the read-only SNMP v2c community of this network's devices: routers, switches, access points or anything else that
              offers SNMP. Meshwork only reads: interfaces, neighbours (LLDP and CDP), routes, the addresses learned on each port and PoE. {protectionNote(platform)}
            </p>
          </Dialog.Description>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label className="input" style={{ marginTop: 6 }}>
              <input
                type="password"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={configured ? 'New community' : 'Community'}
                aria-label="SNMP community string"
                aria-invalid={!!error}
              />
            </label>
            {error && (
              <p role="alert" style={{ color: 'var(--danger-text)', fontSize: 12.5, margin: '8px 0 0' }}>
                {error}
              </p>
            )}
            <div className="row">
              {configured && (
                <button type="button" className="btn" style={{ marginRight: 'auto' }} onClick={() => void onRemove()}>
                  Remove
                </button>
              )}
              <Dialog.Close asChild>
                <button type="button" className="btn">
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="btn primary" disabled={!value.trim() || busy}>
                {busy ? 'Reading…' : 'Save and read'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function MapView() {
  return (
    <ReactFlowProvider>
      <MapCanvas />
    </ReactFlowProvider>
  );
}
