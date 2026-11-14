/**
 * Network map model: turns one network's inventory into a tree (internet → gateway → network
 * gear → devices) and lays it out top-down. Without switch data, links are assumed from device
 * roles. With a reading of the network's managed switches (LLDP neighbours, learned MAC addresses,
 * PoE), links follow the real ports and each device is placed on the port where it was learned.
 */
import { announcedType } from '@shared/fingerprint';
import { isVirtualMac } from '@shared/model';
import { inCidr } from '@shared/report';
import type { Asset, DeviceType, GearDevice, GearFdbEntry, GearInterface, GearSnapshot, LldpCapability, Network } from '@shared/types';

export type MapNodeKind = 'internet' | 'gateway' | 'device' | 'group';
export type Category = 'computers' | 'phones' | 'printers' | 'cameras' | 'media' | 'iot' | 'other';

export interface MapNode {
  id: string;
  kind: MapNodeKind;
  /** Inventory asset drawn by this node. */
  assetId?: string;
  /** Group that contains this device; contained devices have no links of their own. */
  parent?: string;
  /** Address shown when the node is not an inventory asset. */
  ip?: string;
  /** Name and detail for nodes that are not inventory assets (LLDP neighbours, segments). */
  label?: string;
  detail?: string;
  /** Device type for nodes that are not inventory assets. */
  deviceType?: DeviceType;
  /** True for devices read over SNMP. */
  managed?: boolean;
  /** True when `label` is the name the device announced itself (LLDP), which beats a vendor-based name. */
  announced?: boolean;
  /** For a separate network behind the gateway: its address range (CIDR). */
  network?: string;
  category?: Category;
  /** Devices in a group, shown on the group node (also when it is collapsed). */
  count?: number;
  /** Title of a group of same-kind devices (e.g. "Access points"); category groups use the category's name. */
  title?: string;
  collapsed?: boolean;
  /** Switch port a contained device was learned on. */
  port?: string;
  /** Power delivered to a contained device over its port. */
  poe?: boolean;
  poeWatts?: number;
  /** VLAN the device was seen on by a switch. */
  vlan?: number;
  /** VLANs tagged on the device's switch port, for a device banked into a group (often a trunk to an access point). */
  tagged?: number[];
  /** For a device banked into a group: true when its own link was only assumed, not seen by a switch. */
  inferred?: boolean;
  /** Switch port whose counters measure this contained device's traffic. */
  traffic?: { ip: string; ifIndex: number };
  /** Reached through an access point, usually over Wi-Fi: no switch port measures its own traffic. */
  wireless?: boolean;
}

export interface MapEdge {
  id: string;
  source: string;
  target: string;
  /** True when the link is assumed from device roles rather than seen in switch data. */
  inferred: boolean;
  /** Port names at each end, when known. */
  sourcePort?: string;
  /** Every port behind a group's cable, when `sourcePort` shows only the first. */
  sourcePortsAll?: string;
  targetPort?: string;
  speedMbps?: number;
  poe?: boolean;
  poeWatts?: number;
  /** Switch port whose counters measure the traffic on this link. */
  traffic?: { ip: string; ifIndex: number };
  /** For a cable to a group: the ports of the devices inside it; their traffic adds up on the cable. */
  trafficPorts?: { ip: string; ifIndex: number }[];
  /** VLANs on that switch port: untagged (PVID) and tagged. */
  vlan?: { pvid?: number; tagged?: number[] };
  /**
   * For a redundant link: blocked when spanning tree blocks a port on it in the default instance.
   * Absent otherwise: other instances (per VLAN, multiple) are not visible, so no port reading
   * blocked does not prove the ring is open.
   */
  stp?: 'blocked';
  /** The node and port spanning tree blocks on a redundant link. */
  blockedPort?: { node: string; port: string };
}

export interface Topology {
  nodes: MapNode[];
  edges: MapEdge[];
  /** True when the links come from switch data. */
  confirmed: boolean;
  /** VLANs configured on the managed devices, by id. */
  vlans?: { id: number; name?: string }[];
  /**
   * Cables between gear that is already joined another way: each closes a ring. Spanning tree
   * normally blocks one port on each. Drawn apart from the tree: they take no part in its node
   * layout, paths or groups.
   */
  redundant?: MapEdge[];
}

export const INTERNET_ID = 'internet';
export const GATEWAY_ID = 'gateway';

/** Network gear drawn on its own under the gateway; everything else is grouped by category. */
const INFRASTRUCTURE: DeviceType[] = ['router', 'firewall', 'switch', 'ap'];
const INFRA_ORDER: Record<string, number> = { firewall: 0, router: 1, switch: 2, ap: 3 };

export const CATEGORIES: { id: Category; label: string; types: DeviceType[] }[] = [
  { id: 'computers', label: 'Computers & servers', types: ['computer', 'laptop', 'server', 'vm', 'storage'] },
  { id: 'phones', label: 'Phones & tablets', types: ['phone', 'tablet'] },
  { id: 'printers', label: 'Printers', types: ['printer'] },
  { id: 'cameras', label: 'Cameras', types: ['camera'] },
  { id: 'media', label: 'TV & media', types: ['tv'] },
  { id: 'iot', label: 'Smart devices', types: ['iot'] },
  { id: 'other', label: 'Unidentified', types: ['unknown'] },
];

export function categoryOf(type: DeviceType): Category {
  return CATEGORIES.find((c) => c.types.includes(type))?.id ?? 'other';
}

/** Id of a device group; groups under a node other than the gateway carry that node's id. */
export function groupId(category: Category, parent?: string): string {
  return parent ? `group:${parent}:${category}` : `group:${category}`;
}

/** Numeric sort key for IPv4 addresses; other strings sort after them. */
export function ipKey(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return Number.MAX_SAFE_INTEGER;
  return (parts[0] as number) * 256 ** 3 + (parts[1] as number) * 65536 + (parts[2] as number) * 256 + (parts[3] as number);
}

const byIp = (a: Asset, b: Asset) => ipKey(a.ip) - ipKey(b.ip);

/** Network address of `ip` with a prefix length, as CIDR text. */
export function cidrOf(ip: string, prefix: number): string {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  const n = (ipKey(ip) & mask) >>> 0;
  return `${[n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')}/${prefix}`;
}

/** Addresses that are not routed on the internet: private, shared (CGNAT), loopback, link-local. */
export function isPrivateIp(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
}
const lower = (mac?: string) => mac?.toLowerCase();
const looksLikeMac = (s?: string) => !!s && /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(s);

/**
 * The network's gateway in the inventory: matched by the router's MAC address, then by its IP,
 * then the lowest-addressed router or firewall.
 */
export function findGateway(network: Pick<Network, 'gatewayMac' | 'gatewayIp'>, assets: Asset[]): Asset | undefined {
  const mac = lower(network.gatewayMac);
  return (
    (mac ? assets.find((a) => lower(a.mac) === mac) : undefined) ??
    (network.gatewayIp ? assets.find((a) => a.ip === network.gatewayIp) : undefined) ??
    assets.filter((a) => a.type === 'router' || a.type === 'firewall').sort(byIp)[0]
  );
}

export interface TopologyOptions {
  /** Include end devices (in groups); false draws network gear only. */
  clients: boolean;
  /** Group ids whose devices are hidden. */
  collapsed: ReadonlySet<string>;
}

/**
 * What a managed device is, as listed beside the map. A device that switches frames (bridge ports
 * or learned addresses) is a switch, a layer 3 one when it also routes; a device that only routes
 * is a router. Per-VLAN MAC tables some switches publish only under VLAN-specific credentials can
 * read empty, so bridge ports count on their own.
 */
export function gearRole(d: Pick<GearDevice, 'forwarding' | 'fdb' | 'bridgePorts'>, isGateway: boolean): 'Gateway' | 'Router' | 'Switch (L3)' | 'Switch' {
  if (isGateway) return 'Gateway';
  const switches = !!d.bridgePorts || d.fdb.length > 0;
  if (d.forwarding) return switches ? 'Switch (L3)' : 'Router';
  return 'Switch';
}

const PHYSICAL_PORT = /^(gi|fa|te|xe|ge|et|eth|port|mvneta|igc|igb|em|ix|en|lan|wan)[\w/.-]*\d$|^(Port|GigabitEthernet|FastEthernet|TenGigabitEthernet)\s?[\d/]+$|^\d+\/\d+\/\d+$/i;

/**
 * True for a physical port name: the usual prefixes ("gi24", "igc0", "Ethernet0/3"), and
 * member/slot/port numbers ("1/1/28"). VLAN subinterfaces ("igc0.10", "Gi0/0.20") are not ports.
 */
export function isPhysicalPort(name: string): boolean {
  return PHYSICAL_PORT.test(name) && !/\.\d+$/.test(name);
}

const ipNum = (ip: string) => ip.split('.').reduce((n, p) => n * 256 + (Number(p) || 0), 0);

/**
 * The network's gateway according to its managed devices: the next hop of their default routes.
 * Layer 3 switches vote too, since they commonly point at the firewall or router. A next hop that
 * is one of the managed devices wins over one that is not (the gateway's own upstream, outside the
 * network), then the most votes, then the lowest address, so the answer does not depend on the
 * order the devices answered in. A next hop outside the scanned networks (`cidrs`, comma-separated)
 * is a router's own upstream (its internet provider), not this network's gateway, and is ignored.
 * Without default routes: the lowest-addressed routing device.
 */
export function gatewayFromGear(devices: GearDevice[], cidrs?: string): string | undefined {
  const ranges = (cidrs ?? '').split(',').map((c) => c.trim()).filter(Boolean);
  const addressesOf = (d: GearDevice) => [d.ip, ...(d.addresses ?? []).map((a) => a.ip)];
  const known = new Set(devices.flatMap(addressesOf));
  const votes = new Map<string, number>();
  for (const d of devices) {
    const hop = d.defaultRoute?.nextHop;
    if (!hop || hop === '0.0.0.0' || addressesOf(d).includes(hop)) continue;
    if (ranges.length && !ranges.some((r) => inCidr(hop, r))) continue;
    votes.set(hop, (votes.get(hop) ?? 0) + 1);
  }
  const best = [...votes].sort((a, b) => Number(known.has(b[0])) - Number(known.has(a[0])) || b[1] - a[1] || ipNum(a[0]) - ipNum(b[0]))[0]?.[0];
  return best ?? devices.filter((d) => d.forwarding).sort((a, b) => ipNum(a.ip) - ipNum(b.ip))[0]?.ip;
}

