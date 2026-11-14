/**
 * Reference device classifier written as plain code. The parity tests compare the fingerprint
 * engine against it on generated devices; it is not used by the app.
 */
import { isVirtualMac } from '../../src/shared/model';
import type { DeviceType, DiscoveredHost } from '../../src/shared/types';

export interface ReferenceClassification {
  type: DeviceType;
  typeConfidence: number;
  os?: string;
  osConfidence?: number;
  evidence: string[];
}

const has = (host: DiscoveredHost, ...ports: number[]) => ports.some((p) => host.ports.some((o) => o.port === p));
const vendorMatches = (host: DiscoveredHost, re: RegExp) => !!host.vendor && re.test(host.vendor);
const nameMatches = (host: DiscoveredHost, re: RegExp) =>
  [host.hostname, ...host.names.map((n) => n.name)].some((n) => !!n && re.test(n));

const NETWORK_VENDOR = /cisco|juniper|aruba|ubiquiti|mikrotik|routerboard|netgear|tp-?link|d-?link|zyxel|huawei|arista|extreme networks|ruckus|meraki|cambium|draytek|edgecore|h3c|ruijie|tenda|asustek|linksys|eero|plume/i;
const FIREWALL_VENDOR = /fortinet|palo alto|sonicwall|watchguard|check point|sophos|barracuda|netgate/i;
const AP_VENDOR = /ruckus|aruba|cambium|ubiquiti|eero|plume/i;
// HP printers come from HP Inc. (and the older Hewlett-Packard); Hewlett Packard Enterprise makes servers and network gear.
const PRINTER_VENDOR = /hewlett[\s-]*packard(?![\s-]*enterprise)|hp inc|brother|epson|canon|lexmark|xerox|ricoh|kyocera|konica|sharp|\boki\b/i;
const CAMERA_VENDOR = /hikvision|dahua|axis comm|reolink|amcrest|uniview|hanwha|vivotek|mobotix|wyze/i;
const NAS_VENDOR = /synology|qnap|western digital|asustor|buffalo|netapp|terramaster/i;
const IOT_VENDOR = /espressif|tuya|shelly|allterco|raspberry|signify|philips lighting|ecobee|nest labs|ring llc|amazon technologies|sonoff|itead|xiaomi|wiz connected|lifx|meross/i;
const TV_VENDOR = /roku|sonos|vizio|tcl|hisense|lg electronics|samsung electronics|sony|bose|nvidia/i;


/**
 * Guesses device type and OS from open ports, MAC vendor, names and TTL.
 * Every rule that fires adds a line to `evidence` so the UI can explain the guess.
 */
