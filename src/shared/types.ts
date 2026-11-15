/** Types shared by the scanner process, the main process and the renderer. */

import type { Observed } from './fingerprint/types';

export type Severity = 'low' | 'medium' | 'high';

/** Every device type, for code that checks values coming from data files. */
export const DEVICE_TYPES = [
  'router',
  'switch',
  'firewall',
  'ap',
  'server',
  'computer',
  'laptop',
  'phone',
  'tablet',
  'printer',
  'camera',
  'tv',
  'storage',
  'iot',
  'vm',
  'unknown',
] as const;

export type DeviceType = (typeof DEVICE_TYPES)[number];

export type PortProfile = 'top' | 'all' | 'custom' | 'none';
export type Timing = 'cautious' | 'balanced' | 'aggressive';

export interface ScanSettings {
  /** Raw target text: IPs, ranges, CIDR blocks or "localhost", separated by ';' ',' or whitespace. */
  targets: string;
  portProfile: PortProfile;
  /** Port list for the custom profile, e.g. "22,80,443,8000-8100". */
  customPorts: string;
  timing: Timing;
  resolveNames: boolean;
  /** Id of a network the devices found are added to, whatever ranges are scanned. */
  intoNetwork?: string;
}

export const DEFAULT_SETTINGS: ScanSettings = {
  targets: '',
  portProfile: 'top',
  customPorts: '',
  timing: 'balanced',
  resolveNames: true,
};

export interface OpenPort {
  port: number;
  service: string;
}

export interface RiskFinding {
  ruleId: string;
  severity: Severity;
  title: string;
  detail: string;
}

export type LivenessSource = 'tcp' | 'icmp' | 'arp';

/** Global (2000::/3), unique local (fc00::/7) or link-local (fe80::/10). */
export type Ipv6Scope = 'global' | 'unique-local' | 'link-local';

export interface Ipv6Address {
  address: string;
  scope: Ipv6Scope;
}
export type NameSource = 'dns' | 'mdns' | 'netbios';

/** Everything one scan learned about a single address. */
export interface DiscoveredHost {
  ip: string;
  mac?: string;
  /** Set when the MAC address came from a switch or router over SNMP, not from the scan itself. */
  macSource?: 'snmp';
  vendor?: string;
  hostname?: string;
  /** IPv6 addresses seen for the same MAC address, global first. */
  ipv6?: Ipv6Address[];
  names: { source: NameSource; name: string }[];
  aliveVia: LivenessSource[];
  rttMs?: number;
  ttl?: number;
  ports: OpenPort[];
  type: DeviceType;
  typeConfidence: number;
  os?: string;
  osConfidence?: number;
  /** Short human-readable reasons behind the type/OS guess. */
  evidence: string[];
  /** Version of the fingerprint rules that classified the device, e.g. "rules-1"; absent before v0.5.18. */
  fingerprint?: string;
  /** Evidence from the identify phase: announced services, device descriptions, web page, certificate, SSH greeting. */
  observed?: Observed;
  risks: RiskFinding[];
}

/** A host as stored in the inventory, across scans. */
/**
 * How the scanner recognises a network. `fingerprint` is the stable identity: the router's MAC
 * when it is known (`gw:<mac>`), the local subnet otherwise (`subnet:<cidr>`), or the scanned
 * range for networks this computer is not attached to (`range:<targets>`).
 */
export interface NetworkIdentity {
  fingerprint: string;
  /** Subnet in CIDR notation, or the scanned range for remote networks. */
  cidr: string;
  gatewayIp?: string;
  gatewayMac?: string;
  gatewayVendor?: string;
  /** True when this computer is attached to the network. */
  local: boolean;
}

/** A network stored in the inventory; every asset and scan belongs to exactly one. */
export interface Network {
  id: string;
  name: string;
  fingerprint: string;
  cidr: string;
  gatewayIp?: string;
  gatewayMac?: string;
  createdAt: string; // ISO 8601 UTC
  lastScanAt: string; // ISO 8601 UTC
}

