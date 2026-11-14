/**
 * Model and firmware of a network device, read from the description it gives over SNMP or LLDP
 * (sysDescr). Descriptions follow no standard, so this recognises the common shapes and returns
 * nothing rather than a wrong guess.
 */

export interface DeviceModel {
  model?: string;
  firmware?: string;
}

/** Patterns that name the model, tried in order; the first capture group is the model. */
const MODEL_PATTERNS: RegExp[] = [
  // "ArubaOS (MODEL: 2930F-24G-PoE+-4SFP), Version …", "Model: X"
  /\bmodel\s*[:=]\s*([^,;)]+)/i,
  // Cisco IOS: "Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), …"
  /\bCisco IOS(?: XE)? Software,\s*(?:\[[^\]]*\]\s*,?\s*)?([A-Z0-9][\w-]+) Software/i,
  // Cisco Business / Small Business: "CBS350-48FP-4G 48-Port Gigabit PoE Managed Switch", "SG350-28P …"
  /^\s*((?:CBS|SG|SF|SX|CBW|C\d{4})[\w-]*\d[\w-]*)/,
  // MikroTik: "RouterOS CRS328-24P-4S+"
  /\bRouterOS\s+([A-Z]{2,4}[\w+-]*\d[\w+-]*)/,
  // HPE / Aruba OfficeConnect, Instant On: "HPE OfficeConnect Switch 1820 24G J9980A, PT.02.11 …"
  /\b((?:OfficeConnect|Instant On)[^,;]*\d[^,;]*)/i,
  // Ubiquiti: "UniFi … USW-24-PoE", "UAP-AC-Pro", "US-8-60W"
  /\b(U(?:SW|AP|DM|XG|S|6)-[\w-]+)/,
  // Netgear: "GS108Tv3", "GS724TP", "MS510TX"
  /\b((?:GS|GSM|GC|MS|XS|JGS)\d{3}[A-Z\d]*(?:v\d)?)\b/,
  // Juniper: "Juniper Networks, Inc. ex2300-24p Ethernet Switch"
  /\bJuniper Networks, Inc\.\s+([a-z]{2,4}\d[\w-]*)/i,
];

/** Patterns that name the firmware or software version. */
const FIRMWARE_PATTERNS: RegExp[] = [/\bVersion\s+([\w.()-]*\d[\w.()-]*)/i, /\bfirmware\s*[:=]?\s*v?(\d[\w.-]*)/i, /,\s*((?:[A-Z]{1,3}\.)?\d+\.\d+[\w.-]*)/];

/** Model and firmware from a device description; fields are left out when not recognised. */
export function parseDeviceModel(description?: string): DeviceModel {
  const d = description?.replace(/\s+/g, ' ').trim();
  if (!d) return {};
  const out: DeviceModel = {};
  // UniFi OS consoles describe only their Linux kernel; its "ui-alpine" tag names the family.
  if (/ui-alpine/i.test(d)) out.model = 'UniFi OS console';
  for (const p of out.model ? [] : MODEL_PATTERNS) {
    const m = p.exec(d)?.[1]?.trim();
    if (m && m.length >= 3 && m.length <= 60) {
      out.model = m;
      break;
    }
  }
  for (const p of FIRMWARE_PATTERNS) {
    const m = p.exec(d)?.[1]?.replace(/[,.]$/, '');
    if (m && m.length <= 40) {
      out.firmware = m;
      break;
    }
  }
  return out;
}

/**
 * MAC prefixes given to virtual machine network cards: Proxmox, VMware, Hyper-V, QEMU/KVM, Xen,
 * VirtualBox and Parallels.
 */
const VM_MAC_PREFIXES = ['bc:24:11', '00:50:56', '00:0c:29', '00:05:69', '00:1c:14', '00:15:5d', '52:54:00', '00:16:3e', '08:00:27', '00:1c:42'];
const VM_VENDOR = /proxmox|vmware|qemu|xensource|virtualbox|parallels/i;

/** True when a MAC address belongs to a virtual machine, by its prefix or its registered maker. */
export function isVirtualMac(mac: string | undefined, vendor?: string): boolean {
  const m = mac?.toLowerCase() ?? '';
  return VM_MAC_PREFIXES.some((p) => m.startsWith(p)) || (!!vendor && VM_VENDOR.test(vendor));
}