export function referenceClassify(host: DiscoveredHost, gatewayIps: string[] = []): ReferenceClassification {
  // Reasons are kept per candidate so only the ones behind the final guess are reported.
  const typeWhy = new Map<DeviceType, string[]>();
  const osWhy = new Map<string, string[]>();
  // Declared without narrowing: the setters below reassign these from closures.
  let type = 'unknown' as DeviceType;
  let typeConfidence = 0;
  let os: string | undefined;
  let osConfidence: number | undefined;

  const setType = (t: DeviceType, c: number, why: string) => {
    if (c > typeConfidence) {
      type = t;
      typeConfidence = c;
    }
    typeWhy.set(t, [...(typeWhy.get(t) ?? []), why]);
  };
  const setOs = (o: string, c: number, why: string) => {
    if (c > (osConfidence ?? 0)) {
      os = o;
      osConfidence = c;
    }
    osWhy.set(o, [...(osWhy.get(o) ?? []), why]);
  };

  const apple = vendorMatches(host, /^apple/i);
  const mac = host.mac?.toLowerCase() ?? '';
  const isGateway = gatewayIps.includes(host.ip);

  if (isVirtualMac(mac, host.vendor)) setType('vm', 0.85, 'MAC belongs to a virtual machine network card');
  if (has(host, 9100, 631, 515)) setType('printer', 0.9, 'printing ports are open');
  else if (vendorMatches(host, PRINTER_VENDOR) && has(host, 80, 443)) setType('printer', 0.7, 'printer vendor with a web page');
  if (has(host, 554, 8554) || vendorMatches(host, CAMERA_VENDOR)) setType('camera', 0.85, 'video streaming port or camera vendor');
  if (vendorMatches(host, NAS_VENDOR) || (has(host, 5000) && has(host, 5001) && has(host, 445)))
    setType('storage', 0.8, 'storage vendor or storage management ports');
  if (has(host, 1883, 8883, 5683, 8123) || vendorMatches(host, IOT_VENDOR)) setType('iot', 0.65, 'IoT protocol port or IoT vendor');
  if (has(host, 8009) || (vendorMatches(host, TV_VENDOR) && !has(host, 22, 445)))
    setType('tv', 0.6, 'media casting port or media vendor');

  if (vendorMatches(host, FIREWALL_VENDOR)) {
    setType('firewall', 0.85, 'firewall vendor');
    setOs('Network OS', 0.6, 'network equipment vendor');
  } else if (vendorMatches(host, NETWORK_VENDOR) || has(host, 8291, 8728)) {
    // A device that serves DNS is a gateway or router (UniFi consoles, for example), even from a maker
    // best known for access points: access points do not answer DNS.
    if (isGateway || has(host, 53, 8291, 8728)) setType('router', 0.8, has(host, 53) && !isGateway ? 'network vendor serving DNS' : 'network vendor acting as gateway');
    else if (vendorMatches(host, AP_VENDOR)) setType('ap', 0.7, 'wireless equipment vendor');
    else setType('switch', 0.6, 'network vendor with management ports');
    setOs('Network OS', 0.6, 'network equipment vendor');
  } else if (isGateway && has(host, 53, 80, 443)) {
    setType('router', 0.7, 'default gateway serving DNS or a web page');
  }

  if (has(host, 62078)) {
    const tablet = nameMatches(host, /ipad/i);
    setType(tablet ? 'tablet' : 'phone', 0.85, 'device sync port used by iPhone and iPad');
    setOs(tablet ? 'iPadOS' : 'iOS', 0.85, 'device sync port');
  }
  if (nameMatches(host, /iphone|android|galaxy|pixel/i)) setType('phone', 0.75, 'phone-like device name');

  if ((has(host, 135) && has(host, 445)) || has(host, 3389, 5985)) {
    setType(has(host, 1433, 389, 88) ? 'server' : 'computer', 0.75, 'Windows RPC, file sharing or remote desktop ports');
    setOs('Windows', host.ttl && host.ttl > 64 && host.ttl <= 128 ? 0.9 : 0.75, 'Windows service ports');
  }
  if (apple && !has(host, 62078) && (has(host, 548, 7000, 5900, 22, 445) || nameMatches(host, /mac/i))) {
    const laptop = nameMatches(host, /macbook/i);
    setType(laptop ? 'laptop' : 'computer', 0.75, 'Apple device with desktop services');
    setOs('macOS', 0.75, 'Apple device with file sharing, AirPlay or remote login');
  }
  if (nameMatches(host, /macbook|laptop|thinkpad|latitude|xps|surface|zenbook|yoga/i)) setType('laptop', 0.76, 'laptop-like device name');

  if (type === 'unknown' && has(host, 22) && has(host, 80, 443, 3306, 5432, 6379, 8080, 9000, 27017)) {
    setType('server', 0.55, 'remote login plus web or database services');
  }
  if (!os && host.ttl) {
    if (host.ttl <= 64) setOs('Linux / Unix-like', 0.35, `reply TTL ${host.ttl} suggests a Unix-like system`);
    else if (host.ttl <= 128) setOs('Windows', 0.4, `reply TTL ${host.ttl} suggests Windows`);
    else setOs('Network OS', 0.4, `reply TTL ${host.ttl} suggests network equipment`);
  }
  if (type === 'server' && !os && has(host, 22)) setOs('Linux / Unix-like', 0.5, 'remote login service');

  const evidence = [...(typeWhy.get(type) ?? []), ...(os ? (osWhy.get(os) ?? []) : [])];
  return { type, typeConfidence, os, osConfidence, evidence: [...new Set(evidence)] };
}

export function referenceNeighbourType(sysName?: string, sysDescr?: string): DeviceType {
  const s = `${sysName ?? ''} ${sysDescr ?? ''}`;
  // UniFi OS consoles and gateways (Dream Machine, Cloud Gateway) run a kernel tagged "ui-alpine" or name themselves.
  if (/ui-alpine|unifi os|dream machine|cloud gateway|\bud[mr]\b|\bu[cx]g\b/i.test(s)) return 'router';
  if (/access point|\bap\d|wi-?fi|wireless|wlan/i.test(s)) return 'ap';
  if (/switch|\bgs\d{3}|\bsg\d{3}|catalyst|procurve/i.test(s)) return 'switch';
  if (/router|gateway|firewall/i.test(s)) return 'router';
  if (/phone|voip/i.test(s)) return 'phone';
  return 'unknown';
}