/** VLAN number of a router subinterface named like "igc1.60", "eth0.100" or "vlan20". */
export function vlanOfInterface(name?: string): number | undefined {
  const m = name ? /(?:\.|^vlan)(\d{1,4})$/i.exec(name) : null;
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 4094 ? n : undefined;
}

/** Interface names of VPN and other tunnels. */
const TUNNEL = /^(tun|tap|wg|ovpn|ipsec|enc|gif|gre|tailscale|zt|ppp|l2tp)/i;

/** Device type of an LLDP neighbour that is not in the inventory, from its name and description. */
export function neighbourType(sysName?: string, sysDescr?: string, capabilities?: LldpCapability[]): DeviceType {
  const named = announcedType(sysName, sysDescr);
  if (!capabilities?.length) return named;
  // What a device declares over LLDP is reliable for phones and access points (both often also
  // announce "bridge" for their built-in switch); a recognised network role is kept, so a firewall
  // or router never becomes a switch.
  if (capabilities.includes('telephone')) return 'phone';
  if (capabilities.includes('wlanAccessPoint')) return 'ap';
  if (['router', 'firewall', 'ap', 'phone', 'switch'].includes(named)) return named;
  if (capabilities.includes('bridge')) return 'switch';
  if (capabilities.includes('router')) return 'router';
  return named;
}

class Builder {
  nodes: MapNode[] = [];
  edges: MapEdge[] = [];
  private ids = new Set<string>();

  constructor(private options: TopologyOptions) {}

  node(n: MapNode) {
    if (this.ids.has(n.id)) return;
    this.ids.add(n.id);
    this.nodes.push(n);
  }

  has(id: string) {
    return this.ids.has(id);
  }

  link(e: Omit<MapEdge, 'id'>) {
    this.edges.push({ id: `${e.source}->${e.target}`, ...e });
  }

  /** Adds `members` under `parent` as category groups (containers). */
  groups(parent: string, members: Member[], inferred: boolean, scoped: boolean) {
    if (!this.options.clients || !members.length) return;
    for (const c of CATEGORIES) {
      const list = members
        .filter((m) => categoryOf(m.type) === c.id)
        .sort((x, y) => ipKey(x.ip ?? '') - ipKey(y.ip ?? '') || x.id.localeCompare(y.id));
      if (!list.length) continue;
      const id = groupId(c.id, scoped ? parent : undefined);
      const collapsed = this.options.collapsed.has(id);
      this.node({ id, kind: 'group', category: c.id, count: list.length, collapsed });
      // The cable to a group on a switch names the switch ports its devices are on.
      const ports = list.map((m) => m.node.port).filter((x): x is string => !!x);
      const measured = list.map((m) => m.node.traffic).filter((t): t is { ip: string; ifIndex: number } => !!t);
      this.link({
        source: parent,
        target: id,
        inferred,
        sourcePort: ports.length ? summarizePorts(ports, 2) : undefined,
        sourcePortsAll: ports.length > 2 ? summarizePorts(ports, Infinity) : undefined,
        trafficPorts: measured.length ? measured : undefined,
      });
      if (collapsed) continue;
      for (const m of list) this.node({ id: m.id, kind: 'device', category: c.id, parent: id, ...m.node });
    }
  }
}

/** Usual short forms of long interface names ("gigabitEthernet 1/0/43" → "Gi1/0/43"). */
const PORT_SHORT: [RegExp, string][] = [
  [/\bhundredgig(?:abit)?e(?:thernet)?\s*/gi, 'Hu'],
  [/\bfortygig(?:abit)?e(?:thernet)?\s*/gi, 'Fo'],
  [/\btwentyfivegig(?:abit)?e(?:thernet)?\s*/gi, 'Twe'],
  [/\bten-?gig(?:abit)?e(?:thernet)?\s*/gi, 'Te'],
  [/\bgigabit-?ethernet\s*/gi, 'Gi'],
  [/\bfast-?ethernet\s*/gi, 'Fa'],
  [/\bport-?channel\s*/gi, 'Po'],
  [/\bethernet\s*(?=\d)/gi, 'Eth'],
];

export function shortPort(name: string): string {
  return PORT_SHORT.reduce((s, [re, short]) => s.replace(re, short), name);
}

/** Splits a port name into its text and trailing number, e.g. "gi15" → ["gi", 15]. */
function portParts(name: string): [string, number] | undefined {
  const m = /^(.*?)(\d+)$/.exec(name);
  return m ? [m[1] as string, Number(m[2])] : undefined;
}

/**
 * A short list of port names: consecutive ports joined into ranges ("gi13–gi15"), in natural
 * order, and anything beyond the first few counted ("+3").
 */
export function summarizePorts(names: string[], max = 4): string {
  const unique = [...new Set(names)].sort((a, b) => {
    const pa = portParts(a);
    const pb = portParts(b);
    if (pa && pb && pa[0] === pb[0]) return pa[1] - pb[1];
    return a.localeCompare(b);
  });
  const parts: string[] = [];
  for (let i = 0; i < unique.length; i++) {
    const start = unique[i] as string;
    let end = start;
    const sp = portParts(start);
    while (sp && i + 1 < unique.length) {
      const np = portParts(unique[i + 1] as string);
      const ep = portParts(end);
      if (!np || !ep || np[0] !== sp[0] || np[1] !== ep[1] + 1) break;
      end = unique[++i] as string;
    }
    parts.push(end === start ? start : `${start}–${end}`);
  }
  return parts.length > max ? `${parts.slice(0, max).join(', ')} +${parts.length - max}` : parts.join(', ');
}

/** A device to place in a group: an inventory asset, or an address a switch learned. */
interface Member {
  id: string;
  type: DeviceType;
  ip?: string;
  node: Partial<MapNode>;
}

const assetMember = (a: Asset, extra: Partial<MapNode> = {}): Member => ({ id: a.id, type: a.type, ip: a.ip, node: { assetId: a.id, ...extra } });

/** Locally administered addresses: randomised (private) Wi-Fi addresses of phones and laptops. */
/** What a list of connections says about one node: its name and addresses. */
export interface NodeFacts {
  name: string;
  ip?: string;
  mac?: string;
  vendor?: string;
  type?: DeviceType;
}

/** One device and where it is plugged in, for the connections list. */
export interface ConnectionRow {
  id: string;
  device: NodeFacts;
  category: Category;
  /** Node it hangs from on the map: a switch, an access point, an unmanaged segment or the gateway. */
  connectedTo?: NodeFacts;
  /** First switch or router on the way to the gateway that knows the device's port, and that port. */
  switch?: NodeFacts;
  switchPort?: string;
  vlan?: number;
  poeWatts?: number;
  /** Every hop up to the gateway: "Lobby AP › SG300 gi24 › Gateway igc1". */
  path: string;
  /** True when a switch saw the device on that port; false when the link is only assumed. */
  confirmed: boolean;
}

const NON_DEVICE = (n: MapNode) => n.kind === 'internet' || n.kind === 'group' || n.id.startsWith('segment:');

/**
 * Where each device is connected, from a topology drawn with every device shown and no group
 * folded. `facts` names a node the way the map does.
 */
export function connectionRows(topo: Topology, facts: (n: MapNode) => NodeFacts): ConnectionRow[] {
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));
  const upEdge = new Map<string, MapEdge>();
  for (const e of topo.edges) if (!upEdge.has(e.target)) upEdge.set(e.target, e);
  const nameOf = (n: MapNode) => (n.id.startsWith('segment:') ? 'Unmanaged switch or AP' : facts(n).name);

  const rows: ConnectionRow[] = [];
  for (const n of topo.nodes) {
    if (NON_DEVICE(n) || n.kind === 'gateway') continue;
    // The first hop: the node above the device's group, or above the device itself.
    const first = upEdge.get(n.parent ?? n.id);
    if (!first) continue;
    const hops: { node: MapNode; port?: string }[] = [];
    const above = byId.get(first.source);
    // A contained device's port is the managed switch's, so it belongs to the first hop only when
    // that hop is the switch itself (not an access point or segment behind it).
    let port = n.parent ? (above?.managed ? n.port : undefined) : first.sourcePort;
    // A device banked into a group keeps its own answer: the group's cable is confirmed if any member's was.
    let confirmed = !first.inferred && !n.inferred;
    let at = above;
    const seen = new Set<string>([n.id]);
    while (at && !seen.has(at.id) && at.kind !== 'internet') {
      seen.add(at.id);
      hops.push({ node: at, port });
      const up = upEdge.get(at.id);
      if (!up) break;
      port = up.sourcePort;
      confirmed &&= !up.inferred || byId.get(up.source)?.kind === 'internet';
      at = byId.get(up.source);
    }
    // The first device read over SNMP on the way up; else the first hop whose port is known (a
    // router that announces itself over LLDP without answering SNMP).
    const sw = hops.find((h) => h.node.managed) ?? hops.find((h) => h.port);
    // A device behind an access point or segment was seen on the switch port that leads to it.
    const switchPort = sw ? (sw.port ?? (n.parent ? n.port : undefined)) : undefined;
    rows.push({
      id: n.id,
      device: facts(n),
      category: n.category ?? categoryOf(n.deviceType ?? facts(n).type ?? 'unknown'),
      connectedTo: hops[0] ? { ...facts(hops[0].node), name: nameOf(hops[0].node) } : undefined,
      switch: sw ? facts(sw.node) : undefined,
      switchPort,
      vlan: n.vlan ?? (n.parent ? undefined : first.vlan?.pvid),
      poeWatts: n.poeWatts ?? (n.parent ? undefined : first.poeWatts),
      path: hops.map((h) => [nameOf(h.node), h.port].filter(Boolean).join(' ')).join(' › '),
      confirmed,
    });
  }
  return rows.sort((x, y) => ipKey(x.device.ip ?? '') - ipKey(y.device.ip ?? '') || x.device.name.localeCompare(y.device.name));
}

