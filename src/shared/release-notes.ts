/** What changed in each version, newest first. Shown once after the app updates to that version. */
export interface ReleaseNote {
  version: string;
  notes: string[];
}

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    version: '0.5.20',
    notes: [
      'Loops on the map: a second cable between switches is drawn as a redundant link, dotted, with what spanning tree does on it and which port it blocks. A ring with no blocked port raises a warning.',
      'Managed networks draw more accurately: a router or switch with several addresses appears once, the gateway of a remote network is found more reliably, and more switches report their VLANs, their ports (including names like 1/1/28) and the devices they talk to.',
      'Devices announced over LLDP get their type, such as switch, access point, phone or router, even when their description is not recognised. IP desk phones are recognised as phones.',
      'Live traffic no longer drops to zero between refreshes on switches that update their counters slowly, and a device that stops answering stops showing traffic.',
      'A scan can be removed from Recent scans, keeping its devices and networks. A device counts as new only in the scan that first found it.',
    ],
  },
  {
    version: '0.5.19',
    notes: [
      'Scans now ask devices what they are: services they announce on the network, camera and media discovery, web page titles, certificates and SSH greetings. Many devices that showed as Unknown now get their type, often with the model they report.',
      'A device’s details list the evidence behind its type, and Copy details includes it.',
      'Device types come from fingerprint rules version 2. Every device keeps at least the confidence it had before, and a device that answers badly can no longer slow down or stop a scan.',
    ],
  },
  {
    version: '0.5.18',
    notes: [
      'Diagnose shows the public IPv4 and IPv6 addresses of the network and its internet provider when you run “Network or provider?”, ready to copy. The site visit report includes them.',
      'On the map, devices behind an access point carry a Wi-Fi mark that explains why their own traffic is not shown.',
      'Device types now come from a set of fingerprint rules that Meshwork can grow over time. Results are the same as before, and Copy details shows which rules version classified each device.',
    ],
  },
  {
    version: '0.5.17',
    notes: [
      'Stop ends a scan at once, even in the middle of a full port scan.',
      'Scanning all ports is up to three times faster: each device gets a wait that fits how fast it answers, and a device behind a firewall no longer holds up the others.',
      'The progress bar moves with every port checked, and choosing all ports tells you how long it can take.',
    ],
  },
  {
    version: '0.5.16',
    notes: [
      'Smoother map: moving and zooming stay fluid on large maps, and over remote desktop Meshwork switches to a lighter drawing mode.',
      'Live traffic reaches groups: the cable to a group moves while a device inside it is busy, and that device’s port badge pulses.',
      'Virtualization hosts: a server running virtual machines (Proxmox, VMware, Hyper-V, KVM and others) shows on its switch port with its virtual machines grouped under it, instead of as an unmanaged segment.',
      'Copy details in a device’s drawer copies everything Meshwork knows about it as text, ready for a ticket or your notes.',
      'Fast scans ask again for devices left without a MAC address, and a scan that cannot read MAC addresses no longer splits a network in two or drops the ones already known.',
    ],
  },
  {
    version: '0.5.15',
    notes: [
      'Device details show the type a device announces about itself, and HPE access points are no longer taken for printers.',
      'UniFi gateways and consoles, and other network gear that answers DNS, are recognised as gateways instead of access points.',
      'The “what changed” notice fits the window when it covers several versions.',
    ],
  },
  {
    version: '0.5.14',
    notes: [
      'Map labels no longer cover each other: a port name slides along its cable, or beside it, to stay clear of other cables’ labels.',
      'VLAN counts include every device on the network, also in the infrastructure view, and device names inside groups have more room.',
      'Before the first scan, Meshwork asks you to confirm you own the network or are authorised to assess it.',
    ],
  },
  {
    version: '0.5.13',
    notes: [
      'Clearer maps: three or more devices of the same kind on one switch (access points, for example) share one card, and each still shows its port, PoE and VLAN. Long rows of devices split into two staggered rows.',
      'Every device on the map opens its details, including devices only a switch has seen, with where it is plugged in: switch port, VLAN, PoE and the path to the gateway.',
      'Device details show the model and firmware that switches and access points report, and the name they announce.',
      'Links stay solid while live traffic runs, so they are no longer mistaken for assumed links, and port labels stay closer to their device.',
    ],
  },
  {
    version: '0.5.12',
    notes: [
      'Site visit report: export a PDF from Map with your own logo and company name, findings with what to do, the network map, connectivity checks, the device inventory and a sign-off page. Every section is optional.',
      'DHCP servers (beta): when a second server answers, Meshwork tells you which switch port it is plugged into and shows it on the map, using the switches read over SNMP.',
      'Map warns about network loops: a switch that hears itself on two ports, with the ports to unplug.',
      'Live ping shows each echo’s time and value when you point at the chart, and Stop now keeps the chart as it is.',
    ],
  },
  {
    version: '0.5.11',
    notes: [
      'New Diagnose module: find out whether a problem is the local network, DNS, the provider or one service, and trace the route to any host.',
      'Diagnose quick tests: live ping, port test, DNS lookup compared with a public server, path MTU and a check for extra DHCP servers.',
      'Modules follow the order of a site visit: Discover, Network Inventory, Map, Diagnose, WiFi (Cmd/Ctrl+1 to 5).',
      'Settings are organised in tabs, and Discover explains what each scan speed trades off.',
    ],
  },
  {
    version: '0.5.10',
    notes: [
      'Exported device lists keep the order shown on screen; exporting from the menu sorts them by IP address.',
      'Maps leave more room under busy switches and routers, so every link runs in its own lane, and the outermost links leave from the sides.',
    ],
  },
  {
    version: '0.5.9',
    notes: ['Updates install in the background: Restart to update reopens Meshwork on the new version, with no installer screens.'],
  },
  {
    version: '0.5.8',
    notes: ['After each update, Meshwork now shows what changed in the new version.'],
  },
  {
    version: '0.5.7',
    notes: [
      'Meshwork checks for new versions and can install them for you. Choose how in Settings → Updates.',
      'The Windows installer shows the licence agreement.',
    ],
  },
];

/** Compares dotted version numbers part by part: negative when a is older, positive when newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Notes for the versions after `from` up to and including `to`, newest first. Without `from`
 * (the previous version is unknown) only the notes for `to` are returned.
 */
export function notesSince(from: string | undefined, to: string, all: ReleaseNote[] = RELEASE_NOTES): ReleaseNote[] {
  return all
    .filter((n) => compareVersions(n.version, to) <= 0 && (from ? compareVersions(n.version, from) > 0 : n.version === to))
    .sort((a, b) => compareVersions(b.version, a.version));
}