export interface Asset extends DiscoveredHost {
  id: string;
  networkId: string;
  firstSeen: string; // ISO 8601 UTC
  lastSeen: string; // ISO 8601 UTC
  lastRunId: string;
  /** True when the asset was first seen in its most recent scan. */
  isNew: boolean;
}

export type ScanPhase = 'liveness' | 'names' | 'ports' | 'identify' | 'analysis' | 'done';

export interface ScanProgress {
  runId: string;
  phase: ScanPhase;
  done: number;
  total: number;
  live: number;
}

export interface ScanSummary {
  runId: string;
  /** Network the scan was saved to; absent on summaries from the scanner process itself. */
  networkId?: string;
  targets: string;
  startedAt: string;
  finishedAt: string;
  status: 'done' | 'cancelled' | 'failed';
  scanned: number;
  live: number;
  newAssets: number;
  openPorts: number;
  risks: number;
  /** True when devices answered but the OS returned an empty ARP table (MAC addresses withheld by the OS). */
  macHidden?: boolean;
  /** True when a local scan reached no device but this computer (the OS blocked local network traffic). */
  lanBlocked?: boolean;
  /** True when the scan was stopped because its network was deleted while it ran; nothing of it was saved. */
  discarded?: boolean;
}

export type ScanEvent =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'host'; runId: string; host: DiscoveredHost }
  /** Scanner → main: which network is being scanned. Sent before any host of the run. */
  | { type: 'network-identity'; runId: string; identity: NetworkIdentity }
  /** Main → UI: the inventory network a run is saved to. */
  | { type: 'network'; runId: string; network: Network }
  /** Main → UI: a network was dropped because its scan found no devices. */
  | { type: 'network-removed'; networkId: string }
  | { type: 'asset'; asset: Asset }
  | { type: 'done'; summary: ScanSummary }
  | { type: 'error'; runId: string; message: string };

export type WifiBand = '2.4' | '5' | '6';

export interface WifiChannel {
  number: number;
  band?: WifiBand;
  /** Channel width in MHz. */
  width?: number;
}

/** One access point (BSSID) seen in a Wi-Fi scan. */
export interface WifiNetwork {
  /** Network name; absent for hidden networks or without Location access on macOS. */
  ssid?: string;
  bssid?: string;
  vendor?: string;
  /** Signal strength in dBm. */
  rssi: number;
  noise?: number;
  channel?: WifiChannel;
  security: string[];
  /** Supported 802.11 modes, newest first: be, ax, ac, n, a, g, b. */
  phy: string[];
  /** Wi-Fi generation: 4 (n), 5 (ac), 6 (ax), 7 (be). */
  generation?: number;
}

export interface WifiConnection {
  interface: string;
  ssid?: string;
  bssid?: string;
  vendor?: string;
  rssi: number;
  noise?: number;
  channel?: WifiChannel;
  txRateMbps?: number;
  phy?: string;
  generation?: number;
  security?: string;
}

/** Location access, which macOS (and Windows 11) require before naming Wi-Fi networks. */
export type WifiLocation = 'authorized' | 'denied' | 'restricted' | 'not-determined' | 'not-required' | 'unknown';

export interface WifiReport {
  platform: string;
  scannedAt: string; // ISO 8601 UTC
  location: WifiLocation;
  poweredOn: boolean;
  connection?: WifiConnection;
  networks: WifiNetwork[];
  error?: string;
}

/** SNMP access configured for a network; the community itself never leaves the main process. */
export interface SnmpSettings {
  configured: boolean;
  version?: 'v2c';
  updatedAt?: string; // ISO 8601 UTC
}

/** One interface (port) of a managed device. */
/** Spanning tree state of a bridge port (BRIDGE-MIB), in the default instance. */
export type StpState = 'disabled' | 'blocking' | 'listening' | 'learning' | 'forwarding' | 'broken';

