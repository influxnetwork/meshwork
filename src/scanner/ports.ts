/** TCP port lists and service names used by the scanner. */

/** Well-known service names for ports the app reports. */
export const SERVICE_NAMES: Record<number, string> = {
  20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'dns', 67: 'dhcp', 69: 'tftp',
  80: 'http', 81: 'http-alt', 88: 'kerberos', 102: 's7', 110: 'pop3', 111: 'rpcbind', 119: 'nntp',
  123: 'ntp', 135: 'msrpc', 137: 'netbios-ns', 139: 'netbios', 143: 'imap', 161: 'snmp', 179: 'bgp',
  389: 'ldap', 427: 'slp', 443: 'https', 444: 'https-alt', 445: 'smb', 465: 'smtps', 500: 'isakmp',
  502: 'modbus', 503: 'modbus-alt', 515: 'lpd', 548: 'afp', 554: 'rtsp', 587: 'submission',
  623: 'ipmi', 631: 'ipp', 636: 'ldaps', 873: 'rsync', 902: 'vmware-auth', 993: 'imaps', 995: 'pop3s',
  1080: 'socks', 1194: 'openvpn', 1433: 'mssql', 1521: 'oracle', 1723: 'pptp', 1883: 'mqtt',
  1900: 'upnp', 2000: 'cisco-sccp', 2049: 'nfs', 2082: 'cpanel', 2083: 'cpanel-ssl', 2375: 'docker',
  2376: 'docker-tls', 2379: 'etcd', 3000: 'http-dev', 3128: 'proxy', 3260: 'iscsi', 3306: 'mysql',
  3389: 'rdp', 3478: 'stun', 3689: 'daap', 4433: 'https-alt', 4443: 'https-alt', 4840: 'opc-ua',
  5000: 'upnp/http', 5001: 'https-alt', 5060: 'sip', 5061: 'sips', 5222: 'xmpp', 5353: 'mdns',
  5357: 'wsd', 5432: 'postgres', 5601: 'kibana', 5672: 'amqp', 5683: 'coap', 5900: 'vnc',
  5901: 'vnc-1', 5985: 'winrm', 5986: 'winrm-tls', 6000: 'x11', 6379: 'redis', 6443: 'kube-api',
  6667: 'irc', 7000: 'airplay', 7001: 'http-alt', 7100: 'airplay-alt', 7547: 'tr-069', 8000: 'http-alt',
  8006: 'proxmox', 8008: 'http-alt', 8009: 'cast', 8080: 'http-proxy', 8081: 'http-alt',
  8086: 'influxdb', 8088: 'http-alt', 8123: 'home-assistant', 8200: 'vault', 8291: 'winbox',
  8443: 'https-alt', 8500: 'consul', 8554: 'rtsp-alt', 8728: 'routeros-api', 8883: 'mqtt-tls',
  8888: 'http-alt', 9000: 'http-alt', 9090: 'http-alt', 9091: 'http-alt', 9100: 'jetdirect',
  9200: 'elasticsearch', 9443: 'https-alt', 10000: 'webmin', 10250: 'kubelet', 11211: 'memcached',
  27017: 'mongodb', 32400: 'plex', 49152: 'upnp-dyn', 62078: 'iphone-sync',
};

/**
 * Default "top" profile: ports that identify common devices and services on business and
 * home networks. Ordered roughly by how often they answer.
 */
export const TOP_PORTS: number[] = [
  80, 443, 22, 445, 139, 135, 3389, 8080, 53, 21, 23, 25, 110, 143, 993, 995, 587, 465,
  8443, 8000, 8008, 8081, 8888, 9000, 9090, 9091, 3000, 5000, 5001, 7000, 7100, 3689, 548,
  62078, 49152, 1900, 5357, 515, 631, 9100, 554, 8554, 1883, 8883, 5683, 8123, 32400, 8009,
  161, 179, 389, 636, 88, 111, 2049, 873, 3260, 902, 8006, 623, 5985, 5986, 5900, 5901,
  1433, 1521, 3306, 5432, 6379, 27017, 9200, 5601, 11211, 2375, 2376, 2379, 6443, 10250,
  8200, 8500, 5672, 1080, 3128, 1194, 1723, 500, 5060, 5061, 2000, 8291, 8728, 7547, 10000,
  2082, 2083, 4443, 4433, 444, 81, 7001, 8086, 102, 502, 503, 4840, 6000, 119, 427, 5222,
];

export function serviceName(port: number): string {
  return SERVICE_NAMES[port] ?? 'unknown';
}

/** Parses "22,80,443,8000-8100" into a sorted, de-duplicated list of valid ports. */
export function parsePortList(text: string): number[] {
  const out = new Set<number>();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a port or port range`);
    const from = Number(m[1]);
    const to = m[2] ? Number(m[2]) : from;
    if (from < 1 || to > 65535 || to < from) throw new Error(`"${part}" is outside 1-65535`);
    for (let p = from; p <= to; p++) out.add(p);
  }
  return [...out].sort((a, b) => a - b);
}

export function allPorts(): number[] {
  return Array.from({ length: 65535 }, (_, i) => i + 1);
}

/** Ports probed during liveness detection: a host answering on any of them is up. */
export const LIVENESS_PORTS = [80, 443, 22, 445, 139, 3389, 62078, 7000, 5000, 8080, 9100, 554, 53, 548];
