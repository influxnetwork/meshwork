/**
 * Network map model: turns one network's inventory into a tree (internet → gateway → network
 * gear → devices) and lays it out top-down. Without switch data, links are assumed from device
 * roles. With a reading of the network's managed switches (LLDP neighbours, learned MAC addresses,
 * PoE), links follow the real ports and each device is placed on the port where it was learned.
 */
import { announcedType } from '@shared/fingerprint';
import { isVirtualMac } from '@shared/model';
import { inCidr } from '@shared/report';
import { followDefaultRoutes } from '@shared/default-routes';
import { byLastBytes, relaysOnPort, type Relay } from '@shared/relayed-address';
import { sharedAddressProtocol, withSharedAddresses, type SharedAddressProtocol } from '@shared/shared-address';
import type { Asset, DeviceType, GearDevice, GearFdbEntry, GearInterface, GearSnapshot, LldpCapability, Network } from '@shared/types';

export type MapNodeKind = 'internet' | 'gateway' | 'device' | 'group';
export type Category = 'computers' | 'phones' | 'printers' | 'cameras' | 'media' | 'iot' | 'other';

/**
 * A network a router serves on one of its cabled ports, or on a VLAN subinterface of one: its VLAN
 * (for a subinterface), range, router address and interface.
 */
export interface RoutedVlan {
  vlan?: number;
  network: string;
  ip: string;
  port: string;
}

/** A gateway address that routers share, on the router that holds it. */
export interface SharedGateway {
  ip: string;
  protocol: SharedAddressProtocol;
  network: string;
  vlan?: number;
  /** The interface the address is on. */
  port?: string;
  /** True when the last reading shows this router, and no other, answering for the address. */
  active: boolean;
}

/**
 * The line a card shows for the shared gateway addresses a router holds: the protocols, "active"
 * when the router answers for all of them, and the address (the first, and how many more). The
 * address comes last: it is the part a narrow card can cut short.
 */
export function gatewayLine(gateways: SharedGateway[]): string {
  const [first, ...more] = gateways;
  if (!first) return '';
  const protocols = [...new Set(gateways.map((g) => g.protocol))].join('/');
  return `${protocols}${gateways.every((g) => g.active) ? ' active' : ''} · ${first.ip}${more.length ? ` +${more.length}` : ''}`;
}

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
  /** True when `label` is the name the device announced itself (LLDP or CDP), which beats a vendor-based name. */
  announced?: boolean;
  /** Protocol a neighbour that is not managed announced itself over. */
  announcedVia?: 'LLDP' | 'CDP';
  /** For a separate network behind the gateway: its address range (CIDR). */
  network?: string;
  /** True for the computer the map is drawn from. */
  self?: boolean;
  /** True when `deviceType` comes from the device's own reading, which beats the scan's guess. */
  typeRead?: boolean;
  /** For a router: the networks it routes on its cabled ports and their VLAN subinterfaces. */
  routes?: RoutedVlan[];
  /** Gateway addresses this router shares with others and holds, one per network. */
  gateways?: SharedGateway[];
  /**
   * On the gateway node: the gateway address is one that routers share, so the card is drawn like
   * that of any other device. The routers sharing it are equals, and each says which address it holds.
   */
  sharedGateway?: boolean;
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
  /** Set on a link bundle (LACP or static): how many cables it is made of and their ports at each end. */
  bundle?: { cables: number; sourcePorts?: string[]; targetPorts?: string[] };
  speedMbps?: number;
  poe?: boolean;
  poeWatts?: number;
  /** Switch port whose counters measure the traffic on this link. */
  traffic?: { ip: string; ifIndex: number };
  /** For a cable to a group: the ports of the devices inside it; their traffic adds up on the cable. */
  trafficPorts?: { ip: string; ifIndex: number }[];
  /** VLANs on that switch port: untagged (PVID) and tagged. */
  vlan?: { pvid?: number; tagged?: number[] };
  /** Networks a router at one end routes on this cable's port and its VLAN subinterfaces. */
  routes?: RoutedVlan[];
  /** True when that router is at the target end; else it is at the source end. */
  routesAtTarget?: boolean;
  /**
   * For a redundant link: blocked when spanning tree blocks a port on it in the default instance.
   * Absent otherwise: other instances (per VLAN, multiple) are not visible, so no port reading
   * blocked does not prove the ring is open.
   */
  stp?: 'blocked';
  /** The node and port spanning tree blocks on a redundant link. */
  blockedPort?: { node: string; port: string };
  /** True for a link that runs over a tunnel interface. */
  tunnel?: boolean;
}