export interface GearInterface {
  ifIndex: number;
  /** Short name such as "gi16" or "eth0". */
  name: string;
  descr?: string;
  /** Description set by the administrator. */
  alias?: string;
  up: boolean;
  speedMbps?: number;
  /** True when the port is powering a device over Ethernet. */
  poe?: boolean;
  /** Power delivered on the port, when the device reports it. */
  poeWatts?: number;
  /** VLAN of untagged traffic on the port (PVID). */
  pvid?: number;
  /** VLANs the port carries with a tag (a trunk). */
  tagged?: number[];
  /** MAC address of the port itself. */
  mac?: string;
  /** Spanning tree state of the port, when the switch reports it. */
  stp?: StpState;
  /** Duplex the port negotiated (EtherLike-MIB), when the device reports it. */
  duplex?: Duplex;
}

export type Duplex = 'half' | 'full';

/** A VLAN configured on a managed switch. */
export interface GearVlan {
  id: number;
  name?: string;
}

/** System capabilities a neighbour announces over LLDP (IEEE 802.1AB); CDP capabilities are mapped onto them. */
export type LldpCapability = 'other' | 'repeater' | 'bridge' | 'wlanAccessPoint' | 'router' | 'telephone' | 'docsis' | 'station';

/** Neighbour discovery protocols a managed device reports neighbours from. */
export type NeighborProtocol = 'lldp' | 'cdp';

/** A device announced over LLDP or CDP on one of a managed device's ports. */
export interface GearNeighbor {
  /** Protocols the neighbour was heard on; one entry when both announce the same device. */
  protocols?: NeighborProtocol[];
  /** Hardware platform it announces over CDP, e.g. "cisco WS-C2960X-24PS-L". */
  platform?: string;
  /** Native (untagged) VLAN of its port, as it announces over CDP. */
  nativeVlan?: number;
  /** Duplex of its port, as it announces over CDP. */
  duplex?: Duplex;
  localIfIndex?: number;
  localPort: string;
  /** Chassis MAC address, when the chassis is identified by one. */
  chassisMac?: string;
  chassisId?: string;
  /** MAC address of the neighbour's port, when it identifies its port that way. */
  portMac?: string;
  /** Port name on the neighbour, e.g. "gi1/0/2" or "eth0". */
  remotePort?: string;
  sysName?: string;
  sysDescr?: string;
  mgmtIp?: string;
  /** Capabilities it has enabled, as it announces them. */
  capabilities?: LldpCapability[];
}

/** A MAC address a managed switch learned on one of its ports. */
export interface GearFdbEntry {
  mac: string;
  ifIndex?: number;
  vlan?: number;
  /** Manufacturer from the address, added when the reading is stored. */
  vendor?: string;
}

/** Everything read over SNMP from one managed device. */
export interface GearDevice {
  ip: string;
  sysName?: string;
  sysDescr?: string;
  sysObjectId?: string;
  uptimeSec?: number;
  /** Base MAC address of the bridge (switches). */
  mac?: string;
  interfaces: GearInterface[];
  neighbors: GearNeighbor[];
  fdb: GearFdbEntry[];
  /** Addresses the device itself talks to (its ARP table): IP to MAC. */
  arp: { ip: string; mac: string }[];
  /** VLANs configured on the device (802.1Q); ports carry their membership. */
  vlans?: GearVlan[];
  /** The device's own IPv4 addresses and the interface each one is on (routers: one per network). */
  addresses?: { ip: string; prefix: number; ifIndex: number }[];
  /** True when the device routes traffic between networks (IP forwarding on). */
  forwarding?: boolean;
  /** Number of bridge ports it reports: it switches frames, even when its MAC table reads empty. */
  bridgePorts?: number;
  /** The device's default route: where it sends traffic for other networks, and through which interface. */
  defaultRoute?: { nextHop?: string; ifIndex?: number };
  poe?: { budgetW?: number; usedW?: number };
  stpPriority?: number;
}

/** Result of reading a network's managed devices over SNMP. */
export interface GearSnapshot {
  networkId: string;
  collectedAt: string; // ISO 8601 UTC
  /** Addresses that were asked; `devices` lists the ones that answered. */
  probed: number;
  devices: GearDevice[];
  /** Inventory devices that got a MAC address (and vendor) from this reading. */
  macsFilled?: number;
}

/** Traffic on a managed device's port, averaged since the previous reading. */
export interface PortTraffic {
  ip: string;
  ifIndex: number;
  inBps: number;
  outBps: number;
}