/** The connections list as spreadsheet columns. */
export const CONNECTION_COLUMNS = ['Name', 'IP address', 'MAC address', 'Vendor', 'Kind', 'Connected to', 'Connected to IP', 'Switch', 'Switch IP', 'Switch port', 'VLAN', 'PoE (W)', 'Path to gateway', 'Source'];

/** Spreadsheet cells; a connection no switch has seen is left blank rather than guessed. */
export function connectionCells(r: ConnectionRow): string[] {
  const c = r.confirmed;
  return [
    r.device.name,
    r.device.ip ?? '',
    r.device.mac ?? '',
    r.device.vendor ?? '',
    CATEGORIES.find((c) => c.id === r.category)?.label ?? '',
    c ? (r.connectedTo?.name ?? '') : '',
    c ? (r.connectedTo?.ip ?? '') : '',
    c ? (r.switch?.name ?? '') : '',
    c ? (r.switch?.ip ?? '') : '',
    c ? (r.switchPort ?? '') : '',
    r.vlan !== undefined ? String(r.vlan) : '',
    r.poeWatts !== undefined ? r.poeWatts.toFixed(1) : '',
    c ? r.path : '',
    c ? 'Switch data' : 'Not known (no switch data)',
  ];
}

/** A device on the map as the search box sees it. */
export interface MapSearchEntry {
  id: string;
  name: string;
  ip?: string;
  mac?: string;
  vendor?: string;
  /** Where it is plugged in, e.g. "Gi1/0/12". */
  port?: string;
}

const hexOnly = (s: string) => s.toLowerCase().replace(/[^0-9a-f]/g, '');

/**
 * Devices matching a typed name, IP address, MAC address (any separator: aa:bb, aa-bb, aabb.cc) or
 * vendor. Exact address matches come first, then those starting with the text, then the rest.
 */
export function searchMap(entries: MapSearchEntry[], query: string, limit = 8): MapSearchEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const qHex = hexOnly(q);
  // Text made only of hex digits and MAC separators, long enough to be part of an address.
  const macLike = qHex.length >= 4 && /^[0-9a-f:.\-\s]+$/.test(q);
  const score = (e: MapSearchEntry): number => {
    const mac = e.mac ? hexOnly(e.mac) : '';
    const ip = e.ip ?? '';
    if (ip === q || (macLike && mac === qHex)) return 0;
    if (ip.startsWith(q) || (macLike && mac.startsWith(qHex))) return 1;
    if (e.name.toLowerCase().startsWith(q)) return 2;
    if (ip.includes(q) || (macLike && mac.includes(qHex))) return 3;
    if (e.name.toLowerCase().includes(q) || e.vendor?.toLowerCase().includes(q) || e.port?.toLowerCase() === q) return 4;
    return -1;
  };
  return entries
    .map((e) => ({ e, s: score(e) }))
    .filter((x) => x.s >= 0)
    .sort((x, y) => x.s - y.s || x.e.name.localeCompare(y.e.name))
    .slice(0, limit)
    .map((x) => x.e);
}

export function isPrivateMac(mac: string): boolean {
  return (parseInt(mac.slice(0, 2), 16) & 0x02) !== 0;
}

export function buildTopology(
  network: Pick<Network, 'gatewayMac' | 'gatewayIp'> & Partial<Pick<Network, 'cidr'>>,
  assets: Asset[],
  options: TopologyOptions,
  gear?: GearSnapshot | null,
): Topology {
  const b = new Builder(options);
  b.node({ id: INTERNET_ID, kind: 'internet' });
  // A scan of a remote network does not know its gateway; managed devices do.
  if (!network.gatewayIp && gear?.devices.length) network = { ...network, gatewayIp: gatewayFromGear(gear.devices, network.cidr) };
  const gateway = findGateway(network, assets);
  const gatewayNode = gateway?.id ?? GATEWAY_ID;
  b.node(gateway ? { id: gateway.id, kind: 'gateway', assetId: gateway.id } : { id: GATEWAY_ID, kind: 'gateway', ip: network.gatewayIp });
  b.link({ source: INTERNET_ID, target: gatewayNode, inferred: true });

  const rest = assets.filter((a) => a.id !== gateway?.id);
  const assetById = new Map(assets.map((a) => [a.id, a]));
  const typeOf = (n: MapNode): DeviceType => {
    const a = n.assetId ? assetById.get(n.assetId) : undefined;
    return n.announced && n.deviceType && n.deviceType !== 'unknown' ? n.deviceType : a && a.type !== 'unknown' ? a.type : (n.deviceType ?? 'unknown');
  };
  if (gear?.devices.length) return bankSiblings(withGear(b, gear.devices, network, gateway, gatewayNode, rest), typeOf, options.collapsed);

  const gearAssets = rest
    .filter((a) => INFRASTRUCTURE.includes(a.type))
    .sort((x, y) => (INFRA_ORDER[x.type] ?? 9) - (INFRA_ORDER[y.type] ?? 9) || byIp(x, y));
  for (const a of gearAssets) {
    b.node({ id: a.id, kind: 'device', assetId: a.id });
    b.link({ source: gatewayNode, target: a.id, inferred: true });
  }
  b.groups(
    gatewayNode,
    rest.filter((a) => !INFRASTRUCTURE.includes(a.type)).map((a) => assetMember(a)),
    true,
    false,
  );
  return bankSiblings({ nodes: b.nodes, edges: b.edges, confirmed: false }, typeOf, options.collapsed);
}

/** Same-kind devices hanging from one node are banked into a group from this many on. */
export const BANK_MIN = 3;

const BANK_TITLE: Partial<Record<DeviceType, string>> = {
  ap: 'Access points',
  switch: 'Switches',
  router: 'Routers',
  firewall: 'Firewalls',
  printer: 'Printers',
  camera: 'Cameras',
  phone: 'Phones',
  server: 'Servers',
  storage: 'Storage',
  computer: 'Computers',
  laptop: 'Laptops',
  tv: 'TV & media',
  iot: 'Smart devices',
};
const bankTitle = (t: DeviceType) => BANK_TITLE[t] ?? (t === 'unknown' ? 'Other devices' : `${t[0]?.toUpperCase()}${t.slice(1)}s`);

/**
 * Groups same-kind devices that hang from the same node and have nothing below them (eight access
 * points on one switch, for example) into one container, so the map does not draw a row of parallel
 * cables. Each device keeps its own switch port, PoE and VLAN on its card; the group's cable names
 * every port. Devices read over SNMP, segments and separate networks stay on their own.
 */