export interface Topology {
  nodes: MapNode[];
  edges: MapEdge[];
  /** True when the links come from switch data. */
  confirmed: boolean;
  /** VLANs configured on the managed devices, by id. */
  vlans?: { id: number; name?: string }[];
  /**
   * The nodes that head a tree each, left to right: one per way out of the managed network (the
   * internet, or equipment that was not read). Absent: the internet node heads the only tree.
   */
  roots?: string[];
  /** Links between devices of different trees (routers that each have their own way out). */
  peers?: MapEdge[];
  /**
   * Cables between gear that is already joined another way: each closes a ring. Spanning tree
   * normally blocks one port on each. Drawn apart from the tree: they take no part in its paths
   * or groups, and move nodes only where devices are cabled to two neighbours of the row above.
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
  /** Addresses of this computer, to mark where the map is drawn from. */
  self?: string[];
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

/** VLAN number of a router subinterface or VLAN interface named like "igc1.60", "eth0.100", "vlan20" or "Vl20". */
export function vlanOfInterface(name?: string): number | undefined {
  const m = name ? /(?:\.|^vl(?:an)?\s?)(\d{1,4})$/i.exec(name) : null;
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 4094 ? n : undefined;
}

/**
 * Cable label for the VLANs a port carries, in switch notation: "U10" for an access port,
 * "U1 T10,20,99" for a trunk (untagged, then tagged). Runs of three or more tagged VLANs become a
 * range ("T10-13"). A port only on the default VLAN 1 gets no label.
 */
export function vlanLabel(vlan?: { pvid?: number; tagged?: number[] }): string | undefined {
  const tagged = [...new Set(vlan?.tagged ?? [])].filter((v) => v !== vlan?.pvid).sort((a, b) => a - b);
  if (!tagged.length) return vlan?.pvid !== undefined && vlan.pvid !== 1 ? `U${vlan.pvid}` : undefined;
  const parts: string[] = [];
  for (let i = 0; i < tagged.length; ) {
    let j = i;
    while (j + 1 < tagged.length && tagged[j + 1] === tagged[j]! + 1) j++;
    if (j - i >= 2) parts.push(`${tagged[i]}-${tagged[j]}`);
    else parts.push(...tagged.slice(i, j + 1).map(String));
    i = j + 1;
  }
  return [vlan?.pvid !== undefined ? `U${vlan.pvid}` : undefined, `T${parts.join(',')}`].filter(Boolean).join(' ');
}

/** Interface names of VPN and other tunnels. */
const TUNNEL = /^(tun|tu\d|tap|wg|ovpn|ipsec|enc|gif|gre|tailscale|zt|ppp|l2tp)/i;

/** Device type of an LLDP or CDP neighbour that is not in the inventory, from its name and description. */
export function neighbourType(sysName?: string, sysDescr?: string, capabilities?: LldpCapability[]): DeviceType {
  const named = announcedType(sysName, sysDescr);
  if (!capabilities?.length) return named;
  // What a device declares over LLDP or CDP is reliable for phones and access points (both often also
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

  /** Removes the links that leave `source`. */
  unlink(source: string) {
    this.edges = this.edges.filter((e) => e.source !== source);
  }

  /** Adds `members` under `parent` as category groups (containers). */
  groups(parent: string, members: Member[], inferred: boolean, scoped: boolean | string) {
    if (!this.options.clients || !members.length) return;
    for (const c of CATEGORIES) {
      const list = members
        .filter((m) => categoryOf(m.type) === c.id)
        .sort((x, y) => ipKey(x.ip ?? '') - ipKey(y.ip ?? '') || x.id.localeCompare(y.id));
      if (!list.length) continue;
      const id = groupId(c.id, typeof scoped === 'string' ? scoped : scoped ? parent : undefined);
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
  // An address several routers share is listed by one of them before anything is drawn: it is
  // then one more address of that router, like the ones a router reports itself.
  if (gear?.devices.length) {
    const macs = new Map<string, string>();
    for (const d of gear.devices) for (const e of d.arp ?? []) if (!macs.has(e.ip)) macs.set(e.ip, e.mac.toLowerCase());
    for (const a of assets) if (a.mac) macs.set(a.ip, a.mac.toLowerCase());
    gear = { ...gear, devices: withSharedAddresses(gear.devices, macs) };
  }
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
    return (n.announced || n.typeRead) && n.deviceType && n.deviceType !== 'unknown' ? n.deviceType : a && a.type !== 'unknown' ? a.type : (n.deviceType ?? 'unknown');
  };
  if (gear?.devices.length) {
    const drawn = withGear(b, gear.devices, network, gateway, gatewayNode, rest);
    // This computer, like any device on the network a router's way out passes, goes beside that
    // router; elsewhere it is held by the router of its network.
    const holderOf = (ip: string) => drawn.besideOf(ip) ?? drawn.holderOf(ip);
    return bankSiblings(markSelf(drawn.topology, assets, options.self, holderOf), typeOf, options.collapsed);
  }

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
  const inNetwork = (ip: string) => (network.cidr ?? '').split(',').some((c) => inCidr(ip, c.trim()));
  return bankSiblings(markSelf({ nodes: b.nodes, edges: b.edges, confirmed: false }, assets, options.self, (ip) => (inNetwork(ip) ? gatewayNode : undefined)), typeOf, options.collapsed);
}

export const SELF_ID = 'self';

/**
 * Marks this computer on the map: its own card when the scan found it and it is drawn; otherwise a
 * card of its own under the node that holds its network (`holderOf`), as an assumed link. Nothing
 * is added when no node holds any of its addresses.
 */
function markSelf(t: Topology, assets: Asset[], self: string[] | undefined, holderOf: (ip: string) => string | undefined): Topology {
  if (!self?.length) return t;
  const mine = assets.find((a) => self.includes(a.ip));
  const card = mine && t.nodes.find((n) => n.assetId === mine.id);
  if (card) {
    card.self = true;
    return t;
  }
  for (const ip of self) {
    const holder = holderOf(ip);
    if (!holder || !t.nodes.some((n) => n.id === holder)) continue;
    t.nodes.push({ id: SELF_ID, kind: 'device', label: 'This computer', ip, deviceType: 'laptop', self: true, assetId: mine?.id });
    t.edges.push({ id: `${holder}->${SELF_ID}`, source: holder, target: SELF_ID, inferred: true });
    return t;
  }
  return t;
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
    !!n && n.kind === 'device' && !n.parent && !n.managed && !n.network && !n.self && !n.id.startsWith('segment:') && !hasKids.has(n.id);
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
): { topology: Topology; holderOf: (ip: string) => string | undefined; besideOf: (ip: string) => string | undefined } {
  // Switches' own ARP tables fill in addresses the inventory lacks (when the OS hides them).
  const arpMac = new Map<string, string>();
  for (const d of devices) for (const e of d.arp ?? []) if (!arpMac.has(e.ip)) arpMac.set(e.ip, e.mac);
  const macOfAsset = (a: Asset) => lower(a.mac) ?? arpMac.get(a.ip);
  const ipOfMac = new Map([...arpMac].map(([ip, mac]) => [mac, ip]));
  // Addresses several routers share: the router that holds one has a second address in that network.
  const sharedIps = new Set<string>();
  const sharedBy = new Map<string, SharedAddressProtocol>(); // shared address → its protocol
  const shares = (ip: string, mac?: string) => {
    const protocol = sharedAddressProtocol(mac);
    if (!protocol) return;
    sharedIps.add(ip);
    if (!sharedBy.has(ip)) sharedBy.set(ip, protocol);
  };
  for (const [ip, mac] of arpMac) shares(ip, mac);
  for (const a of gateway ? [gateway, ...rest] : rest) shares(a.ip, macOfAsset(a));
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
  /**
   * True when a device that switches frames is drawn as a switch whatever the scan guessed: the
   * scan's guess stands only when it names another kind of network gear (an access point, say).
   */
  const switchRead = (d: GearDevice, a?: Asset) => (!!d.bridgePorts || d.fdb.length > 0) && !(a && INFRASTRUCTURE.includes(a.type));
  const gearId = new Map<string, string>();
  for (const d of devices) {
    // A device read on one of its other addresses is still the gateway.
    if (isGateway(d.ip, d.mac) || (!!gatewayIp && !!d.addresses?.some((x) => x.ip === gatewayIp))) {
      gearId.set(d.ip, gatewayNode);
      const node = b.nodes.find((n) => n.id === gatewayNode);
      if (node) Object.assign(node, { managed: true, label: node.label ?? d.sysName, detail: d.sysDescr });
      // A gateway address routers share is not this device's own: the node is the inventory device
      // on the address the device itself has in that network, and holds the shared one for lookups
      // by address. When several devices list the shared address, the first one read stands.
      const held = gatewayIp && sharedIps.has(gatewayIp) ? d.addresses?.find((x) => x.ip === gatewayIp) : undefined;
      const mine = held ? d.addresses?.find((x) => !sharedIps.has(x.ip) && x.prefix === held.prefix && cidrOf(x.ip, x.prefix) === cidrOf(held.ip, held.prefix)) : undefined;
      const self = mine ? byIpAddr.get(mine.ip) : undefined;
      if (node && held) node.sharedGateway = true;
      if (node && self && node.assetId === gateway?.id) {
        Object.assign(node, { assetId: self.id, ip: gatewayIp });
        placed.add(self.id);
      }
      if (node && d.forwarding && !d.bridgePorts && !d.fdb.length) Object.assign(node, { deviceType: 'router', typeRead: true });
      else if (node && switchRead(d, gateway)) Object.assign(node, { deviceType: 'switch', typeRead: true });
      continue;
    }
    const a = byIpAddr.get(d.ip) ?? (d.mac ? byMac.get(d.mac) : undefined);
    const id = a?.id ?? `gear:${d.ip}`;
    gearId.set(d.ip, id);
    if (a) placed.add(a.id);
    // A device that routes and does not switch is a router, whatever the scan guessed.
    const routerOnly = !!d.forwarding && !d.bridgePorts && !d.fdb.length;
    b.node({ id, kind: 'device', assetId: a?.id, ip: d.ip, label: d.sysName, detail: d.sysDescr, deviceType: routerOnly ? 'router' : 'switch', typeRead: routerOnly || switchRead(d, a) || undefined, managed: true });
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
  // A router that holds an address it shares with others says so on its card: which address, by
  // which protocol, and whether the readings show it answering for it. With GLBP every router
  // answers, so none is singled out; nor is any when the interface is down or when several
  // routers list the address.
  const holders = new Map<string, number>(); // shared address → how many devices list it
  for (const d of devices) for (const x of d.addresses ?? []) if (sharedBy.has(x.ip)) holders.set(x.ip, (holders.get(x.ip) ?? 0) + 1);
  for (const [id, d] of gearOf) {
    const held = (d.addresses ?? []).flatMap((x): SharedGateway[] => {
      const protocol = sharedBy.get(x.ip);
      if (!protocol || x.prefix <= 0 || x.prefix >= 32) return [];
      const on = iface(d, x.ifIndex);
      const port = on?.name;
      const vlan = vlanOfInterface(port);
      const active = !x.assumed && protocol !== 'GLBP' && on?.up !== false && holders.get(x.ip) === 1;
      return [{ ip: x.ip, protocol, network: cidrOf(x.ip, x.prefix), ...(vlan !== undefined ? { vlan } : {}), ...(port ? { port } : {}), active }];
    });
    const node = b.nodes.find((n) => n.id === id);
    if (node && held.length) node.gateways = held.sort((p, q) => (p.vlan ?? 0) - (q.vlan ?? 0) || ipKey(p.ip) - ipKey(q.ip));
  }
  // The network and broadcast addresses of a network a managed device holds answer a scan (the
  // device itself replies on them) but are no device: the inventory entries on them are not drawn.
  // An entry with a MAC address of its own is a device whatever its address, and stays.
  const edgeAddresses = new Set<number>();
  for (const d of devices) {
    for (const x of d.addresses ?? []) {
      if (!Number.isInteger(x.prefix) || x.prefix <= 0 || x.prefix > 30 || x.ip === '0.0.0.0' || x.ip.startsWith('127.') || ipKey(x.ip) === Number.MAX_SAFE_INTEGER) continue;
      const first = ipKey(cidrOf(x.ip, x.prefix).split('/')[0] as string);
      edgeAddresses.add(first).add(first + 2 ** (32 - x.prefix) - 1);
    }
  }
  for (const a of rest) if (!gearId.has(a.ip) && !macOfAsset(a) && edgeAddresses.has(ipKey(a.ip))) placed.add(a.id);

  // Where each routing device sends traffic for other networks. A device whose next hop is not a
  // managed device is a way out of the managed network, and heads a tree of its own.
  const wayOut = followDefaultRoutes(devices);
  interface Exit {
    kind: 'internet' | 'upstream' | 'assumed';
    nextHop?: string;
    iface?: GearInterface;
    ip?: string;
  }
  const exits = new Map<string, Exit>(); // node heading a tree → its way out
  const routeParent = new Map<string, string>(); // node → the node its default route leads to
  for (const d of devices) {
    const node = gearId.get(d.ip) as string;
    const way = wayOut.get(d.ip);
    if (!way || (!d.forwarding && node !== gatewayNode)) continue;
    if (way.via) {
      const to = gearId.get(way.via);
      if (to && to !== node) routeParent.set(node, to);
      continue;
    }
    // A next hop that is the gateway (not managed): the device hangs from it, by a cable when one
    // is known, else by this route.
    if (node !== gatewayNode && isGateway(way.nextHop)) {
      routeParent.set(node, gatewayNode);
      continue;
    }
    // A next hop no device owns, on a device that sees the gateway on one of its ports: the next
    // hop is another address of the gateway.
    if (node !== gatewayNode && !gearOf.has(gatewayNode) && !!gatewayMac && d.fdb.some((f) => f.mac === gatewayMac) && isPrivateIp(way.nextHop) && !byIpAddr.has(way.nextHop)) {
      routeParent.set(node, gatewayNode);
      continue;
    }
    // A private next hop the scan found (a firewall or modem that was not read) heads the tree.
    const upstream = isPrivateIp(way.nextHop) ? byIpAddr.get(way.nextHop) : undefined;
    if (upstream) {
      b.node({ id: upstream.id, kind: 'device', assetId: upstream.id });
      placed.add(upstream.id);
      routeParent.set(node, upstream.id);
      if (!exits.has(upstream.id)) exits.set(upstream.id, { kind: 'assumed' });
      continue;
    }
    exits.set(node, { kind: isPrivateIp(way.nextHop) ? 'upstream' : 'internet', nextHop: way.nextHop, iface: iface(d, way.ifIndex), ip: d.ip });
  }
  // The tree the gateway is in comes first. A gateway with no way out read keeps an assumed one,
  // unless it holds a public address: that interface is its internet side.
  const topOf = (node: string): string => {
    const seen = new Set<string>();
    let at = node;
    while (routeParent.has(at) && !seen.has(at)) {
      seen.add(at);
      at = routeParent.get(at) as string;
    }
    return at;
  };
  const first = topOf(gatewayNode);
  if (!exits.has(first)) {
    const g = gearOf.get(first);
    const pub = g?.addresses?.find((x) => x.ip !== '0.0.0.0' && !x.ip.startsWith('127.') && x.prefix > 0 && x.prefix < 32 && !isPrivateIp(x.ip) && iface(g, x.ifIndex)?.up !== false);
    exits.set(first, g && pub ? { kind: 'internet', iface: iface(g, pub.ifIndex), ip: g.ip } : { kind: 'assumed' });
  }
  const headIp = (node: string) => ipKey(gearOf.get(node)?.ip ?? rest.find((a) => a.id === node)?.ip ?? '');
  const heads = [first, ...[...exits.keys()].filter((h) => h !== first).sort((x, y) => headIp(x) - headIp(y))];
  const roots: string[] = [];
  const exitNode = new Map<string, string>(); // node heading a tree → the node drawn for its way out
  b.unlink(INTERNET_ID);
  heads.forEach((head, i) => {
    const exit = exits.get(head) as Exit;
    const id = i === 0 ? INTERNET_ID : `internet:${head}`;
    exitNode.set(head, id);
    b.node({ id, kind: 'internet' });
    const node = b.nodes.find((n) => n.id === id) as MapNode;
    if (exit.nextHop) node.ip = exit.nextHop;
    if (exit.kind === 'upstream') Object.assign(node, { label: 'Upstream', detail: 'The next hop of the default route. It was not read, so what lies beyond it is not known.' });
    roots.push(id);
    b.link({
      source: id,
      target: head,
      inferred: exit.kind === 'assumed',
      targetPort: exit.iface?.name,
      speedMbps: exit.iface?.speedMbps,
      traffic: exit.iface && exit.ip ? { ip: exit.ip, ifIndex: exit.iface.ifIndex } : undefined,
    });
  });
  /** The managed router that holds the network `ip` is in, other than `self`: the most specific one. */
  const routerOf = (ip: string, self?: string): string | undefined => {
    let best: { node: string; prefix: number; shared: boolean; key: number } | undefined;
    for (const d of devices) {
      const node = gearId.get(d.ip) as string;
      if (node === self || (!d.forwarding && node !== gatewayNode)) continue;
      for (const x of d.addresses ?? []) {
        const net = `${x.ip}/${x.prefix}`;
        if (x.prefix <= 0 || x.prefix >= 32 || x.ip === '0.0.0.0' || !inCidr(ip, net)) continue;
        // Several routers on the same network: the one that holds its shared address, then the
        // lowest address, whatever order the devices were read in.
        const found = { node, prefix: x.prefix, shared: !!d.addresses?.some((y) => sharedIps.has(y.ip) && inCidr(y.ip, net)), key: ipKey(d.ip) };
        const closer = !best || found.prefix > best.prefix || (found.prefix === best.prefix && (Number(found.shared) - Number(best.shared) || best.key - found.key) > 0);
        if (closer) best = found;
      }
    }
    return best?.node;
  };

  // Uplink of each managed device: the port where it learned the gateway's MAC address.
  const uplink = new Map<string, number | undefined>();
  for (const d of devices) uplink.set(d.ip, gatewayMac && gearId.get(d.ip) !== gatewayNode ? d.fdb.find((f) => f.mac === gatewayMac)?.ifIndex : undefined);

  /** One cable between two pieces of network gear, with what is known about each end. */
  interface Cable {
    a: string;
    b: string;
    ends: Map<string, { port?: string; iface?: GearInterface; ip?: string; routes?: RoutedVlan[]; members?: string[] }>;
    /** How many cables a link bundle stands for, when this cable is one. */
    bundled?: number;
  }
  const cables = new Map<string, Cable>();
  const between = new Map<string, Cable[]>(); // "a|b" (sorted) → the cables joining a and b
  const portKey = (name?: string) => name?.toLowerCase().replace(/^([a-z]{2})[a-z-]*\s*(?=\d)/, '$1');
  /**
   * The cable between x and y. Without `local` (x's own port), the first one. With it, the cable
   * already on that port; else one whose x end is not read yet (preferring the one whose y end is
   * the port y was announced on, `remote`); else a new cable: a device that reaches the same
   * neighbour through two of its own ports has two cables to it.
   */
  const cable = (x: string, y: string, local?: GearInterface, remote?: string): Cable => {
    const key = [x, y].sort().join('|');
    const list = between.get(key) ?? [];
    const found = !local
      ? list[0]
      : (list.find((c) => c.ends.get(x)?.iface?.ifIndex === local.ifIndex) ??
        list.filter((c) => !c.ends.get(x)?.iface).sort((p, q) => Number(portKey(q.ends.get(y)?.port) === portKey(remote)) - Number(portKey(p.ends.get(y)?.port) === portKey(remote)))[0]);
    if (found) return found;
    const c: Cable = { a: x, b: y, ends: new Map() };
    cables.set(list.length ? `${key}#${list.length}` : key, c);
    between.set(key, [...list, c]);
    return c;
  };
  const setEnd = (c: Cable, node: string, end: { port?: string; iface?: GearInterface; ip?: string }) => {
    const prev = c.ends.get(node) ?? {};
    // A device's own reading of its port beats the name its neighbour announced.
    c.ends.set(node, { port: end.iface?.name ?? prev.port ?? end.port, iface: end.iface ?? prev.iface, ip: end.ip ?? prev.ip });
  };

  // LLDP and CDP neighbours: other managed devices (and the gateway) become cables between gear; the rest
  // (access points, small switches) are nodes of their own on the port they were seen on.
  const behind = new Map<string, string>(); // "ip|ifIndex" → node id of the neighbour on that port
  const gearPorts = new Set<string>(); // "ip|ifIndex" of ports that lead to other gear
  const heardFrom = new Map<string, { source: string; rank: readonly [number, number] }>(); // neighbour node → the device and port it hangs from
  // A neighbour heard on the port a device's default route leaves through stands above that
  // device. When several devices hear the same neighbour that way, the one with the lowest address
  // has it above, whatever order the devices were read in.
  const through = new Map<string, { id: string; hang?: () => void }>(); // device → the neighbour its way out passes
  const neighbourKey = (n: GearDevice['neighbors'][number]) => n.chassisMac ?? n.portMac ?? n.mgmtIp ?? n.sysName ?? n.chassisId;
  const aboveOf = (self: string) => (exits.get(self)?.nextHop ? exitNode.get(self) : routeParent.get(self));
  const passes = new Map<string, string>(); // neighbour → the address of the device that has it above
  for (const d of devices) {
    const self = gearId.get(d.ip) as string;
    const way = wayOut.get(d.ip);
    const above = aboveOf(self);
    if (!way || way.via || !above || gearOf.has(above)) continue;
    for (const n of d.neighbors) {
      const key = neighbourKey(n);
      if (!key || n.localIfIndex !== way.ifIndex) continue;
      const holder = passes.get(key);
      if (holder === undefined || ipKey(d.ip) < ipKey(holder)) passes.set(key, d.ip);
    }
  }
  // A neighbour that gives no address the scan knows is still a managed device when it names a
  // MAC address of one (its own or that of a port), or, giving nothing else at all, the name of
  // one. An address or a name that two managed devices share tells neither, nor does an address
  // routers share.
  const gearByMac = new Map<string, string | undefined>();
  const gearByName = new Map<string, string | undefined>();
  for (const d of devices) {
    const node = gearId.get(d.ip) as string;
    for (const mac of new Set([d.mac, ...d.interfaces.map((i) => i.mac)])) {
      if (!mac || /^(00[:-]?){5}00$/.test(mac) || sharedAddressProtocol(mac)) continue;
      gearByMac.set(mac, gearByMac.has(mac) && gearByMac.get(mac) !== node ? undefined : node);
    }
    const name = d.sysName?.toLowerCase();
    if (name) gearByName.set(name, gearByName.has(name) && gearByName.get(name) !== node ? undefined : node);
  }
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
      // By name only when the neighbour gives nothing else at all, and never the device that heard it.
      const byName = !nMac && !n.mgmtIp && !n.chassisId && n.sysName ? gearByName.get(n.sysName.toLowerCase()) : undefined;
      const named = byName !== self ? byName : undefined;
      const peer = isGateway(n.mgmtIp, nMac, n.sysName)
        ? gatewayNode
        : ((a ? gearId.get(a.ip) : undefined) ?? (n.mgmtIp ? gearId.get(n.mgmtIp) : undefined) ?? (nMac ? gearByMac.get(nMac) : undefined) ?? named);
      if (peer === self) continue;
      if (peer) {
        const c = cable(self, peer, port, remotePort);
        setEnd(c, self, { iface: port, port: n.localPort, ip: d.ip });
        setEnd(c, peer, { port: remotePort });
        if (port) gearPorts.add(`${d.ip}|${port.ifIndex}`);
        continue;
      }
      const id = a?.id ?? `lldp:${nMac ?? n.chassisId ?? `${d.ip}:${n.localPort}`}`;
      if (a) placed.add(a.id);
      // A neighbour that heads a tree (the device a default route leads to) is drawn there
      // already: this device hangs from it, so no link is drawn down to it.
      if (exits.has(id)) {
        if (port) gearPorts.add(`${d.ip}|${port.ifIndex}`);
        continue;
      }
      const vendor = nMac ? devices.flatMap((x) => x.fdb).find((f) => f.mac === nMac)?.vendor : undefined;
      // A neighbour that says it routes, on a port where the switch also learned other devices:
      // their frames cross it unrouted, so it switches. Addresses routers share are its own.
      const carries = (!!a || !!nMac) && learnedHere.some((f) => f.mac !== nMac && f.mac !== n.chassisMac && f.mac !== n.portMac && !sharedAddressProtocol(f.mac) && !!byMac.get(f.mac) && byMac.get(f.mac) !== a);
      const said = neighbourType(n.sysName, n.sysDescr ?? n.platform, n.capabilities);
      const announcedType = said === 'router' && carries ? 'switch' : said;
      const via = n.protocols && !n.protocols.includes('lldp') ? 'CDP' : 'LLDP';
      b.node({
        id,
        kind: 'device',
        assetId: a?.id,
        ip: n.mgmtIp ?? (nMac ? ipOfMac.get(nMac) : undefined),
        label: n.sysName ?? (vendor && vendor !== 'Private address' ? vendor : undefined) ?? (nMac ? ipOfMac.get(nMac) : undefined) ?? nMac ?? 'Unknown device',
        detail: n.sysDescr ?? n.platform ?? (nMac ? `Announced over ${via} · ${nMac}` : `Announced over ${via}`),
        announced: !!n.sysName,
        announcedVia: via,
        // What a device says it is over LLDP or CDP beats a guess from its open ports.
        deviceType: announcedType !== 'unknown' ? announcedType : a && a.type !== 'unknown' ? a.type : 'unknown',
      });
      // A neighbour heard on the port the default route of this device leaves through, when that
      // route leads to equipment that was not read, is on the way there: it stands above this
      // device, under what the route leads to. How it is cabled further up is not known. A device
      // that heads a tree is hung at once; any other when its route is what places it, and should
      // a cable place it first, the neighbour hangs below it like any other.
      const way = wayOut.get(d.ip);
      const above = aboveOf(self);
      const nKey = neighbourKey(n);
      if (port && way && !way.via && way.ifIndex === port.ifIndex && above && !gearOf.has(above) && above !== id && !!nKey && passes.get(nKey) === d.ip && !through.has(self)) {
        const earlier = heardFrom.get(id);
        if (earlier) b.edges = b.edges.filter((e) => !(e.source === earlier.source && e.target === id));
        heardFrom.set(id, { source: above, rank: [-1, -1] });
        const hang = () => {
          b.edges = b.edges.filter((e) => !(e.source === above && e.target === self));
          b.link({ source: above, target: id, inferred: true });
          b.link({
            source: id,
            target: self,
            inferred: false,
            sourcePort: remotePort,
            targetPort: port.name,
            speedMbps: port.speedMbps,
            traffic: { ip: d.ip, ifIndex: port.ifIndex },
          });
        };
        if (exits.get(self)?.nextHop) {
          hang();
          through.set(self, { id });
        } else through.set(self, { id, hang });
        continue;
      }
      if (port) behind.set(`${d.ip}|${port.ifIndex}`, id);
      // A neighbour heard on several ports, of one device or of several, hangs from one of them:
      // the lowest address, then the lowest port, whatever order the devices were read in.
      const rank = [ipKey(d.ip), port?.ifIndex ?? Number.MAX_SAFE_INTEGER] as const;
      const earlier = heardFrom.get(id);
      if (earlier && (earlier.rank[0] < rank[0] || (earlier.rank[0] === rank[0] && earlier.rank[1] <= rank[1]))) continue;
      if (earlier) b.edges = b.edges.filter((e) => !(e.source === earlier.source && e.target === id));
      heardFrom.set(id, { source: self, rank });
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

  /** The addresses a managed device holds itself: its own, those of its ports and the one the scan saw. */
  const ownMacs = (d: GearDevice): Set<string> => {
    const a = gateway?.ip === d.ip ? gateway : byIpAddr.get(d.ip);
    return new Set([d.mac, ...d.interfaces.map((i) => i.mac), a ? macOfAsset(a) : undefined].map(lower).filter((m): m is string => !!m));
  };

  // A cable only one end of which heard the other: the end that heard nobody still belongs to a
  // managed device. It is the port its neighbour named, when one port alone answers to that name
  // and has no cable yet; else a port with no cable yet where that device learned an address of
  // the neighbour. Once known, it leads to other gear like any port that heard a neighbour.
  for (const c of cables.values()) {
    for (const [node, other] of [[c.a, c.b], [c.b, c.a]] as const) {
      const d = gearOf.get(node);
      const end = c.ends.get(node);
      if (!d || end?.iface) continue;
      const answering = end?.port ? d.interfaces.filter((i) => portKey(i.name) === portKey(end.port)) : [];
      const named = answering.length === 1 && !gearPorts.has(`${d.ip}|${answering[0]?.ifIndex}`) ? answering[0] : undefined;
      const peer = gearOf.get(other);
      const peerMacs = peer && peer !== d ? ownMacs(peer) : undefined;
      const learned = !named && peerMacs ? d.fdb.find((f) => f.ifIndex !== undefined && peerMacs.has(f.mac) && !gearPorts.has(`${d.ip}|${f.ifIndex}`)) : undefined;
      const port = named ?? iface(d, learned?.ifIndex);
      if (!port) continue;
      setEnd(c, node, { iface: port, ip: d.ip });
      gearPorts.add(`${d.ip}|${port.ifIndex}`);
    }
  }

  // Switches that announce no neighbours are joined by the addresses they learned. A device that
  // knows its uplink, or is the gateway, has below it every device whose own address it learned
  // on another port. When each of two devices has the other below, their tables disagree and
  // neither counts.
  const ownerOf = new Map<string, GearDevice[]>(); // own address → the devices that hold it
  for (const d of devices) for (const mac of ownMacs(d)) ownerOf.set(mac, [...(ownerOf.get(mac) ?? []), d]);
  const below = new Map<string, Map<string, number>>(); // device → each device below it, with the port it is on
  for (const x of devices) {
    const seen = new Map<string, number>();
    const up = uplink.get(x.ip);
    if (up !== undefined || gearId.get(x.ip) === gatewayNode) {
      for (const f of x.fdb) {
        if (f.ifIndex === undefined || f.ifIndex === up) continue;
        for (const y of ownerOf.get(f.mac) ?? []) if (y !== x && !seen.has(y.ip)) seen.set(y.ip, f.ifIndex);
      }
    }
    below.set(x.ip, seen);
  }
  const above = new Map<string, { d: GearDevice; port: number }[]>();
  for (const y of devices) {
    above.set(
      y.ip,
      devices.flatMap((x) => {
        const port = below.get(x.ip)?.get(y.ip);
        return port !== undefined && !below.get(y.ip)?.has(x.ip) ? [{ d: x, port }] : [];
      }),
    );
  }
  // A switch whose uplink is not a cable yet is plugged into the deepest device above it: the one
  // at the end of the longest row of devices each above the next. Counting the devices above would
  // not do: a switch cabled to two cores has as many above it as the switch plugged into it, which
  // one of the cores never learns. Equal depths go to the lowest address, and depths are worked out
  // lowest address first, so the order the devices were read in does not change the map. A port
  // where a neighbour announced itself keeps that neighbour only.
  const depths = new Map<string, number>();
  const depth = (d: GearDevice, path = new Set<string>()): number => {
    const known = depths.get(d.ip);
    if (known !== undefined) return known;
    // Tables that put a device above itself through others: the row stops there.
    if (path.has(d.ip)) return 0;
    path.add(d.ip);
    const over = [...(above.get(d.ip) ?? [])].sort((p, q) => ipKey(p.d.ip) - ipKey(q.d.ip));
    const found = Math.max(0, ...over.map((x) => depth(x.d, path) + 1));
    path.delete(d.ip);
    depths.set(d.ip, found);
    return found;
  };
  for (const d of [...devices].sort((p, q) => ipKey(p.ip) - ipKey(q.ip))) depth(d);
  const announced = new Set(gearPorts);
  for (const y of devices) {
    const up = uplink.get(y.ip);
    if (up === undefined || announced.has(`${y.ip}|${up}`)) continue;
    const self = gearId.get(y.ip) as string;
    const free = (x: { d: GearDevice; port: number }) => !announced.has(`${x.d.ip}|${x.port}`) && !behind.has(`${x.d.ip}|${x.port}`);
    const parent = (above.get(y.ip) ?? [])
      .filter((x) => depth(x.d) < depth(y) && gearId.get(x.d.ip) !== self && free(x))
      .sort((p, q) => depth(q.d) - depth(p.d) || ipKey(p.d.ip) - ipKey(q.d.ip))[0];
    if (!parent) continue;
    const node = gearId.get(parent.d.ip) as string;
    const c = cable(node, self, iface(parent.d, parent.port));
    setEnd(c, node, { iface: iface(parent.d, parent.port), ip: parent.d.ip });
    setEnd(c, self, { iface: iface(y, up), ip: y.ip });
    gearPorts.add(`${parent.d.ip}|${parent.port}`).add(`${y.ip}|${up}`);
  }

  // A switch whose uplink is still not a cable to other gear reaches the gateway through it
  // (learned from its MAC table, so the gateway's port is unknown unless the gateway answers SNMP).
  for (const d of devices) {
    const up = uplink.get(d.ip);
    if (up === undefined || gearPorts.has(`${d.ip}|${up}`)) continue;
    setEnd(cable(gatewayNode, gearId.get(d.ip) as string), gearId.get(d.ip) as string, { iface: iface(d, up), ip: d.ip });
  }

  // A router that answers SNMP tells which interface carries which network. The interface its
  // default route leaves through is its way out; on the gateway, the one holding the gateway
  // address serves this network. A network on a cabled port, or on a VLAN subinterface of one, is
  // shown on that cable. Any other network no other managed device is on is a separate network
  // (isolated ports, VLANs, tunnels) behind the router.
  const netNodes = new Map<string, Map<string, GearInterface | undefined>>(); // network → nodes on it, with their interface
  for (const d of devices) {
    for (const x of d.addresses ?? []) {
      if (x.ip === '0.0.0.0' || x.ip.startsWith('127.') || x.prefix <= 0 || x.prefix >= 32) continue;
      const net = cidrOf(x.ip, x.prefix);
      netNodes.set(net, (netNodes.get(net) ?? new Map()).set(gearId.get(d.ip) as string, iface(d, x.ifIndex)));
    }
  }
  const seenNets = new Set<string>();
  const byVlan = (p: RoutedVlan, q: RoutedVlan) => (p.vlan ?? 0) - (q.vlan ?? 0) || p.port.localeCompare(q.port);
  for (const d of devices) {
    const self = gearId.get(d.ip) as string;
    const isGw = self === gatewayNode;
    if (!d.addresses?.length || (!d.forwarding && !isGw)) continue;
    const up = (ifIndex: number) => iface(d, ifIndex)?.up !== false;
    const own = d.addresses.filter((x) => x.ip !== '0.0.0.0' && !x.ip.startsWith('127.') && x.prefix > 0 && x.prefix < 32 && up(x.ifIndex));
    const lan = isGw ? own.find((x) => x.ip === gatewayIp) : undefined;
    const lanIface = lan ? iface(d, lan.ifIndex) : undefined;
    if (lanIface) {
      for (const c of cables.values()) {
        if ((c.a === self || c.b === self) && !c.ends.get(self)?.port) setEnd(c, self, { iface: lanIface, ip: d.ip });
      }
    }
    const egress = exits.get(self)?.iface?.ifIndex ?? wayOut.get(d.ip)?.ifIndex;
    const thisNet = lan ? cidrOf(lan.ip, lan.prefix) : undefined;
    const switches = !!d.bridgePorts || d.fdb.length > 0;
    const svis = own.filter((x) => /^vl(an)?\s?\d+$/i.test(iface(d, x.ifIndex)?.name ?? '')).length;
    const routed: RoutedVlan[] = [];
    for (const x of own) {
      const port = iface(d, x.ifIndex);
      // The network the default route leaves through is the way out, not a network served, unless
      // it is one of the VLANs a switch routes between.
      const servedVlan = switches && svis > 1 && /^vl(an)?\s?\d+$/i.test(port?.name ?? '');
      if (x.ifIndex === egress && !servedVlan) continue;
      const net = cidrOf(x.ip, x.prefix);
      // A shared address is a second address in a network the router names by its own address,
      // also when it is the gateway address of the scanned network.
      if (sharedIps.has(x.ip) && own.some((y) => y !== x && !sharedIps.has(y.ip) && cidrOf(y.ip, y.prefix) === net)) continue;
      // A cabled port, or a VLAN subinterface of one: its network lives behind that cable.
      const vlan = vlanOfInterface(port?.name);
      const physical = vlan !== undefined ? port?.name.replace(/\.\d+$/, '') : port?.name;
      const onPort = (name?: string) => !!name && !!physical && (name === physical || name.replace(/\.\d+$/, '') === physical);
      const carrier = [...cables.values()].find((c) => (c.a === self || c.b === self) && onPort(c.ends.get(self)?.iface?.name));
      // Or a port where the router hears a neighbour that is not managed.
      const physicalIface = d.interfaces.find((i) => i.name === physical);
      const heard = physicalIface ? behind.get(`${d.ip}|${physicalIface.ifIndex}`) : undefined;
      const heardLink = heard ? b.edges.find((e) => e.source === self && e.target === heard) : undefined;
      if ((carrier || heardLink) && port && (vlan !== undefined || x !== lan)) {
        const route = { vlan, network: net, ip: x.ip, port: port.name };
        const end = carrier?.ends.get(self);
        if (end) {
          end.routes = [...(end.routes ?? []), route].sort(byVlan);
        } else if (heardLink) {
          heardLink.routes = [...(heardLink.routes ?? []), route].sort(byVlan);
        }
        routed.push(route);
        continue;
      }
      // A switch that routes between its VLANs: each VLAN interface is a network it serves.
      if (port && vlan !== undefined && switches && svis > 1 && port.name === physical) {
        routed.push({ vlan, network: net, ip: x.ip, port: port.name });
        continue;
      }
      if (x === lan || net === thisNet) continue;
      // A network other managed devices are on too is part of the map already; so is one whose
      // devices the scan found, which hang from this router. A public network is its provider's.
      if ((netNodes.get(net)?.size ?? 0) > 1 || seenNets.has(net) || !isPrivateIp(x.ip)) continue;
      if (rest.some((a) => !gearId.has(a.ip) && inCidr(a.ip, net))) continue;
      seenNets.add(net);
      const id = `net:${net}`;
      const tunnel = !!port && TUNNEL.test(port.name);
      b.node({
        id,
        kind: 'device',
        label: net,
        detail: `${tunnel ? 'VPN tunnel' : vlan ? `VLAN ${vlan}` : 'Separate network'} on ${port?.name ?? 'its own interface'} · gateway ${x.ip}`,
        network: net,
      });
      b.link({
        source: self,
        target: id,
        inferred: false,
        sourcePort: port?.name,
        speedMbps: port?.speedMbps,
        traffic: port ? { ip: d.ip, ifIndex: port.ifIndex } : undefined,
      });
    }
    const mapNode = b.nodes.find((n) => n.id === self);
    if (mapNode && routed.length) mapNode.routes = routed.sort(byVlan);
  }

  // The cables of a link bundle are one link: cables between the same two devices whose port at
  // either end belongs to the same bundle, or is the bundle itself, become one cable on the bundle
  // interface, which is where spanning tree and traffic are read. The ports are kept for its label.
  const bundleOf = (node: string, i?: GearInterface): GearInterface | undefined => {
    const d = gearOf.get(node);
    if (!d || !i) return undefined;
    if (i.memberOf !== undefined) return iface(d, i.memberOf);
    return d.interfaces.some((x) => x.memberOf === i.ifIndex) ? i : undefined;
  };
  const merged = new Set<Cable>();
  for (const [pair, list] of between) {
    // Cables go together when they share the bundle at one end and name no other bundle at the other.
    const groups: { at: [number | undefined, number | undefined]; cables: Cable[] }[] = [];
    for (const c of list) {
      const at = [c.a, c.b].map((n) => bundleOf(n, c.ends.get(n)?.iface)?.ifIndex) as [number | undefined, number | undefined];
      if (at[0] === undefined && at[1] === undefined) continue;
      const agrees = (g: (typeof groups)[number], k: 0 | 1) => at[k] === undefined || g.at[k] === undefined || g.at[k] === at[k];
      const group = groups.find((g) => agrees(g, 0) && agrees(g, 1) && ((at[0] !== undefined && g.at[0] === at[0]) || (at[1] !== undefined && g.at[1] === at[1])));
      if (group) {
        group.cables.push(c);
        group.at = [group.at[0] ?? at[0], group.at[1] ?? at[1]];
      } else groups.push({ at, cables: [c] });
    }
    for (const { cables: group } of groups) {
      const kept = group[0] as Cable;
      const ends = [kept.a, kept.b].map((node) => {
        const all = group.map((c) => c.ends.get(node)).filter((e) => !!e);
        const whole = all.map((e) => bundleOf(node, e.iface)).find((x) => !!x);
        const members = [...new Set(all.filter((e) => e.iface?.memberOf !== undefined || (!whole && e.port)).map((e) => shortPort(e.iface?.name ?? e.port ?? '')))].filter(Boolean).sort();
        const first = all[0] ?? {};
        return { ...first, port: whole?.name ?? first.port, iface: whole ?? first.iface, ip: all.find((e) => e.ip)?.ip, routes: all.find((e) => e.routes)?.routes, members: members.length ? members : undefined };
      });
      const cablesIn = Math.max(...ends.map((e) => e.members?.length ?? 0), 1);
      // A lone cable on a lone member port stays the cable it is.
      if (group.length < 2 && cablesIn < 2) continue;
      kept.ends.set(kept.a, ends[0] as (typeof ends)[number]);
      kept.ends.set(kept.b, ends[1] as (typeof ends)[number]);
      kept.bundled = cablesIn;
      for (const c of group.slice(1)) merged.add(c);
      between.set(pair, (between.get(pair) ?? []).filter((c) => c === kept || !group.includes(c)));
    }
  }
  if (merged.size) for (const [k, v] of cables) if (merged.has(v)) cables.delete(k);

  // Walk the cables from the gateway: each piece of gear hangs from the one closer to it, with the
  // parent's port at the top end and the child's (its uplink) at the bottom. Cables with a port
  // spanning tree blocks are walked last, so the tree drawn is the one traffic really takes.
  // Only "blocking" counts: listening and learning are passing states, and broken ports carry nothing.
  const blocked = new Set([...cables.values()].filter((c) => [...c.ends.values()].some((e) => e.iface?.stp === 'blocking')));
  const cablesAt = new Map<string, Cable[]>();
  for (const c of cables.values()) for (const n of [c.a, c.b]) cablesAt.set(n, [...(cablesAt.get(n) ?? []), c]);
  const attached = new Set<string>(heads);
  const treeOf = new Map<string, string>(heads.map((h) => [h, h])); // node → the head of its tree
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
        treeOf.set(child, treeOf.get(parent) as string);
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
          routes: top.routes ?? bottom.routes,
          routesAtTarget: (!top.routes && !!bottom.routes) || undefined,
          bundle: c.bundled ? { cables: c.bundled, sourcePorts: top.members, targetPorts: bottom.members } : undefined,
        });
      }
    }
  };
  // Cables are followed from every head at once, so a device joins the tree of the head nearest to it.
  walkFrom(heads, false);
  // A device no cable reaches hangs from the device its default route leads to, by the interfaces
  // the route runs over.
  const hangByRoute = (): boolean => {
    // One device at a time, lowest address first: what its cables reach is placed before the
    // next device is hung, so cables always win over routes whatever order the devices were read in.
    const ready = [...gearOf]
      .filter(([id]) => !attached.has(id) && attached.has(routeParent.get(id) ?? ''))
      .sort(([, x], [, y]) => ipKey(x.ip) - ipKey(y.ip));
    for (const [id, d] of ready.slice(0, 1)) {
      const parent = routeParent.get(id) as string;
      // Its way out passes a neighbour that is drawn above it already, with the cable between them.
      const passed = through.get(id);
      if (passed?.hang) {
        passed.hang();
        passed.hang = undefined;
        attached.add(id);
        treeOf.set(id, treeOf.get(parent) as string);
        walkFrom([id], false);
        continue;
      }
      const way = wayOut.get(d.ip);
      const egress = iface(d, way?.ifIndex);
      const parentGear = gearOf.get(parent);
      const held = parentGear?.addresses?.find((x) => x.ip === way?.nextHop);
      const parentPort = parentGear && held ? iface(parentGear, held.ifIndex) : undefined;
      b.link({
        source: parent,
        target: id,
        // The route names a physical or tunnel interface: the link is on it. Through a VLAN
        // interface the cabling between the two is not known.
        inferred: !egress || vlanOfInterface(egress.name) !== undefined,
        sourcePort: parentPort?.name,
        targetPort: egress && vlanOfInterface(egress.name) === undefined ? egress.name : undefined,
        speedMbps: egress?.speedMbps,
        traffic: egress ? { ip: d.ip, ifIndex: egress.ifIndex } : undefined,
        tunnel: (!!egress && TUNNEL.test(egress.name)) || undefined,
      });
      attached.add(id);
      treeOf.set(id, treeOf.get(parent) as string);
      walkFrom([id], false);
    }
    return ready.length > 0;
  };
  while (hangByRoute());
  // Devices nothing reaches yet, routers first: each is assumed under the router of its network,
  // and what its own cables and routes reach is placed from it before the next one is looked at.
  for (;;) {
    const left = [...gearOf].filter(([id]) => !attached.has(id)).sort(([, x], [, y]) => Number(!!y.forwarding) - Number(!!x.forwarding) || ipKey(x.ip) - ipKey(y.ip));
    const next = left[0];
    if (!next) break;
    const [id, d] = next;
    const holder = routerOf(d.ip, id);
    const parent = holder && attached.has(holder) ? holder : gatewayNode;
    b.link({ source: parent, target: id, inferred: true });
    attached.add(id);
    treeOf.set(id, treeOf.get(parent) as string);
    walkFrom([id], false);
    while (hangByRoute());
  }
  walkFrom([...attached], true);
  // A device a cable placed before its route did: the neighbour on its way out hangs below it.
  for (const [self, passed] of through) {
    if (!passed.hang || b.edges.some((e) => e.target === passed.id)) continue;
    const d = gearOf.get(self);
    const port = d ? iface(d, wayOut.get(d.ip)?.ifIndex) : undefined;
    b.link({ source: self, target: passed.id, inferred: false, sourcePort: port?.name, speedMbps: port?.speedMbps, traffic: d && port ? { ip: d.ip, ifIndex: port.ifIndex } : undefined });
  }
  // Cables the walk did not need: both ends already hang from the tree by another path.
  const redundant: MapEdge[] = [];
  const peers: MapEdge[] = [];
  const headOrder = (node: string) => heads.indexOf(treeOf.get(node) as string);
  for (const c of cables.values()) {
    if (inTree.has(c) || !attached.has(c.a) || !attached.has(c.b)) continue;
    // A cable between two trees joins devices whose trees each have their own way out.
    if (treeOf.get(c.a) !== treeOf.get(c.b)) {
      const [x, y] = headOrder(c.a) <= headOrder(c.b) ? [c.a, c.b] : [c.b, c.a];
      const ex = c.ends.get(x) ?? {};
      const ey = c.ends.get(y) ?? {};
      const measuredEnd = ex.iface && ex.ip ? ex : ey;
      peers.push({
        id: `${x}~${y}${peers.some((e) => e.source === x && e.target === y) ? `~${peers.length}` : ''}`,
        source: x,
        target: y,
        inferred: false,
        sourcePort: ex.port ? shortPort(ex.port) : undefined,
        targetPort: ey.port ? shortPort(ey.port) : undefined,
        speedMbps: ex.iface?.speedMbps ?? ey.iface?.speedMbps,
        traffic: measuredEnd.iface && measuredEnd.ip ? { ip: measuredEnd.ip, ifIndex: measuredEnd.iface.ifIndex } : undefined,
        routes: ex.routes ?? ey.routes,
        routesAtTarget: (!ex.routes && !!ey.routes) || undefined,
        bundle: c.bundled ? { cables: c.bundled, sourcePorts: ex.members, targetPorts: ey.members } : undefined,
      });
      continue;
    }
    const from = c.ends.get(c.a) ?? {};
    const to = c.ends.get(c.b) ?? {};
    const measured = from.iface && from.ip ? from : to;
    const blockedEnd = [c.a, c.b].find((n) => c.ends.get(n)?.iface?.stp === 'blocking');
    const twin = redundant.filter((e) => e.source === c.a && e.target === c.b).length;
    redundant.push({
      id: twin ? `${c.a}~${c.b}~${twin}` : `${c.a}~${c.b}`,
      source: c.a,
      target: c.b,
      inferred: false,
      sourcePort: from.port ? shortPort(from.port) : undefined,
      targetPort: to.port ? shortPort(to.port) : undefined,
      speedMbps: from.iface?.speedMbps ?? to.iface?.speedMbps,
      traffic: measured.iface && measured.ip ? { ip: measured.ip, ifIndex: measured.iface.ifIndex } : undefined,
      stp: blockedEnd ? 'blocked' : undefined,
      blockedPort: blockedEnd ? { node: blockedEnd, port: shortPort(c.ends.get(blockedEnd)?.port ?? '') } : undefined,
      bundle: c.bundled ? { cables: c.bundled, sourcePorts: from.members, targetPorts: to.members } : undefined,
    });
  }

  // Two routers of different trees with addresses in one point-to-point network or tunnel, and no
  // cable seen between them, are joined over it.
  for (const [net, on] of netNodes) {
    if (on.size !== 2) continue;
    const [x, y] = [...on.keys()].sort((p, q) => headOrder(p) - headOrder(q)) as [string, string];
    const tunnel = [...on.values()].some((i) => !!i && TUNNEL.test(i.name));
    if (!tunnel && Number(net.split('/')[1]) < 30) continue;
    if (!attached.has(x) || !attached.has(y) || treeOf.get(x) === treeOf.get(y)) continue;
    if (peers.some((e) => (e.source === x && e.target === y) || (e.source === y && e.target === x))) continue;
    const px = on.get(x);
    const py = on.get(y);
    const dx = gearOf.get(x);
    peers.push({
      id: `${x}~${y}`,
      source: x,
      target: y,
      inferred: false,
      sourcePort: px ? shortPort(px.name) : undefined,
      targetPort: py ? shortPort(py.name) : undefined,
      speedMbps: px?.speedMbps ?? py?.speedMbps,
      traffic: px && dx ? { ip: dx.ip, ifIndex: px.ifIndex } : undefined,
      tunnel: tunnel || undefined,
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

  // Extenders that rewrite the addresses of the devices behind them, by the port that learned those
  // addresses. A rewritten address that stands for an inventory device, and the extender's own
  // when the inventory holds the extender, is that device: it is not drawn as an address apart.
  const inventoryMacs = byLastBytes(rest.flatMap((a) => macOfAsset(a) ?? []));
  const relayAt = new Map<string, Relay[]>();
  const standsFor = new Set<string>();
  for (const d of devices) {
    const byPort = new Map<number, string[]>();
    for (const f of d.fdb) if (f.ifIndex !== undefined && !transit.has(`${d.ip}|${f.ifIndex}`)) byPort.set(f.ifIndex, [...(byPort.get(f.ifIndex) ?? []), f.mac]);
    for (const [ifIndex, macs] of byPort) {
      const relays = relaysOnPort(macs, inventoryMacs);
      if (!relays.length) continue;
      relayAt.set(`${d.ip}|${ifIndex}`, relays);
      for (const r of relays) {
        for (const mac of r.alias.keys()) standsFor.add(mac);
        if (r.self && r.realMac) standsFor.add(r.self);
      }
    }
  }
  /** The extender on a port that a learned address belongs to. */
  const relayOf = (key: string, mac: string): Relay | undefined => relayAt.get(key)?.find((r) => r.members.includes(mac));

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
      if (macs.size < 2 || transit.has(key) || behind.has(key) || relayAt.has(key)) continue;
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

  const relayNodes = new Map<string, string>();
  /**
   * The node of an extender on a port, made the first time it is needed. It hangs from the
   * neighbour heard on that port (the access point it repeats), else from the port itself.
   */
  const relayNode = (d: GearDevice, port: GearInterface | undefined, key: string, relay: Relay): string => {
    const known = relayNodes.get(`${key}|${relay.prefix}`);
    if (known) return known;
    const a = relay.realMac ? rest.find((x) => macOfAsset(x) === relay.realMac) : undefined;
    const id = a?.id ?? `relay:${d.ip}:${port?.ifIndex ?? ''}:${relay.prefix}`;
    relayNodes.set(`${key}|${relay.prefix}`, id);
    // An extender already drawn another way keeps its place; the devices behind it join it there.
    if (a && placed.has(a.id) && b.has(a.id)) return id;
    if (a) placed.add(a.id);
    const neighbour = behind.get(key);
    b.node({
      id,
      kind: 'device',
      assetId: a?.id,
      label: a ? undefined : 'Wi-Fi extender',
      detail: 'Wi-Fi extender · the devices behind it show under addresses it rewrites',
      deviceType: 'ap',
      typeRead: true,
    });
    b.link(
      neighbour
        ? { source: neighbour, target: id, inferred: false }
        : { source: gearId.get(d.ip) as string, target: id, inferred: false, sourcePort: port?.name, speedMbps: port?.speedMbps, poe: port?.poe, poeWatts: port?.poeWatts, traffic: port ? { ip: d.ip, ifIndex: port.ifIndex } : undefined },
    );
    return id;
  };

  const members = new Map<string, Member[]>();
  const add = (parent: string, member: Member) => {
    members.set(parent, [...(members.get(parent) ?? []), member]);
    placed.add(member.id);
  };
  // Every port an address was learned on that does not lead to other gear, nearest first. The port
  // with the fewest addresses is the one the device is plugged into: each switch further away
  // learns it together with everything else behind that port. Equal counts go to the lowest
  // switch address, so the order the devices were read in does not change the map.
  const learnedOn = new Map<string, { d: GearDevice; f: GearFdbEntry }[]>();
  for (const d of devices) {
    const first = new Set<string>();
    for (const f of d.fdb) {
      // The first entry a device holds for an address stands for it.
      if (first.has(f.mac)) continue;
      first.add(f.mac);
      if (f.ifIndex === undefined || transit.has(`${d.ip}|${f.ifIndex}`)) continue;
      // A rewritten address is also where the device it stands for was learned.
      const relay = relayOf(`${d.ip}|${f.ifIndex}`, f.mac);
      const real = relay?.alias.get(f.mac) ?? (relay?.self === f.mac ? relay.realMac : undefined);
      for (const mac of real ? [f.mac, real] : [f.mac]) {
        const list = learnedOn.get(mac);
        if (list) list.push({ d, f });
        else learnedOn.set(mac, [{ d, f }]);
      }
    }
  }
  const shared = (x: { d: GearDevice; f: GearFdbEntry }) => macsOnPort.get(`${x.d.ip}|${x.f.ifIndex}`) ?? 0;
  for (const list of learnedOn.values()) list.sort((p, q) => shared(p) - shared(q) || ipKey(p.d.ip) - ipKey(q.d.ip));
  // An extender is where its rewritten address was learned, also when a port learned its real one.
  for (const relays of relayAt.values()) {
    for (const r of relays) {
      const list = r.realMac ? learnedOn.get(r.realMac) : undefined;
      const at = list?.findIndex((x) => x.f.mac === r.self) ?? -1;
      if (list && at > 0) list.unshift(...list.splice(at, 1));
    }
  }

  /** Puts one learned address under the node that owns its port; false when it is not placed. */
  const place = (mac: string, make: (port?: GearInterface) => Member): boolean => {
    for (const { d, f } of learnedOn.get(mac) ?? []) {
      // The VLAN the address was learned in comes with it.
      const member = (port?: GearInterface): Member => {
        const m = make(port);
        return f.vlan ? { ...m, node: { ...m.node, vlan: f.vlan } } : m;
      };
      const key = `${d.ip}|${f.ifIndex}`;
      const port = iface(d, f.ifIndex);
      const neighbour = behind.get(key);
      const host = hostOfPort.get(key);
      const relay = relayOf(key, f.mac);
      if (relay) {
        // The extender's own address is the extender; every other one is a device behind it.
        const relayId = relayNode(d, port, key, relay);
        if (f.mac !== relay.self) add(relayId, member());
      } else if (host) {
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
  const known = new Set<string>([...gearMacs, ...standsFor]);
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

  /**
   * The node an address is beside its router at, when it is on the network that router's default
   * route leaves through: what the route leads to, when that is equipment that was not read and
   * the map shows it. That is the node drawn for the way out of a router that heads a tree, else
   * the node the route of the router leads to. Undefined for any other address.
   */
  const besideOf = (ip: string): string | undefined => {
    const router = routerOf(ip);
    const d = router ? gearOf.get(router) : undefined;
    const nextHop = d ? wayOut.get(d.ip)?.nextHop : undefined;
    const out = d?.addresses?.find((x) => x.prefix > 0 && x.prefix < 32 && inCidr(ip, `${x.ip}/${x.prefix}`) && inCidr(nextHop ?? '', `${x.ip}/${x.prefix}`));
    if (!router || !d || !nextHop || !out) return undefined;
    // A VLAN that a switch routes between is a network it serves, also when its route leaves through it.
    const isSvi = (ifIndex: number) => /^vl(an)?\s?\d+$/i.test(iface(d, ifIndex)?.name ?? '');
    if ((!!d.bridgePorts || d.fdb.length > 0) && isSvi(out.ifIndex) && (d.addresses ?? []).filter((x) => isSvi(x.ifIndex)).length > 1) return undefined;
    const beyond = exits.get(router)?.kind === 'upstream' ? exitNode.get(router) : routeParent.get(router);
    return beyond && !gearOf.has(beyond) && b.has(beyond) ? beyond : undefined;
  };
  // Devices no switch has seen (on the gateway's own ports or Wi-Fi, or without a MAC address).
  // Each stays with the managed router of its network, when one holds it; else with the gateway.
  // On the network a router leaves through, they are beside that router, under what its route
  // leads to.
  const unseen = new Map<string, Member[]>();
  for (const a of rest) {
    if (placed.has(a.id)) continue;
    const holder = besideOf(a.ip) ?? routerOf(a.ip) ?? gatewayNode;
    unseen.set(holder, [...(unseen.get(holder) ?? []), assetMember(a)]);
  }
  for (const [holder, list] of unseen) b.groups(holder, list, true, holder === gatewayNode ? false : `${holder}:unseen`);
  // Long interface names are shown in their usual short form on the map.
  for (const e of b.edges) {
    if (e.sourcePort) e.sourcePort = shortPort(e.sourcePort);
    if (e.targetPort) e.targetPort = shortPort(e.targetPort);
    if (e.sourcePortsAll) e.sourcePortsAll = shortPort(e.sourcePortsAll);
  }
  for (const n of b.nodes) if (n.port) n.port = shortPort(n.port);

  // VLANs of each link: those of the switch port its traffic is measured on.
  for (const e of [...b.edges, ...redundant, ...peers]) {
    if (!e.traffic) continue;
    const port = iface(devices.find((d) => d.ip === e.traffic?.ip) as GearDevice, e.traffic.ifIndex);
    if (port?.pvid || port?.tagged?.length) e.vlan = { pvid: port.pvid, tagged: port.tagged };
  }
  const vlans = new Map<number, string | undefined>();
  for (const d of devices) for (const v of d.vlans ?? []) if (!vlans.get(v.id)) vlans.set(v.id, v.name);
  /**
   * The node an address with no known port is behind: the device heard on the router port that
   * carries its network, else the router that holds that network.
   */
  const holderOf = (ip: string): string | undefined => {
    const carrier = b.edges.find((e) => e.routes?.some((r) => inCidr(ip, r.network)));
    if (carrier) return gearOf.has(carrier.target) ? carrier.source : carrier.target;
    return routerOf(ip);
  };
  const topology: Topology = {
    nodes: b.nodes,
    edges: b.edges,
    confirmed: true,
    redundant: redundant.length ? redundant : undefined,
    roots,
    peers: peers.length ? peers : undefined,
    vlans: vlans.size ? [...vlans].sort((x, y) => x[0] - y[0]).map(([id, name]) => ({ id, name })) : undefined,
  };
  return { topology, holderOf, besideOf };
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

/** Extra height of a router card that lists the VLANs it routes. */
export const ROUTES_ROW = 22;

/** Extra height of a router card that names the shared gateway addresses it holds. */
export const GATEWAY_ROW = 18;

/** A device drawn inside a group container. */
export const MEMBER_SIZE: Size = { w: 232, h: 42 };
export const GROUP_HEADER = 40;
const GROUP_PAD = 10;
const MEMBER_GAP = 8;

const GAP_X = 32; // between siblings
const TREE_GAP = 120; // between two trees standing side by side: room for the link that joins them and its port names
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
      const base = n.parent ? MEMBER_SIZE : NODE_SIZE[n.sharedGateway ? 'device' : n.kind];
      const rows = n.parent ? 0 : (n.routes?.some((r) => r.vlan !== undefined) ? ROUTES_ROW : 0) + (n.gateways?.length ? GATEWAY_ROW : 0);
      sizes[n.id] = rows ? { w: base.w, h: base.h + rows } : base;
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
  // A node is measured and placed once: a map whose links looped would otherwise never end.
  const measured = new Set<string>();
  const laid = new Set<string>();
  const measure = (id: string): number => {
    if (measured.has(id)) return widths.get(id) ?? size(id).w;
    measured.add(id);
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
    if (laid.has(id)) return;
    laid.add(id);
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

  // Each root heads a tree; the trees stand side by side, their tops level.
  let left = 0;
  for (const root of topo.roots?.length ? topo.roots : [rootId]) {
    if (!byId.has(root)) continue;
    const width = measure(root);
    place(root, left, 0);
    left += width + TREE_GAP;
  }

  // Devices cabled to two neighbours of the row above (one cable carries their traffic, spanning
  // tree holds the other back) stand under the two, spread from one to the other, with whatever
  // hangs from them: a single one in between, two under one each. Devices the first neighbour holds
  // alone keep their place, and then the nearest of the others keeps its place too; this needs the
  // devices cabled to both to be the ones on the side of the second neighbour. It holds only when
  // the second neighbour has nothing below it of its own, so the room under it is free, and when
  // the devices fit side by side without reaching past it.
  const joined = new Set((topo.redundant ?? []).flatMap((e) => [`${e.source}|${e.target}`, `${e.target}|${e.source}`]));
  const centre = (id: string) => (positions[id]?.x ?? 0) + size(id).w / 2;
  // A device inside a group is placed within its group and never moved here; a move reaches each
  // node below once, so links that loop cannot carry it round again.
  const shift = (id: string, dx: number, dy: number, seen = new Set<string>()) => {
    const at = positions[id];
    if (seen.has(id) || !at || byId.get(id)?.parent) return;
    seen.add(id);
    positions[id] = { x: at.x + dx, y: at.y + dy };
    for (const k of kids.get(id) ?? []) shift(k, dx, dy, seen);
  };
  // Rows from the top down, so what a row above moves is in place before the rows below it are looked at.
  const above = (id: string) => positions[id] ?? { x: 0, y: 0 };
  const rows = [...kids].sort(([p], [q]) => above(p).y - above(q).y || above(p).x - above(q).x || p.localeCompare(q)).map(([, row]) => row);
  for (const row of rows) {
    for (const [i, first] of row.entries()) {
      const below = [...(kids.get(first) ?? [])].sort((p, q) => centre(p) - centre(q));
      if (!below.length || byId.get(first)?.kind === 'group' || wraps(first)) continue;
      const free = (q: string | undefined): q is string => q !== undefined && byId.get(q)?.kind !== 'group' && !(kids.get(q)?.length) && positions[q]?.y === positions[first]?.y;
      const second = [row[i - 1], row[i + 1]].filter(free).find((q) => below.some((k) => joined.has(`${q}|${k}`)));
      if (!second) continue;
      const order = below.filter((k) => joined.has(`${second}|${k}`));
      const alone = below.length - order.length;
      // The ones cabled to both are the ones nearest the second neighbour, so none passes over another.
      const right = centre(second) > centre(first);
      if (alone && (order.length < 2 || !below.slice(right ? alone : 0, right ? undefined : order.length).every((k) => order.includes(k)))) continue;
      const near = (right ? order[0] : order[order.length - 1]) as string;
      const start = alone ? centre(near) : centre(first);
      const from = Math.min(start, centre(second));
      const to = Math.max(start, centre(second));
      const width = (id: string) => widths.get(id) ?? size(id).w;
      // The cables of the second neighbour turn in lanes of their own: the row moves down to make room for them.
      const room = order.length * LANE_GAP;
      const rest = below.filter((k) => !order.includes(k));
      if (order.length === 1) {
        shift(order[0] as string, (from + to) / 2 - centre(order[0] as string), room);
        continue;
      }
      const step = (to - from) / (order.length - 1);
      const fits = order.every((k, n) => n === 0 || step >= width(order[n - 1] as string) / 2 + width(k) / 2 + GAP_X);
      // The outermost must not reach past the card above it by more than half the room between siblings.
      const outer = (right ? order[order.length - 1] : order[0]) as string;
      if (!fits || width(outer) / 2 > size(second).w / 2 + GAP_X / 2) continue;
      order.forEach((k, n) => shift(k, from + n * step - centre(k), room));
      for (const k of rest) shift(k, 0, room);
    }
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
    true,
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
 *
 * Cables of different nodes are then moved clear of each other (`separateCables`), unless
 * `lanesOnly` asks for the lanes alone.
 */
export function attachLinks(boxes: ReadonlyMap<string, Box>, links: { id: string; source: string; target: string }[], lanesOnly = false): Map<string, Attachment> {
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
  if (!lanesOnly) separateCables(boxes, links, out);
  return out;
}

/** Closest two level runs of different cables may be, and two drops side by side. */
const RUN_CLEAR = LANE_GAP - 4;
const DROP_CLEAR = 8;
/** How far an end moves along its side to get out from under another cable. */
const DROP_STEP = 20;

/**
 * Moves cables that would run over the cables of another device. Lanes keep the links of one side
 * of one device apart; two devices in a row know nothing of each other, so a cable from the second
 * can turn at the height where one from the first already runs, or drop down the line another
 * climbs. Cables are taken in the order given, each kept clear of those before it: its level run
 * moves a lane further from its source until it is free, and an end that shares its drop with
 * another cable moves along its side towards the cable's other end. A straight cable is never
 * bent, and a cable with nowhere to go stays where it was. Only cables between a top and a bottom
 * side are looked at; the rest keep the single bend they have.
 */
function separateCables(boxes: ReadonlyMap<string, Box>, links: { id: string; source: string; target: string }[], out: Map<string, Attachment>): void {
  type Run = { x1: number; x2: number; y: number };
  type Drop = { end: 's' | 't'; x: number; y1: number; y2: number };
  const upright = (side: Side) => side === 'top' || side === 'bottom';
  const turnOf = (a: Attachment) => a.turn ?? (a.sy + a.ty) / 2;
  const bent = (a: Attachment) => Math.abs(a.sx - a.tx) > 1;
  const runOf = (a: Attachment): Run | undefined => (bent(a) ? { x1: Math.min(a.sx, a.tx), x2: Math.max(a.sx, a.tx), y: turnOf(a) } : undefined);
  const dropsOf = (a: Attachment): Drop[] => [
    { end: 's', x: a.sx, y1: Math.min(a.sy, turnOf(a)), y2: Math.max(a.sy, turnOf(a)) },
    { end: 't', x: a.tx, y1: Math.min(a.ty, turnOf(a)), y2: Math.max(a.ty, turnOf(a)) },
  ];
  // Cables already in place do not move again: their stretches are worked out once.
  const runs: Run[] = [];
  const drops: Drop[] = [];
  const runUnder = (p: Run): Run | undefined => {
    for (const q of runs) if (Math.abs(p.y - q.y) < RUN_CLEAR && Math.min(p.x2, q.x2) - Math.max(p.x1, q.x1) > 4) return q;
    return undefined;
  };
  /** The end of the cable whose drop shares a line with a drop already in place, if any. */
  const sharedDrop = (a: Attachment): 's' | 't' | undefined => {
    for (const p of dropsOf(a)) for (const q of drops) if (Math.abs(p.x - q.x) < DROP_CLEAR && Math.min(p.y2, q.y2) - Math.max(p.y1, q.y1) > 4) return p.end;
    return undefined;
  };

  for (const l of links) {
    const a = out.get(l.id);
    const source = boxes.get(l.source);
    const target = boxes.get(l.target);
    if (!a || !source || !target || !upright(a.sourceSide) || !upright(a.targetSide) || a.sourceSide === a.targetSide) continue;
    if (bent(a) && drops.length) {
      // The level run: a lane further from the source each time, never past the far end.
      const dir = a.ty > a.sy ? 1 : -1;
      const first = a.turn;
      let free = false;
      for (let tries = 0; tries < 12 && !free; tries++) {
        const over = runUnder(runOf(a) as Run);
        if (!over) {
          free = true;
          break;
        }
        const wanted = over.y + dir * LANE_GAP;
        if (dir > 0 ? wanted > a.ty - 10 : wanted < a.ty + 10) break;
        a.turn = wanted;
      }
      if (!free) a.turn = first;
      // The drops: the end on a line another cable uses steps along its side towards its own far
      // end, as long as the cable stays longer than the step and the end stays on its card.
      const before = { sx: a.sx, tx: a.tx };
      for (let tries = 0; tries < 6; tries++) {
        const end = sharedDrop(a);
        if (!end) break;
        const box = end === 's' ? source : target;
        const moved = (end === 's' ? a.sx : a.tx) + (end === 's' ? Math.sign(a.tx - a.sx) : Math.sign(a.sx - a.tx)) * DROP_STEP;
        if (Math.abs(a.sx - a.tx) < DROP_STEP * 2 || moved < box.x + 8 || moved > box.x + box.w - 8) {
          Object.assign(a, before);
          break;
        }
        if (end === 's') a.sx = moved;
        else a.tx = moved;
      }
    }
    const run = runOf(a);
    if (run) runs.push(run);
    drops.push(...dropsOf(a));
  }
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
  const clearOf = (p: Point | undefined, size: LabelSize | undefined) => {
    if (!p || !size) return true;
    const a = box(p, size);
    return !avoid.some((q) => a.x < q.x + q.w + LABEL_GAP && q.x < a.x + a.w + LABEL_GAP && a.y < q.y + q.h + LABEL_GAP && q.y < a.y + a.h + LABEL_GAP);
  };
  const portsClear = () => !overlaps(out.src, sizes.src, out.dst, sizes.dst);
  const ownClear = () => portsClear() && !overlaps(out.src, sizes.src, out.mid, sizes.mid) && !overlaps(out.dst, sizes.dst, out.mid, sizes.mid);
  if (avoid.length) {
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
  }
  // The middle label stays on its cable: where the middle is taken, by the port names of this
  // cable or by the labels of others, it takes the free spot along the cable nearest the middle.
  // Only when the cable has none does it stand beside the line.
  const midSize = sizes.mid;
  if (midSize && out.mid && (!clearOf(out.mid, midSize) || !ownClear())) {
    const start = out.mid;
    const fits = (q: Point) => {
      out.mid = q;
      return clearOf(q, midSize) && ownClear();
    };
    /** The spots at a distance along the cable: on the line, or the two beside it. */
    const spots = (d: number, beside: boolean): Point[] => {
      const pt = at(snap(d));
      if (!beside) return [{ x: pt.x, y: pt.y }];
      return dirAt(snap(d)) === 'h'
        ? [{ x: pt.x, y: pt.y - midSize.h - 2 }, { x: pt.x, y: pt.y + midSize.h + 2 }]
        : [{ x: pt.x - midSize.w / 2 - 6, y: pt.y }, { x: pt.x + midSize.w / 2 + 6, y: pt.y }];
    };
    const search = (beside: boolean): boolean => {
      for (let k = 0; k <= 50 && k * 6 <= total / 2; k++) {
        for (const sign of k ? [1, -1] : [1]) {
          const d = total / 2 + sign * k * 6;
          if (k && (d < total * 0.12 || d > total * 0.88)) continue;
          if (spots(d, beside).some(fits)) return true;
        }
      }
      return false;
    };
    let found = search(false);
    // No room on the cable: the port names step to their closest spots on it, then it tries again.
    if (!found) {
      const keep = { src: out.src, dst: out.dst };
      if (sizes.dst && out.dst) out.dst = pos(dstMin, true, sizes.dst);
      if (!clearOf(out.dst, sizes.dst)) out.dst = keep.dst;
      found = out.dst !== keep.dst && search(false);
      if (!found) {
        out.dst = keep.dst;
        out.src = keep.src;
        found = search(true);
      }
    }
    // Nothing is free anywhere: beside the middle of the line, clear of this cable's own port names at least.
    if (!found) {
      out.mid = start;
      if (!ownClear()) {
        const tall = Math.max(sizes.src?.h ?? 0, sizes.dst?.h ?? 0);
        const wide = Math.max(sizes.src?.w ?? 0, sizes.dst?.w ?? 0);
        out.mid = dirAt(total / 2) === 'h' ? { x: start.x, y: start.y + tall / 2 + midSize.h / 2 + LABEL_GAP / 2 } : { x: start.x + wide / 2 + midSize.w / 2 + LABEL_GAP, y: start.y };
      }
    }
  }
  // A cable that is not drawn yet can measure as NaN; such positions are left out.
  const finite = (p?: Point) => (p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : undefined);
  return { src: finite(out.src), dst: finite(out.dst), mid: finite(out.mid) };
}