export interface LocalTarget {
  iface: string;
  address: string;
  cidr: string;
  hosts: number;
}

export interface TargetParseResult {
  count: number;
  errors: string[];
  tooLarge: boolean;
}

export interface PingReply {
  /** 1-based position in the series. */
  seq: number;
  /** Round-trip time; undefined when the echo request timed out. */
  timeMs?: number;
}

export interface PingResult {
  ip: string;
  sent: number;
  received: number;
  replies: PingReply[];
  /** Packet loss, 0–100. */
  lossPct: number;
  minMs?: number;
  avgMs?: number;
  maxMs?: number;
}

/** State of the MAC vendor (OUI) database in use. */
/** How often the app looks for newer IEEE vendor lists on its own. */
export type VendorAutoCheck = 'daily' | 'weekly' | 'monthly' | 'off';

export interface VendorDbStatus {
  source: 'bundled' | 'downloaded';
  autoCheck: VendorAutoCheck;
  version: string;
  prefixes: number;
  updatedAt?: string; // ISO 8601 UTC, when a downloaded copy was installed
  lastCheckAt?: string; // ISO 8601 UTC
}

export interface VendorDbUpdateResult {
  updated: boolean;
  status: VendorDbStatus;
  message: string;
  /** True when devices in the inventory got a vendor from the new data. */
  inventoryChanged?: boolean;
}

export interface AppInfo {
  platform: NodeJS.Platform;
  version: string;
  /** True when the window is drawn without a graphics card (remote desktop, some virtual machines). */
  lowGraphics?: boolean;
}

/** How new versions arrive: downloaded in the background, or only announced. */
export type UpdateMode = 'auto' | 'notify';

/** Where the update check stands, as shown in Settings and the update banner. */
export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'checking' }
  | { kind: 'current'; checkedAt: string }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; version: string; percent: number }
  | { kind: 'ready'; version: string }
  | { kind: 'error'; message: string };

export interface UpdateStatus {
  mode: UpdateMode;
  /** Sends the anonymous usage count (install id, app version, operating system) with each check. */
  usageCount: boolean;
  /** The first-run notice about update checks and the usage count was dismissed. */
  noticeSeen: boolean;
  /** Set once after the app has updated: the previous version (when known) and the running one. */
  whatsNew: { from?: string; to: string } | null;
  state: UpdateState;
  /** Mac App Store build: new versions and their installation come from the App Store, and no usage count is sent. */
  appStore?: boolean;
}

import type { DhcpCheckResult, CheckStep, DnsLookup, DnsRecordType, LocalLink, MtuResult, PortCheck, PublicAddress, TraceEvent } from './diagnose';