export function bankSiblings(t: Topology, typeOf: (n: MapNode) => DeviceType, collapsed: ReadonlySet<string> = new Set()): Topology {
  // Gear on a redundant link stays a card of its own, so that link has both ends to draw between.
  const hasKids = new Set([...t.edges.map((e) => e.source), ...(t.redundant ?? []).flatMap((e) => [e.source, e.target])]);
  const byId = new Map(t.nodes.map((n) => [n.id, n]));
  const bankable = (n: MapNode | undefined): n is MapNode =>
    !!n && n.kind === 'device' && !n.parent && !n.managed && !n.network && !n.id.startsWith('segment:') && !hasKids.has(n.id);
  const sets = new Map<string, { parent: string; type: DeviceType; edges: MapEdge[] }>();
  for (const e of t.edges) {
    const n = byId.get(e.target);
    if (!bankable(n)) continue;
    const type = typeOf(n);
    const key = `${e.source}|${type}`;
    const set = sets.get(key) ?? { parent: e.source, type, edges: [] };
    set.edges.push(e);
    sets.set(key, set);
  }
  const drop = new Set<string>();
  const hidden = new Set<string>();
  const nodes = t.nodes.map((n) => ({ ...n }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const added: { node: MapNode; edge: MapEdge }[] = [];
  for (const { parent, type, edges } of sets.values()) {
    if (edges.length < BANK_MIN) continue;
    const id = `bank:${parent}:${type}`;
    const isCollapsed = collapsed.has(id);
    const ports: string[] = [];
    for (const e of edges) {
      drop.add(e.id);
      const m = nodeById.get(e.target) as MapNode;
      if (isCollapsed) hidden.add(m.id);
      Object.assign(m, {
        parent: id,
        port: m.port ?? e.sourcePort,
        poe: m.poe ?? e.poe,
        poeWatts: m.poeWatts ?? e.poeWatts,
        vlan: m.vlan ?? e.vlan?.pvid,
        tagged: e.vlan?.tagged?.length ? e.vlan.tagged : undefined,
        inferred: e.inferred || undefined,
        traffic: m.traffic ?? e.traffic,
      });
      if (e.sourcePort) ports.push(e.sourcePort);
    }
    // The group's cable carries every VLAN of its members: their common untagged one, the rest tagged.
    const pvids = new Set(edges.map((e) => e.vlan?.pvid).filter((v): v is number => v !== undefined));
    const pvid = pvids.size === 1 ? [...pvids][0] : undefined;
    const tagged = [...new Set([...pvids, ...edges.flatMap((e) => e.vlan?.tagged ?? [])])].filter((v) => v !== pvid).sort((a, b) => a - b);
    const vlan = pvid !== undefined || tagged.length ? { pvid, tagged: tagged.length ? tagged : undefined } : undefined;
    added.push({
      node: { id, kind: 'group', category: categoryOf(type), title: bankTitle(type), count: edges.length, collapsed: isCollapsed },
      edge: {
        id: `${parent}->${id}`,
        source: parent,
        target: id,
        inferred: edges.every((e) => e.inferred),
        sourcePort: ports.length ? summarizePorts(ports, 2) : undefined,
        sourcePortsAll: ports.length > 2 ? summarizePorts(ports, Infinity) : undefined,
        poe: edges.some((e) => e.poe) || undefined,
        vlan,
        trafficPorts: edges.flatMap((e) => (e.traffic ? [e.traffic] : [])),
      },
    });
  }
  if (!added.length) return t;
  // Members follow their group in the node list, as the canvas expects parents before children.
  const out: MapNode[] = [];
  const membersOf = new Map<string, MapNode[]>();
  for (const n of nodes) if (n.parent?.startsWith('bank:')) membersOf.set(n.parent, [...(membersOf.get(n.parent) ?? []), n]);
  for (const n of nodes) if (!n.parent?.startsWith('bank:')) out.push(n);
  for (const { node } of added) {
    out.push(node);
    if (!node.collapsed) out.push(...(membersOf.get(node.id) ?? []).filter((m) => !hidden.has(m.id)));
  }
  return { ...t, nodes: out, edges: [...t.edges.filter((e) => !drop.has(e.id)), ...added.map((a) => a.edge)] };
}

/** Topology from managed switches: LLDP links between gear, and devices placed by learned MAC. */
function withGear(
  b: Builder,
  devices: GearDevice[],
  network: Pick<Network, 'gatewayMac' | 'gatewayIp'>,
  gateway: Asset | undefined,
  gatewayNode: string,
  rest: Asset[],
): Topology {
  // Switches' own ARP tables fill in addresses the inventory lacks (when the OS hides them).
  const arpMac = new Map<string, string>();
  for (const d of devices) for (const e of d.arp ?? []) if (!arpMac.has(e.ip)) arpMac.set(e.ip, e.mac);
  const macOfAsset = (a: Asset) => lower(a.mac) ?? arpMac.get(a.ip);
  const ipOfMac = new Map([...arpMac].map(([ip, mac]) => [mac, ip]));
  const byMac = new Map<string, Asset>();
  const byIpAddr = new Map<string, Asset>();
  for (const a of rest) {
    const mac = macOfAsset(a);
    if (mac) byMac.set(mac, a);
    byIpAddr.set(a.ip, a);
  }
  const placed = new Set<string>();
  const iface = (d: GearDevice, ifIndex?: number): GearInterface | undefined => d.interfaces.find((i) => i.ifIndex === ifIndex);

  // Managed devices. The gateway may answer SNMP too: then it is the same node, not a second one.
  const gatewayIp = gateway?.ip ?? network.gatewayIp;
  const gatewayMac = lower(gateway?.mac) ?? lower(network.gatewayMac) ?? (gatewayIp ? arpMac.get(gatewayIp) : undefined);
  const isGateway = (ip?: string, mac?: string, name?: string) =>
    (!!ip && ip === gatewayIp) ||
    (!!mac && mac === gatewayMac) ||
    (!!name && !!gateway?.hostname && gateway.hostname.toLowerCase() === name.toLowerCase());
  const gearId = new Map<string, string>();
  for (const d of devices) {
    // A device read on one of its other addresses is still the gateway.
    if (isGateway(d.ip, d.mac) || (!!gatewayIp && !!d.addresses?.some((x) => x.ip === gatewayIp))) {
      gearId.set(d.ip, gatewayNode);
      const node = b.nodes.find((n) => n.id === gatewayNode);
      if (node) Object.assign(node, { managed: true, label: node.label ?? d.sysName, detail: d.sysDescr });
      continue;
    }
    const a = byIpAddr.get(d.ip) ?? (d.mac ? byMac.get(d.mac) : undefined);
    const id = a?.id ?? `gear:${d.ip}`;
    gearId.set(d.ip, id);
    if (a) placed.add(a.id);
    b.node({ id, kind: 'device', assetId: a?.id, ip: d.ip, label: d.sysName, detail: d.sysDescr, deviceType: 'switch', managed: true });
  }
  // Every address of a managed device is the same node: a router or layer 3 switch answers on one
  // address per network, the scan finds each of them, and neighbours announce any of them.
  for (const d of devices) {
    const node = gearId.get(d.ip) as string;
    for (const x of d.addresses ?? []) {
      if (x.ip === '0.0.0.0' || x.ip.startsWith('127.')) continue;
      if (!gearId.has(x.ip)) gearId.set(x.ip, node);
      const other = byIpAddr.get(x.ip);
      if (other) placed.add(other.id);
    }
  }
  const gearOf = new Map(devices.map((d) => [gearId.get(d.ip) as string, d]));

  // Uplink of each managed device: the port where it learned the gateway's MAC address.
  const uplink = new Map<string, number | undefined>();
  for (const d of devices) uplink.set(d.ip, gatewayMac && gearId.get(d.ip) !== gatewayNode ? d.fdb.find((f) => f.mac === gatewayMac)?.ifIndex : undefined);

  /** One cable between two pieces of network gear, with what is known about each end. */
  interface Cable {
    a: string;
    b: string;
    ends: Map<string, { port?: string; iface?: GearInterface; ip?: string }>;
  }
  const cables = new Map<string, Cable>();
  const cable = (x: string, y: string): Cable => {
    const key = [x, y].sort().join('|');
    let c = cables.get(key);
    if (!c) {
      c = { a: x, b: y, ends: new Map() };
      cables.set(key, c);
    }
    return c;
  };
  const setEnd = (c: Cable, node: string, end: { port?: string; iface?: GearInterface; ip?: string }) => {
    const prev = c.ends.get(node) ?? {};
    // A device's own reading of its port beats the name its neighbour announced.
    c.ends.set(node, { port: end.iface?.name ?? prev.port ?? end.port, iface: end.iface ?? prev.iface, ip: end.ip ?? prev.ip });
  };

  // LLDP neighbours: other managed devices (and the gateway) become cables between gear; the rest
  // (access points, small switches) are nodes of their own on the port they were seen on.
  const behind = new Map<string, string>(); // "ip|ifIndex" → node id of the neighbour on that port
  const gearPorts = new Set<string>(); // "ip|ifIndex" of ports that lead to other gear
  for (const d of devices) {
    const self = gearId.get(d.ip) as string;
    for (const n of d.neighbors) {
      const port = iface(d, n.localIfIndex);
      const remotePort = looksLikeMac(n.remotePort) ? undefined : n.remotePort;
      // Neighbours that give no name or address are known by their chassis or port MAC address, or
      // else by the only address the switch learned on that port.
      const learnedHere = port ? d.fdb.filter((f) => f.ifIndex === port.ifIndex) : [];
      const nMac = n.chassisMac ?? n.portMac ?? (!n.sysName && !n.mgmtIp && learnedHere.length === 1 ? learnedHere[0]?.mac : undefined);
      const a =
        (nMac ? byMac.get(nMac) : undefined) ??
        (n.mgmtIp ? byIpAddr.get(n.mgmtIp) : undefined) ??
        (n.sysName ? rest.find((x) => x.hostname?.toLowerCase() === n.sysName?.toLowerCase()) : undefined);
      const peer = isGateway(n.mgmtIp, nMac, n.sysName)
        ? gatewayNode
        : ((a ? gearId.get(a.ip) : undefined) ?? (n.mgmtIp ? gearId.get(n.mgmtIp) : undefined));
      if (peer === self) continue;
      if (peer) {
        const c = cable(self, peer);
        setEnd(c, self, { iface: port, port: n.localPort, ip: d.ip });
        setEnd(c, peer, { port: remotePort });
        if (port) gearPorts.add(`${d.ip}|${port.ifIndex}`);
        continue;
      }
      const id = a?.id ?? `lldp:${nMac ?? n.chassisId ?? `${d.ip}:${n.localPort}`}`;
      if (a) placed.add(a.id);
      const vendor = nMac ? devices.flatMap((x) => x.fdb).find((f) => f.mac === nMac)?.vendor : undefined;
      const announcedType = neighbourType(n.sysName, n.sysDescr, n.capabilities);
      b.node({
        id,
        kind: 'device',
        assetId: a?.id,
        ip: n.mgmtIp ?? (nMac ? ipOfMac.get(nMac) : undefined),
        label: n.sysName ?? (vendor && vendor !== 'Private address' ? vendor : undefined) ?? (nMac ? ipOfMac.get(nMac) : undefined) ?? nMac ?? 'Unknown device',
        detail: n.sysDescr ?? (nMac ? `Announced over LLDP · ${nMac}` : 'Announced over LLDP'),
        announced: !!n.sysName,
        // What a device says it is over LLDP beats a guess from its open ports.
        deviceType: announcedType !== 'unknown' ? announcedType : a && a.type !== 'unknown' ? a.type : 'unknown',
      });
      if (port) behind.set(`${d.ip}|${port.ifIndex}`, id);
      b.link({
        source: self,
        target: id,
        inferred: false,
        sourcePort: port?.name ?? n.localPort,
        targetPort: remotePort,
        speedMbps: port?.speedMbps,
        poe: port?.poe,
        poeWatts: port?.poeWatts,
        traffic: port ? { ip: d.ip, ifIndex: port.ifIndex } : undefined,
      });
    }
  }

  // A switch whose uplink is not already a cable to other gear reaches the gateway through it
  // (learned from its MAC table, so the gateway's port is unknown unless the gateway answers SNMP).
  for (const d of devices) {
    const up = uplink.get(d.ip);
    if (up === undefined || gearPorts.has(`${d.ip}|${up}`)) continue;
    setEnd(cable(gatewayNode, gearId.get(d.ip) as string), gearId.get(d.ip) as string, { iface: iface(d, up), ip: d.ip });
  }

  // A gateway that answers SNMP tells which interface carries which network: the one holding the
  // gateway address serves this network, a public address marks the internet side, and every other
  // addressed interface is a separate network (isolated ports or VLANs) behind the gateway.
  const gatewayGear = gearOf.get(gatewayNode);
  if (gatewayGear?.addresses?.length) {
    const up = (ifIndex: number) => iface(gatewayGear, ifIndex)?.up !== false;
    const own = gatewayGear.addresses.filter((x) => x.ip !== '0.0.0.0' && !x.ip.startsWith('127.') && x.prefix > 0 && x.prefix < 32 && up(x.ifIndex));
    const lan = own.find((x) => x.ip === gatewayIp);
    const lanIface = lan ? iface(gatewayGear, lan.ifIndex) : undefined;
    if (lanIface) {
      for (const c of cables.values()) {
        if ((c.a === gatewayNode || c.b === gatewayNode) && !c.ends.get(gatewayNode)?.port) {
          setEnd(c, gatewayNode, { iface: lanIface, ip: gatewayGear.ip });
        }
      }
    }
    // The internet side is the interface of the gateway's default route (often a private address
    // behind a modem); a public address is the fallback when the route is not published.
    const routeIf = gatewayGear.defaultRoute?.ifIndex;
    const wan = (routeIf !== undefined ? own.find((x) => x.ifIndex === routeIf) : undefined) ?? own.find((x) => !isPrivateIp(x.ip));
    const wanIface = routeIf !== undefined ? iface(gatewayGear, routeIf) : wan ? iface(gatewayGear, wan.ifIndex) : undefined;
    const internet = b.edges.find((e) => e.source === INTERNET_ID && e.target === gatewayNode);
    if (internet && wanIface) {
      Object.assign(internet, { inferred: false, targetPort: wanIface.name, speedMbps: wanIface.speedMbps, traffic: { ip: gatewayGear.ip, ifIndex: wanIface.ifIndex } });
    }
    const thisNet = lan ? cidrOf(lan.ip, lan.prefix) : undefined;
    const seenNets = new Set<string>();
    for (const x of own) {
      if (x === wan || x === lan) continue;
      const net = cidrOf(x.ip, x.prefix);
      if (net === thisNet || seenNets.has(net)) continue;
      seenNets.add(net);
      const port = iface(gatewayGear, x.ifIndex);
      const id = `net:${net}`;
      const tunnel = !!port && TUNNEL.test(port.name);
      b.node({
        id,
        kind: 'device',
        label: net,
        detail: `${tunnel ? 'VPN tunnel' : vlanOfInterface(port?.name) ? `VLAN ${vlanOfInterface(port?.name)}` : 'Separate network'} on ${port?.name ?? 'its own interface'} · gateway ${x.ip}`,
        network: net,
      });
      b.link({
        source: gatewayNode,
        target: id,
        inferred: false,
        sourcePort: port?.name,
        speedMbps: port?.speedMbps,
        traffic: port ? { ip: gatewayGear.ip, ifIndex: port.ifIndex } : undefined,
      });
    }
  }

  // Walk the cables from the gateway: each piece of gear hangs from the one closer to it, with the
  // parent's port at the top end and the child's (its uplink) at the bottom. Cables with a port
  // spanning tree blocks are walked last, so the tree drawn is the one traffic really takes.
  // Only "blocking" counts: listening and learning are passing states, and broken ports carry nothing.
  const blocked = new Set([...cables.values()].filter((c) => [...c.ends.values()].some((e) => e.iface?.stp === 'blocking')));
  const cablesAt = new Map<string, Cable[]>();
  for (const c of cables.values()) for (const n of [c.a, c.b]) cablesAt.set(n, [...(cablesAt.get(n) ?? []), c]);
  const attached = new Set<string>([gatewayNode]);
  const inTree = new Set<Cable>();
  const walkFrom = (start: string[], useBlocked: boolean) => {
    const queue = [...start];
    while (queue.length) {
      const parent = queue.shift() as string;
      for (const c of cablesAt.get(parent) ?? []) {
        if (!useBlocked && blocked.has(c)) continue;
        const child = c.a === parent ? c.b : c.a;
        if (attached.has(child)) continue;
        attached.add(child);
        inTree.add(c);
        queue.push(child);
        const top = c.ends.get(parent) ?? {};
        const bottom = c.ends.get(child) ?? {};
        // Traffic and PoE are read on whichever end is a measured switch port, the parent's first.
        const measured = top.iface && top.ip ? top : bottom;
        b.link({
          source: parent,
          target: child,
          inferred: false,
          sourcePort: top.port,
          targetPort: bottom.port,
          speedMbps: top.iface?.speedMbps ?? bottom.iface?.speedMbps,
          poe: top.iface?.poe,
          poeWatts: top.iface?.poeWatts,
          traffic: measured.iface && measured.ip ? { ip: measured.ip, ifIndex: measured.iface.ifIndex } : undefined,
        });
      }
    }
  };
  walkFrom([gatewayNode], false);
  walkFrom([...attached], true);
  for (const id of gearOf.keys()) {
    if (!attached.has(id)) b.link({ source: gatewayNode, target: id, inferred: true });
  }
  // Cables the walk did not need: both ends already hang from the tree by another path.
  const redundant: MapEdge[] = [];
  for (const c of cables.values()) {
    if (inTree.has(c) || !attached.has(c.a) || !attached.has(c.b)) continue;
    const from = c.ends.get(c.a) ?? {};
    const to = c.ends.get(c.b) ?? {};
    const measured = from.iface && from.ip ? from : to;
    const blockedEnd = [c.a, c.b].find((n) => c.ends.get(n)?.iface?.stp === 'blocking');
    redundant.push({
      id: `${c.a}~${c.b}`,
      source: c.a,
      target: c.b,
      inferred: false,
      sourcePort: from.port ? shortPort(from.port) : undefined,
      targetPort: to.port ? shortPort(to.port) : undefined,
      speedMbps: from.iface?.speedMbps ?? to.iface?.speedMbps,
      traffic: measured.iface && measured.ip ? { ip: measured.ip, ifIndex: measured.iface.ifIndex } : undefined,
      stp: blockedEnd ? 'blocked' : undefined,
      blockedPort: blockedEnd ? { node: blockedEnd, port: shortPort(c.ends.get(blockedEnd)?.port ?? '') } : undefined,
    });
  }

  // Place every other device on the port where a managed switch learned its MAC address.
  const transit = new Set<string>(gearPorts); // ports leading to the gateway or to other managed devices
  for (const d of devices) {
    const up = uplink.get(d.ip);
    if (up !== undefined) transit.add(`${d.ip}|${up}`);
  }
  const macsOnPort = new Map<string, number>();
  for (const d of devices) for (const f of d.fdb) macsOnPort.set(`${d.ip}|${f.ifIndex}`, (macsOnPort.get(`${d.ip}|${f.ifIndex}`) ?? 0) + 1);

  // Addresses that belong to network gear already on the map are not end devices.
  const gearMacs = new Set<string>();
  if (gatewayMac) gearMacs.add(gatewayMac);
  for (const d of devices) {
    if (d.mac) gearMacs.add(d.mac);
    // Its own ports: one seen on another port has come back through a loop, it is not a device.
    for (const i of d.interfaces) if (i.mac) gearMacs.add(i.mac);
    for (const n of d.neighbors) if (n.chassisMac) gearMacs.add(n.chassisMac);
  }
  for (const id of gearId.values()) {
    const a = rest.find((x) => x.id === id);
    const mac = a ? macOfAsset(a) : undefined;
    if (mac) gearMacs.add(mac);
  }
  for (const n of b.nodes) {
    const a = n.assetId ? rest.find((x) => x.id === n.assetId) : undefined;
    const mac = a && n.kind === 'device' && !n.parent ? macOfAsset(a) : undefined;
    if (mac) gearMacs.add(mac);
  }

  // Ports holding one physical machine and its virtual machines: a virtualization host, not an
  // unmanaged switch. The host goes on the port and its virtual machines are grouped under it.
  const fdbVendor = new Map<string, string | undefined>();
  for (const d of devices) for (const f of d.fdb) if (!fdbVendor.get(f.mac)) fdbVendor.set(f.mac, f.vendor);
  const isVm = (mac: string) => isVirtualMac(mac, fdbVendor.get(mac) ?? rest.find((a) => macOfAsset(a) === mac)?.vendor);
  const hostOfPort = new Map<string, string>();
  for (const d of devices) {
    const byPort = new Map<number, Set<string>>();
    for (const f of d.fdb) if (f.ifIndex !== undefined && !gearMacs.has(f.mac)) byPort.set(f.ifIndex, (byPort.get(f.ifIndex) ?? new Set()).add(f.mac));
    for (const [ifIndex, macs] of byPort) {
      const key = `${d.ip}|${ifIndex}`;
      if (macs.size < 2 || transit.has(key) || behind.has(key)) continue;
      const physical = [...macs].filter((m) => !isVm(m));
      if (physical.length === 1 && physical.length < macs.size) hostOfPort.set(key, physical[0] as string);
    }
  }
  const hostNodes = new Map<string, string>();
  /** The node of the virtualization host on a port, made the first time it is needed. */
  const hostNode = (d: GearDevice, port: GearInterface | undefined, key: string, hostMac: string): string => {
    const known = hostNodes.get(key);
    if (known) return known;
    const a = rest.find((x) => macOfAsset(x) === hostMac);
    const id = a?.id ?? `mac:${hostMac}`;
    if (a) placed.add(a.id);
    const vendor = fdbVendor.get(hostMac);
    b.node({
      id,
      kind: 'device',
      assetId: a?.id,
      label: a ? undefined : vendor && vendor !== 'Private address' ? vendor : 'Virtualization host',
      detail: `Virtualization host · ${hostMac}`,
      deviceType: 'server',
    });
    b.link({
      source: gearId.get(d.ip) as string,
      target: id,
      inferred: false,
      sourcePort: port?.name,
      speedMbps: port?.speedMbps,
      poe: port?.poe,
      poeWatts: port?.poeWatts,
      traffic: port ? { ip: d.ip, ifIndex: port.ifIndex } : undefined,
    });
    hostNodes.set(key, id);
    return id;
  };

  const members = new Map<string, Member[]>();
  const add = (parent: string, member: Member) => {
    members.set(parent, [...(members.get(parent) ?? []), member]);
    placed.add(member.id);
  };
  /** Puts one learned address under the node that owns its port; false when it is not placed. */
  const place = (mac: string, make: (port?: GearInterface) => Member): boolean => {
    for (const d of devices) {
      const f: GearFdbEntry | undefined = d.fdb.find((e) => e.mac === mac);
      if (!f || f.ifIndex === undefined) continue;
      // The VLAN the address was learned in comes with it.
      const member = (port?: GearInterface): Member => {
        const m = make(port);
        return f.vlan ? { ...m, node: { ...m.node, vlan: f.vlan } } : m;
      };
      const key = `${d.ip}|${f.ifIndex}`;
      if (transit.has(key)) continue;
      const port = iface(d, f.ifIndex);
      const neighbour = behind.get(key);
      const host = hostOfPort.get(key);
      if (host) {
        const hostId = hostNode(d, port, key, host);
        // The host itself is the node on the port; each virtual machine joins it, typed as one.
        if (mac !== host) {
          const m = member();
          add(hostId, { ...m, type: 'vm', node: { ...m.node, deviceType: 'vm' } });
        }
      } else if (neighbour) {
        const m = member();
        const viaAp = b.nodes.find((n) => n.id === neighbour)?.deviceType === 'ap';
        add(neighbour, viaAp ? { ...m, node: { ...m.node, wireless: true } } : m);
      }
      else if ((macsOnPort.get(key) ?? 0) <= 1) {
        const m = member(port);
        add(gearId.get(d.ip) as string, port ? { ...m, node: { ...m.node, traffic: { ip: d.ip, ifIndex: port.ifIndex } } } : m);
      }
      else {
        // Several devices on a port with no LLDP neighbour: an unmanaged switch, hub or bridge.
        const segment = `segment:${d.ip}:${f.ifIndex}`;
        if (!b.has(segment)) {
          b.node({ id: segment, kind: 'device', label: 'Unmanaged segment', detail: `Several devices on ${port?.name ?? 'one port'}`, deviceType: 'switch' });
          b.link({
            source: gearId.get(d.ip) as string,
            target: segment,
            inferred: false,
            sourcePort: port?.name,
            speedMbps: port?.speedMbps,
            poe: port?.poe,
            poeWatts: port?.poeWatts,
            traffic: port ? { ip: d.ip, ifIndex: port.ifIndex } : undefined,
          });
        }
        add(segment, member());
      }
      return true;
    }
    return false;
  };
  const portInfo = (p?: GearInterface): Partial<MapNode> => (p ? { port: p.name, poe: p.poe, poeWatts: p.poeWatts } : {});

  // Inventory devices first, then addresses switches learned that the inventory does not have.
  const known = new Set<string>(gearMacs);
  for (const a of rest) {
    const mac = macOfAsset(a);
    if (mac) known.add(mac);
    if (placed.has(a.id) || !mac) continue;
    place(mac, (p) => assetMember(a, portInfo(p)));
  }
  const vendorOf = new Map<string, string | undefined>();
  for (const d of devices) for (const f of d.fdb) if (!vendorOf.has(f.mac) || f.vendor) vendorOf.set(f.mac, f.vendor);
  for (const mac of vendorOf.keys()) {
    if (known.has(mac)) continue;
    known.add(mac);
    const vendor = vendorOf.get(mac);
    const label = vendor && vendor !== 'Private address' ? vendor : isPrivateMac(mac) ? 'Private address' : 'Unknown device';
    place(mac, (p) => ({
      id: `mac:${mac}`,
      type: 'unknown',
      node: { label, detail: mac, ...portInfo(p) },
    }));
  }

  for (const [parent, list] of members) b.groups(parent, list, false, true);
  // Under a virtualization host, the group holds its virtual machines.
  for (const hostId of hostNodes.values()) {
    const g = b.nodes.find((n) => n.id === groupId('computers', hostId));
    if (g) g.title = 'Virtual machines';
  }

  // Devices no switch has seen (on the gateway's own ports or Wi-Fi, or without a MAC address).
  b.groups(
    gatewayNode,
    rest.filter((a) => !placed.has(a.id)).map((a) => assetMember(a)),
    true,
    false,
  );
  // Long interface names are shown in their usual short form on the map.
  for (const e of b.edges) {
    if (e.sourcePort) e.sourcePort = shortPort(e.sourcePort);
    if (e.targetPort) e.targetPort = shortPort(e.targetPort);
    if (e.sourcePortsAll) e.sourcePortsAll = shortPort(e.sourcePortsAll);
  }
  for (const n of b.nodes) if (n.port) n.port = shortPort(n.port);

  // VLANs of each link: those of the switch port its traffic is measured on.
  for (const e of [...b.edges, ...redundant]) {
    if (!e.traffic) continue;
    const port = iface(devices.find((d) => d.ip === e.traffic?.ip) as GearDevice, e.traffic.ifIndex);
    if (port?.pvid || port?.tagged?.length) e.vlan = { pvid: port.pvid, tagged: port.tagged };
  }
  const vlans = new Map<number, string | undefined>();
  for (const d of devices) for (const v of d.vlans ?? []) if (!vlans.get(v.id)) vlans.set(v.id, v.name);
  return {
    nodes: b.nodes,
    edges: b.edges,
    confirmed: true,
    redundant: redundant.length ? redundant : undefined,
    vlans: vlans.size ? [...vlans].sort((x, y) => x[0] - y[0]).map(([id, name]) => ({ id, name })) : undefined,
  };
}

// ---------------------------------------------------------------- layout

export interface Size {
  w: number;
  h: number;
}

export const NODE_SIZE: Record<MapNodeKind, Size> = {
  internet: { w: 176, h: 52 },
  gateway: { w: 216, h: 60 },
  device: { w: 216, h: 52 },
  group: { w: 216, h: 40 },
};

/** A device drawn inside a group container. */
export const MEMBER_SIZE: Size = { w: 232, h: 42 };
export const GROUP_HEADER = 40;
const GROUP_PAD = 10;
const MEMBER_GAP = 8;

const GAP_X = 32; // between siblings
const GAP_Y = 96; // between a parent and its children: room for a few cable lanes and their labels
/** A node with at least this many end devices below it lays them out in two staggered rows. */
export const WRAP_MIN = 9;
/** Gap between devices of a staggered row: a cable to the row behind drops through it, with its label. */
const WRAP_GAP = 72;
/** Vertical space between the two staggered rows. */
const WRAP_ROW_GAP = 56;

export type Positions = Record<string, { x: number; y: number }>;

export interface Layout {
  /** Top-left corner; relative to the group for contained devices, absolute otherwise. */
  positions: Positions;
  /** Size of every node (group containers grow with their devices). */
  sizes: Record<string, Size>;
}

/** Columns inside a group: tall rather than wide, so the map keeps a readable shape. */
export function memberColumns(n: number): number {
  return n <= 8 ? 1 : n <= 20 ? 2 : 3;
}

/**
 * Top-down tree layout. Each parent is centred over its children; a group is a container whose
 * devices are stacked in one to three columns. Returns positions and sizes for every node.
 */
export function layoutTree(topo: Topology, rootId = INTERNET_ID): Layout {
  const byId = new Map(topo.nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  for (const e of topo.edges) if (byId.has(e.target)) kids.set(e.source, [...(kids.get(e.source) ?? []), e.target]);
  const members = new Map<string, string[]>();
  for (const n of topo.nodes) if (n.parent) members.set(n.parent, [...(members.get(n.parent) ?? []), n.id]);

  const positions: Positions = {};
  const sizes: Record<string, Size> = {};

  // Group containers: header plus a grid of member cards.
  for (const n of topo.nodes) {
    if (n.kind !== 'group') {
      sizes[n.id] = n.parent ? MEMBER_SIZE : NODE_SIZE[n.kind];
      continue;
    }
    const list = members.get(n.id) ?? [];
    if (!list.length) {
      sizes[n.id] = NODE_SIZE.group;
      continue;
    }
    const cols = memberColumns(list.length);
    const rows = Math.ceil(list.length / cols);
    sizes[n.id] = {
      w: Math.max(NODE_SIZE.group.w, cols * MEMBER_SIZE.w + (cols - 1) * MEMBER_GAP + GROUP_PAD * 2),
      h: GROUP_HEADER + rows * MEMBER_SIZE.h + (rows - 1) * MEMBER_GAP + GROUP_PAD,
    };
    list.forEach((id, i) => {
      positions[id] = { x: GROUP_PAD + (i % cols) * (MEMBER_SIZE.w + MEMBER_GAP), y: GROUP_HEADER + Math.floor(i / cols) * (MEMBER_SIZE.h + MEMBER_GAP) };
    });
  }

  const size = (id: string) => sizes[id] ?? NODE_SIZE.device;
  /**
   * Children laid out in two staggered rows: many end devices of the same card size. Child i sits
   * half a step right of child i-1, alternating rows, so a cable to the back row drops through the
   * gap between two front-row cards and the left-to-right order is kept.
   */
  const wraps = (id: string) => {
    const children = kids.get(id) ?? [];
    if (children.length < WRAP_MIN) return false;
    const w = size(children[0] as string).w;
    const h = size(children[0] as string).h;
    return children.every((k) => !(kids.get(k)?.length) && byId.get(k)?.kind === 'device' && size(k).w === w && size(k).h === h);
  };
  const widths = new Map<string, number>();
  const measure = (id: string): number => {
    const children = kids.get(id) ?? [];
    for (const k of children) measure(k);
    let w: number;
    if (wraps(id)) {
      const cw = size(children[0] as string).w;
      w = Math.max(size(id).w, ((children.length - 1) * (cw + WRAP_GAP)) / 2 + cw);
    } else {
      w = children.length ? Math.max(size(id).w, children.reduce((sum, k) => sum + (widths.get(k) ?? 0), 0) + GAP_X * (children.length - 1)) : size(id).w;
    }
    widths.set(id, w);
    return w;
  };
  const place = (id: string, left: number, top: number) => {
    const width = widths.get(id) ?? size(id).w;
    positions[id] = { x: left + (width - size(id).w) / 2, y: top };
    const children = kids.get(id) ?? [];
    if (wraps(id)) {
      const c = size(children[0] as string);
      const step = (c.w + WRAP_GAP) / 2;
      const total = ((children.length - 1) * step) + c.w;
      const x0 = left + (width - total) / 2;
      const boxes = children.map((_, i) => ({ x: x0 + i * step, w: c.w, h: c.h }));
      // Room for the lanes is worked out for the front row; the back row sits below it.
      const gap = childGap({ ...(positions[id] as { x: number; y: number }), ...size(id) }, boxes);
      const front = top + size(id).h + gap;
      children.forEach((k, i) => {
        positions[k] = { x: (boxes[i] as { x: number }).x, y: i % 2 === 0 ? front : front + c.h + WRAP_ROW_GAP };
      });
      return;
    }
    const total = children.reduce((sum, k) => sum + (widths.get(k) ?? 0), 0) + GAP_X * Math.max(0, children.length - 1);
    let x = left + (width - total) / 2;
    const lefts = children.map((k) => {
      const at = x;
      x += (widths.get(k) ?? 0) + GAP_X;
      return at;
    });
    const gap = childGap({ ...(positions[id] as { x: number; y: number }), ...size(id) }, children.map((k, i) => ({ x: (lefts[i] as number) + ((widths.get(k) ?? 0) - size(k).w) / 2, w: size(k).w, h: size(k).h })));
    children.forEach((k, i) => place(k, lefts[i] as number, top + size(id).h + gap));
  };

  if (byId.has(rootId)) {
    measure(rootId);
    place(rootId, 0, 0);
  }
  return { positions, sizes };
}

/** Room kept below the deepest lane, for the drop into the child and the port label on it. */
const LANE_CLEAR = 100;

/**
 * Vertical space between a parent and its row of children: enough for every link leaving the
 * parent's bottom to turn in its own lane, with clear room below the last lane. `children` gives
 * each child's left edge and size; their row's height does not change the answer.
 */
function childGap(parent: Box, children: { x: number; w: number; h: number }[]): number {
  if (children.length < 2) return GAP_Y;
  const boxes = new Map<string, Box>([['p', parent]]);
  children.forEach((c, i) => boxes.set(`c${i}`, { x: c.x, y: parent.y + parent.h + GAP_Y, w: c.w, h: c.h }));
  const at = attachLinks(
    boxes,
    children.map((_, i) => ({ id: `c${i}`, source: 'p', target: `c${i}` })),
  );
  const deepest = Math.max(-1, ...[...at.values()].map((a) => (a.sourceSide === 'bottom' ? (a.lane ?? 0) : -1)));
  return deepest < 0 ? GAP_Y : Math.max(GAP_Y, LANE_START + deepest * LANE_GAP + LANE_CLEAR);
}

// ---------------------------------------------------------------- link attachment

export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Attachment {
  sx: number;
  sy: number;
  sourceSide: Side;
  tx: number;
  ty: number;
  targetSide: Side;
  /** Position of this link among those leaving the same side, for staggering port labels. */
  sourceRank?: number;
  /**
   * Where the link turns: a y for links leaving a top or bottom side, an x for left or right.
   * Set when several links leave the same side, so each runs in its own lane.
   */
  turn?: number;
  /** Index of that lane, counted outwards from the side (0 is nearest). */
  lane?: number;
}

const LANE_GAP = 22;
const LANE_START = 22;
/** A node with at least this many links leaving its bottom sends the outermost ones out of its sides. */
const SPREAD_MIN = 5;
/** Most links moved to each of the left and right sides. */
const SPREAD_PER_SIDE = 2;

/**
 * The side of `from` that faces `to`. Links leave through the left or right side only when the two
 * boxes sit side by side (their heights overlap); otherwise through the top or bottom, which keeps
 * a top-down tree tidy even when a child is far to one side.
 */
export function facingSide(from: Box, to: Box): Side {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);
  const sideBySide = to.y < from.y + from.h && from.y < to.y + to.h;
  if (sideBySide) return dx > 0 ? 'right' : 'left';
  return dy > 0 ? 'bottom' : 'top';
}

function pointOn(b: Box, side: Side, fraction: number): { x: number; y: number } {
  switch (side) {
    case 'top':
      return { x: b.x + b.w * fraction, y: b.y };
    case 'bottom':
      return { x: b.x + b.w * fraction, y: b.y + b.h };
    case 'left':
      return { x: b.x, y: b.y + b.h * fraction };
    case 'right':
      return { x: b.x + b.w, y: b.y + b.h * fraction };
  }
}

/**
 * Where each link leaves and enters its nodes: on the side facing the other end. Links sharing a
 * side are spread along it, ordered by where their other ends sit, so they do not cross.
 *
 * When many links leave a node's bottom, the ones going furthest left and right (to devices wholly
 * beyond that edge of the node) leave through the left and right sides instead, so the bottom keeps
 * fewer, wider-spaced links. These run out sideways and drop straight into their device; the one
 * going furthest leaves highest, so they nest without crossing.
 */
export function attachLinks(boxes: ReadonlyMap<string, Box>, links: { id: string; source: string; target: string }[]): Map<string, Attachment> {
  type End = { link: string; node: string; other: string; side: Side; role: 's' | 't'; spread?: boolean };
  const ends: End[] = [];
  for (const l of links) {
    const s = boxes.get(l.source);
    const t = boxes.get(l.target);
    if (!s || !t) continue;
    ends.push({ link: l.id, node: l.source, other: l.target, side: facingSide(s, t), role: 's' });
    ends.push({ link: l.id, node: l.target, other: l.source, side: facingSide(t, s), role: 't' });
  }
  const cx = (b: Box) => b.x + b.w / 2;
  const downward = new Map<string, End[]>();
  for (const e of ends) if (e.role === 's' && e.side === 'bottom') downward.set(e.node, [...(downward.get(e.node) ?? []), e]);
  for (const [node, list] of downward) {
    if (list.length < SPREAD_MIN) continue;
    const box = boxes.get(node) as Box;
    const far = (side: 'left' | 'right') =>
      list
        .filter((e) => {
          const o = boxes.get(e.other) as Box;
          return side === 'left' ? o.x + o.w < box.x : o.x > box.x + box.w;
        })
        .sort((a, b) => Math.abs(cx(boxes.get(b.other) as Box) - cx(box)) - Math.abs(cx(boxes.get(a.other) as Box) - cx(box)))
        .slice(0, SPREAD_PER_SIDE);
    for (const side of ['left', 'right'] as const)
      for (const e of far(side)) {
        e.side = side;
        e.spread = true;
      }
  }
  const groups = new Map<string, End[]>();
  for (const e of ends) groups.set(`${e.node}|${e.side}`, [...(groups.get(`${e.node}|${e.side}`) ?? []), e]);

  const points = new Map<string, { x: number; y: number; side: Side; rank: number }>();
  for (const list of groups.values()) {
    const first = list[0] as End;
    const box = boxes.get(first.node) as Box;
    const along = first.side === 'top' || first.side === 'bottom' ? 'x' : 'y';
    const centre = (id: string) => {
      const b = boxes.get(id) as Box;
      return along === 'x' ? b.x + b.w / 2 : b.y + b.h / 2;
    };
    // Links moved to a side go furthest-first from its top; the rest follow their far ends.
    const distance = (e: End) => Math.abs(cx(boxes.get(e.other) as Box) - cx(box));
    const sorted = [...list].sort((a, b) =>
      a.spread && b.spread ? distance(b) - distance(a) : a.spread ? -1 : b.spread ? 1 : centre(a.other) - centre(b.other),
    );
    // A single link uses the middle of the side; several share its inner 80%.
    sorted.forEach((e, i) => {
      const fraction = sorted.length === 1 ? 0.5 : 0.1 + (0.8 * (i + 0.5)) / sorted.length;
      points.set(`${e.link}|${e.role}`, { ...pointOn(box, e.side, fraction), side: e.side, rank: i });
    });
  }

  const out = new Map<string, Attachment>();
  for (const l of links) {
    const s = points.get(`${l.id}|s`);
    const t = points.get(`${l.id}|t`);
    if (s && t) out.set(l.id, { sx: s.x, sy: s.y, sourceSide: s.side, sourceRank: s.rank, tx: t.x, ty: t.y, targetSide: t.side });
  }

  // Lanes: links leaving one side turn at different distances from it. Links heading one way take
  // lanes from the far end of the side inwards, so their bends never cross each other.
  // Links moved to a side need no lane: each makes a single bend straight into its device.
  const spread = new Set(ends.filter((e) => e.spread).map((e) => e.link));
  const bySide = new Map<string, string[]>();
  for (const l of links) {
    const a = out.get(l.id);
    if (a && !spread.has(l.id)) bySide.set(`${l.source}|${a.sourceSide}`, [...(bySide.get(`${l.source}|${a.sourceSide}`) ?? []), l.id]);
  }
  for (const ids of bySide.values()) {
    if (ids.length < 2) continue;
    const vertical = (out.get(ids[0] as string) as Attachment).sourceSide === 'top' || (out.get(ids[0] as string) as Attachment).sourceSide === 'bottom';
    const start = (a: Attachment) => (vertical ? a.sx : a.sy);
    const end = (a: Attachment) => (vertical ? a.tx : a.ty);
    const items = ids.map((id) => out.get(id) as Attachment);
    const forward = items.filter((a) => end(a) >= start(a)).sort((a, b) => start(b) - start(a));
    const backward = items.filter((a) => end(a) < start(a)).sort((a, b) => start(a) - start(b));
    // Links heading the other way take the lanes after these: sharing a lane would put the port
    // labels of a left-going and a right-going link at the same height, where they can collide.
    for (const [lane, first] of [[forward, 0], [backward, forward.length]] as const) {
      lane.forEach((a, k) => {
        const i = first + k;
        const dir = a.sourceSide === 'bottom' || a.sourceSide === 'right' ? 1 : -1;
        const from = vertical ? a.sy : a.sx;
        const to = vertical ? a.ty : a.tx;
        const wanted = from + dir * (LANE_START + i * LANE_GAP);
        a.lane = i;
        // Never turn past the far end; keep a little room before it.
        a.turn = dir > 0 ? Math.min(wanted, to - 10) : Math.max(wanted, to + 10);
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------- cable labels

export interface Point {
  x: number;
  y: number;
}

export interface LabelSize {
  w: number;
  h: number;
}

export interface CableLabels {
  src?: Point;
  dst?: Point;
  mid?: Point;
}

/** Share of the cable, from its own end, where a port name sits: nearer its device than the middle. */
const PORT_SHARE = 0.28;
/** Space kept between a label and the card, and between two labels. */
const LABEL_GAP = 6;
/**
 * Furthest a port name's near edge moves from its device on a long cable: it moves out with the
 * cable's length, so labels of nearby cables spread apart, but stays readable as that device's.
 */
const PORT_MAX_GAP = 90;

/**
 * Where the labels of one cable go: the port name of each end on the cable, a share of its length
 * from the device that owns the port, and the PoE or traffic label at the middle. Positions sit on
 * straight stretches, not on bends. On short cables the port names move towards their own ends to
 * make room; when even that is not enough, the middle label moves beside the line, and the port
 * names last of all, so no two labels cover each other.
 *
 * `at` gives the point at a distance along the cable; sizes are the rendered label boxes.
 */
export function placeCableLabels(
  total: number,
  at: (distance: number) => Point,
  sizes: { src?: LabelSize; dst?: LabelSize; mid?: LabelSize },
  /** Label boxes already placed by other cables; these labels slide along their cable to stay clear. */
  avoid: readonly Box[] = [],
): CableLabels {
  if (!(total > 0)) return {};
  const clampS = (s: number) => Math.min(total, Math.max(0, s));
  const dirAt = (s: number): 'h' | 'v' | undefined => {
    const a = at(clampS(s - 3));
    const b = at(clampS(s + 3));
    if (Math.abs(a.y - b.y) < 0.5 && Math.abs(a.x - b.x) >= 0.5) return 'h';
    if (Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) >= 0.5) return 'v';
    return undefined;
  };
  /** The nearest distance to `s` that lies on a straight stretch. */
  const snap = (s: number) => {
    for (let d = 0; d <= 30; d += 3) {
      if (dirAt(s + d) && s + d <= total) return s + d;
      if (dirAt(s - d) && s - d >= 0) return s - d;
    }
    return s;
  };
  /** Length a label takes up along the cable at distance `s`. */
  const extent = (size: LabelSize, s: number) => (dirAt(s) === 'h' ? size.w : size.h);
  const box = (p: Point, size: LabelSize) => ({ x: p.x - size.w / 2, y: p.y - size.h / 2, w: size.w, h: size.h });
  const overlaps = (a?: Point, sa?: LabelSize, b?: Point, sb?: LabelSize) => {
    if (!a || !b || !sa || !sb) return false;
    const p = box(a, sa);
    const q = box(b, sb);
    return p.x < q.x + q.w + LABEL_GAP && q.x < p.x + p.w + LABEL_GAP && p.y < q.y + q.h + LABEL_GAP && q.y < p.y + p.h + LABEL_GAP;
  };

  /** First and last distance of the straight stretch through `s`. */
  const run = (s: number): [number, number] => {
    const d = dirAt(s);
    if (!d) return [s, s];
    let a = s;
    let b = s;
    while (a > 0 && dirAt(a - 4) === d) a -= 4;
    while (b < total && dirAt(b + 4) === d) b += 4;
    return [Math.max(0, a - 3), Math.min(total, b + 3)];
  };

  // Distances measured from each label's own end of the cable.
  const minFrom = (size: LabelSize, fromEnd: boolean) => extent(size, fromEnd ? total - 4 : 4) / 2 + LABEL_GAP;
  const start = (size: LabelSize, fromEnd: boolean) =>
    Math.max(minFrom(size, fromEnd), Math.min(total * PORT_SHARE, total * 0.45, minFrom(size, fromEnd) + PORT_MAX_GAP));
  let srcD = sizes.src ? start(sizes.src, false) : 0;
  let dstD = sizes.dst ? start(sizes.dst, true) : 0;
  /**
   * A label past a bend sits wholly on its own stretch, clear of the corner, so it never reaches
   * back over the bend into the cables beside it.
   */
  const pos = (d: number, fromEnd: boolean, size: LabelSize) => {
    let s = snap(clampS(fromEnd ? total - d : d));
    const half = extent(size, s) / 2 + LABEL_GAP;
    const [a, b] = run(s);
    if (!fromEnd && a > 0 && s - a < half) s = Math.min(a + half, (a + b) / 2);
    if (fromEnd && b < total && b - s < half) s = Math.max(b - half, (a + b) / 2);
    return at(s);
  };
  // Copied field by field: browser points keep x and y on their prototype, which spreading skips.
  const halfway = at(snap(total / 2));
  const midPoint = sizes.mid ? { x: halfway.x, y: halfway.y } : undefined;

  /** The closest distance from its own end at which a port name has a straight stretch long enough. */
  const closest = (size: LabelSize, fromEnd: boolean, from: number) => {
    for (let d = from; d < total / 2; d += 2) {
      const s = snap(clampS(fromEnd ? total - d : d));
      const [a, b] = run(s);
      if (b - a >= extent(size, s) + LABEL_GAP) return d;
    }
    return from;
  };
  const srcMin = sizes.src ? closest(sizes.src, false, minFrom(sizes.src, false)) : 0;
  const dstMin = sizes.dst ? closest(sizes.dst, true, minFrom(sizes.dst, true)) : 0;
  srcD = Math.max(srcD, srcMin);
  dstD = Math.max(dstD, dstMin);

  const out: CableLabels = {};
  const place = () => {
    out.src = sizes.src ? pos(srcD, false, sizes.src) : undefined;
    out.dst = sizes.dst ? pos(dstD, true, sizes.dst) : undefined;
  };
  place();
  // Port names give way first, sliding towards their own device.
  for (let i = 0; i < 200; i++) {
    const srcHit = overlaps(out.src, sizes.src, midPoint, sizes.mid) || overlaps(out.src, sizes.src, out.dst, sizes.dst);
    const dstHit = overlaps(out.dst, sizes.dst, midPoint, sizes.mid) || overlaps(out.src, sizes.src, out.dst, sizes.dst);
    const srcCan = sizes.src && srcD > srcMin;
    const dstCan = sizes.dst && dstD > dstMin;
    if (!(srcHit && srcCan) && !(dstHit && dstCan)) break;
    if (srcHit && srcCan) srcD = Math.max(srcMin, srcD - 2);
    if (dstHit && dstCan) dstD = Math.max(dstMin, dstD - 2);
    place();
  }

  // Still crowded: the middle label steps beside the line.
  if (midPoint && sizes.mid && (overlaps(out.src, sizes.src, midPoint, sizes.mid) || overlaps(out.dst, sizes.dst, midPoint, sizes.mid))) {
    const side = Math.max(sizes.src?.w ?? 0, sizes.dst?.w ?? 0, 0);
    if (dirAt(total / 2) === 'h') midPoint.y += Math.max(sizes.src?.h ?? 0, sizes.dst?.h ?? 0) / 2 + sizes.mid.h / 2 + LABEL_GAP / 2;
    else midPoint.x += side / 2 + sizes.mid.w / 2 + LABEL_GAP;
  }
  // Very short cables: the two port names sit on either side of the line.
  if (out.src && out.dst && sizes.src && sizes.dst && overlaps(out.src, sizes.src, out.dst, sizes.dst)) {
    if (dirAt(srcD) === 'h') {
      out.src = { x: out.src.x, y: out.src.y - sizes.src.h / 2 - 2 };
      out.dst = { x: out.dst.x, y: out.dst.y + sizes.dst.h / 2 + 2 };
    } else {
      out.src = { x: out.src.x - sizes.src.w / 2 - 2, y: out.src.y };
      out.dst = { x: out.dst.x + sizes.dst.w / 2 + 2, y: out.dst.y };
    }
  }
  out.mid = midPoint;

  // Other cables' labels: each label here slides along its own cable until it is clear of them.
  if (avoid.length) {
    const clearOf = (p: Point | undefined, size: LabelSize | undefined) => {
      if (!p || !size) return true;
      const a = box(p, size);
      return !avoid.some((q) => a.x < q.x + q.w + LABEL_GAP && q.x < a.x + a.w + LABEL_GAP && a.y < q.y + q.h + LABEL_GAP && q.y < a.y + a.h + LABEL_GAP);
    };
    const portsClear = () => !overlaps(out.src, sizes.src, out.dst, sizes.dst);
    const ownClear = () => portsClear() && !overlaps(out.src, sizes.src, out.mid, sizes.mid) && !overlaps(out.dst, sizes.dst, out.mid, sizes.mid);
    // Port names move away from their device, never past the middle of the cable.
    const slide = (end: 'src' | 'dst') => {
      const size = sizes[end];
      if (!size || !out[end] || clearOf(out[end], size)) return;
      const fromEnd = end === 'dst';
      const before = { d: end === 'src' ? srcD : dstD, p: out[end] };
      // As far as the other end's own label allows (checked below), not just to the middle.
      const limit = total - minFrom(size, !fromEnd);
      for (let d = before.d + 4; d < limit; d += 4) {
        const p = pos(d, fromEnd, size);
        out[end] = p;
        // The middle label of this cable moves out of the way afterwards.
        if (clearOf(p, size) && portsClear()) return;
      }
      // Nowhere clear along the cable: beside it, on whichever side is free, at the closest spot that works.
      for (let d = before.d; d < limit; d += 4) {
        const p = pos(d, fromEnd, size);
        const dir = dirAt(fromEnd ? total - d : d);
        const beside =
          dir === 'h'
            ? [{ x: p.x, y: p.y - size.h - 2 }, { x: p.x, y: p.y + size.h + 2 }]
            : [{ x: p.x - size.w / 2 - 6, y: p.y }, { x: p.x + size.w / 2 + 6, y: p.y }];
        for (const q of beside) {
          out[end] = q;
          if (clearOf(q, size) && portsClear()) return;
        }
      }
      out[end] = before.p;
    };
    slide('src');
    slide('dst');
    // The middle label tries spots along the cable, nearest the middle first, then beside it.
    const midSize = sizes.mid;
    if (midSize && out.mid && (!clearOf(out.mid, midSize) || !ownClear())) {
      const start = out.mid;
      const fits = (q: Point) => {
        out.mid = q;
        return clearOf(q, midSize) && ownClear();
      };
      let found = false;
      const search = () => {
        for (let k = 0; k <= 50 && !found; k++) {
          for (const sign of k ? [1, -1] : [1]) {
            const d = total / 2 + sign * k * 6;
            if (d < total * 0.12 || d > total * 0.88) continue;
            const pt = at(snap(d));
            const dir = dirAt(snap(d));
            const spots =
              dir === 'h'
                ? [{ x: pt.x, y: pt.y }, { x: pt.x, y: pt.y - midSize.h - 2 }, { x: pt.x, y: pt.y + midSize.h + 2 }]
                : [{ x: pt.x, y: pt.y }, { x: pt.x - midSize.w / 2 - 6, y: pt.y }, { x: pt.x + midSize.w / 2 + 6, y: pt.y }];
            if (spots.some(fits)) {
              found = true;
              break;
            }
          }
        }
      };
      search();
      // Still no room: the port names step to their closest spots on the cable, then try again.
      if (!found) {
        const keep = { src: out.src, dst: out.dst };
        if (sizes.dst && out.dst) out.dst = pos(dstMin, true, sizes.dst);
        if (!clearOf(out.dst, sizes.dst)) out.dst = keep.dst;
        search();
        if (!found) {
          out.dst = keep.dst;
          out.src = keep.src;
        }
      }
      if (!found) out.mid = start;
    }
  }
  // A cable that is not drawn yet can measure as NaN; such positions are left out.
  const finite = (p?: Point) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : undefined);
  return { src: finite(out.src), dst: finite(out.dst), mid: finite(out.mid) };
}