/** API exposed to the renderer through the preload bridge. */
export interface BridgeApi {
  app: {
    info(): Promise<AppInfo>;
    /** Opens the list of third-party licences shipped with the app. */
    openAcknowledgements(): Promise<void>;
    openLocalNetworkSettings(): Promise<void>;
    /** Puts plain text on the system clipboard. */
    copyText(text: string): Promise<void>;
    /** Opens the licence terms of the app itself. */
    openLicense(): Promise<void>;
  };
  updates: {
    status(): Promise<UpdateStatus>;
    check(): Promise<UpdateStatus>;
    download(): Promise<void>;
    /** Quits, installs the downloaded version and starts it again. */
    install(): Promise<void>;
    setMode(mode: UpdateMode): Promise<UpdateStatus>;
    setUsageCount(on: boolean): Promise<UpdateStatus>;
    dismissNotice(): Promise<UpdateStatus>;
    dismissWhatsNew(): Promise<UpdateStatus>;
    onStatus(listener: (status: UpdateStatus) => void): () => void;
  };
  scan: {
    localTargets(): Promise<LocalTarget[]>;
    parseTargets(text: string): Promise<TargetParseResult>;
    start(settings: ScanSettings): Promise<{ runId: string }>;
    cancel(runId: string): Promise<void>;
    onEvent(listener: (event: ScanEvent) => void): () => void;
  };
  inventory: {
    list(): Promise<Asset[]>;
    remove(id: string): Promise<void>;
    clear(): Promise<void>;
    runs(): Promise<ScanSummary[]>;
    networks(): Promise<Network[]>;
    renameNetwork(id: string, name: string): Promise<Network>;
    /** Deletes a network with its devices and scan history. */
    removeNetwork(id: string): Promise<void>;
    /** Removes one scan from the recent scans list; devices and networks are kept. */
    removeRun(id: string): Promise<void>;
    exportCsv(ids?: string[]): Promise<string | null>;
  };
  wifi: {
    scan(): Promise<WifiReport>;
    /** Asks for Location access; resolves with the resulting state. */
    authorize(): Promise<WifiLocation>;
    openLocationSettings(): Promise<void>;
  };
  report: {
    /**
     * Prints a report (a full HTML document) to PDF. save: asks where to save it and resolves with
     * the path, or null if cancelled. preview: opens it in the system's PDF viewer.
     */
    pdf(html: string, suggestedName: string, mode: 'save' | 'preview'): Promise<string | null>;
    /** Shows a saved report in Finder or Explorer. */
    show(path: string): Promise<void>;
  };
  map: {
    /** Asks where to save an exported map image (PNG or SVG data URL); resolves with the path, or null if cancelled. */
    saveImage(dataUrl: string, suggestedName: string): Promise<string | null>;
    /** Saves a CSV list of devices and where they are connected; resolves with the path, or null. */
    saveCsv(csv: string, suggestedName: string): Promise<string | null>;
  };
  snmp: {
    settings(networkId: string): Promise<SnmpSettings>;
    /** Stores the community for a network, encrypted with the operating system's key store. */
    save(networkId: string, community: string): Promise<SnmpSettings>;
    clear(networkId: string): Promise<SnmpSettings>;
    /** Asks every device of the network over SNMP and stores what the answering devices report. */
    read(networkId: string): Promise<GearSnapshot>;
    snapshot(networkId: string): Promise<GearSnapshot | null>;
    /** Port traffic on the network's managed devices since the previous call. */
    traffic(networkId: string): Promise<PortTraffic[]>;
  };
  vendors: {
    status(): Promise<VendorDbStatus>;
    update(): Promise<VendorDbUpdateResult>;
    setAutoCheck(every: VendorAutoCheck): Promise<VendorDbStatus>;
  };
  actions: {
    /** Opens ssh://user@ip in the system's default SSH handler. */
    ssh(ip: string, user: string): Promise<void>;
    web(ip: string, secure: boolean): Promise<void>;
    remoteDesktop(ip: string): Promise<void>;
    ping(ip: string): Promise<PingResult>;
  };
  diagnose: {
    /** This computer's connection and the first step of the connectivity check. */
    local(): Promise<{ link: LocalLink; step: CheckStep }>;
    gateway(ip: string): Promise<CheckStep>;
    dns(servers: string[]): Promise<CheckStep>;
    internet(): Promise<CheckStep>;
    /** Public IPv4/IPv6 addresses and reverse name; undefined without an answer. */
    publicAddress(): Promise<PublicAddress | undefined>;
    /** Checks one service the customer relies on: a host, host:port or web address. */
    service(target: string): Promise<CheckStep>;
    /** Starts a traceroute; progress arrives through onTrace. */
    trace(id: string, target: string): Promise<void>;
    cancelTrace(id: string): Promise<void>;
    /** One echo request, for the live ping chart. */
    pingOnce(target: string): Promise<{ alive: boolean; rttMs?: number }>;
    /** Connects to each listed port ("22, 80, 443" or "5060-5070") of one host. */
    ports(host: string, ports: string): Promise<PortCheck>;
    /** Looks a name up (or an address, in reverse) on the network's DNS servers and a public one. */
    dnsLookup(name: string, type: DnsRecordType): Promise<DnsLookup>;
    /** Largest packet that reaches the target without being fragmented. */
    mtu(target: string): Promise<MtuResult>;
    /** Asks for an address (without taking one) and lists every DHCP server that offers. */
    dhcp(): Promise<DhcpCheckResult>;
    onTrace(listener: (event: TraceEvent) => void): () => void;
  };
}
