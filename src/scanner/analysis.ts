import { classifyHost, type HostClassification } from '@shared/fingerprint';
import { readFileSync } from 'node:fs';
import type { DeviceType, DiscoveredHost, RiskFinding } from '@shared/types';

/* ------------------------------------------------------------------ vendors */

/** MAC prefix (first three bytes) to organisation name. */
export class VendorDb {
  constructor(private readonly prefixes: Record<string, string>) {}

  static fromFile(path: string): VendorDb {
    try {
      return new VendorDb(JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>);
    } catch {
      return new VendorDb({});
    }
  }

  get size(): number {
    return Object.keys(this.prefixes).length;
  }

  /**
   * Returns the vendor for a MAC, or "Private address" when the address is locally administered
   * (phones and laptops randomise their MAC per network, so no vendor applies).
   */
  lookup(mac: string | undefined): string | undefined {
    if (!mac) return undefined;
    const hex = mac.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (hex.length < 6) return undefined;
    // Smaller blocks are carved out of larger ones: the most specific assignment wins.
    const known = this.prefixes[hex.slice(0, 9)] ?? this.prefixes[hex.slice(0, 7)] ?? this.prefixes[hex.slice(0, 6)];
    if (known) return known;
    const firstByte = parseInt(hex.slice(0, 2), 16);
    if ((firstByte & 0b10) !== 0) return 'Private address';
    return undefined;
  }
}

/* ----------------------------------------------------------- classification */

export type Classification = HostClassification;

/**
 * Guesses device type and OS from open ports, MAC vendor, names and TTL, with the device
 * fingerprint rules. Every rule that fires adds its reason so the UI can explain the guess.
 */
export function classify(host: DiscoveredHost, gatewayIps: string[] = []): Classification {
  return classifyHost(host, gatewayIps);
}

/* -------------------------------------------------------------------- risks */

const has = (host: DiscoveredHost, ...ports: number[]) => ports.some((p) => host.ports.some((o) => o.port === p));

interface RiskRule {
  id: string;
  severity: RiskFinding['severity'];
  title: string;
  detail: string;
  applies(host: DiscoveredHost): boolean;
}

const MANAGED_TYPES: DeviceType[] = ['router', 'switch', 'firewall', 'ap', 'printer', 'camera', 'storage'];

export const RISK_RULES: RiskRule[] = [
  {
    id: 'telnet-open',
    severity: 'high',
    title: 'Telnet is enabled',
    detail: 'Port 23 sends logins and commands in clear text. Turn Telnet off and use SSH instead.',
    applies: (h) => has(h, 23),
  },
  {
    id: 'docker-api-open',
    severity: 'high',
    title: 'Container engine API is reachable without TLS',
    detail: 'Port 2375 gives full control of the host to anyone who can reach it. Disable it or require TLS.',
    applies: (h) => has(h, 2375),
  },
  {
    id: 'rdp-open',
    severity: 'medium',
    title: 'Remote desktop is reachable',
    detail: 'Port 3389 accepts connections from this network. Limit it to admin subnets or require a VPN.',
    applies: (h) => has(h, 3389),
  },
  {
    id: 'vnc-open',
    severity: 'medium',
    title: 'Screen sharing (VNC) is reachable',
    detail: 'VNC often uses weak passwords. Restrict who can reach it or tunnel it over SSH or a VPN.',
    applies: (h) => has(h, 5900, 5901),
  },
  {
    id: 'ftp-open',
    severity: 'medium',
    title: 'FTP is enabled',
    detail: 'FTP sends passwords in clear text. Use SFTP or FTPS instead.',
    applies: (h) => has(h, 21),
  },
  {
    id: 'database-open',
    severity: 'medium',
    title: 'Database or cache is reachable on the network',
    detail: 'A data store answers on this network. Make sure authentication is on and only app servers can reach it.',
    applies: (h) => has(h, 6379, 27017, 9200, 11211, 3306, 5432, 1433),
  },
  {
    id: 'ipmi-open',
    severity: 'medium',
    title: 'Server management (IPMI) is reachable',
    detail: 'Out-of-band management should live on a separate, restricted network.',
    applies: (h) => has(h, 623),
  },
  {
    id: 'tr069-open',
    severity: 'medium',
    title: 'Remote management (TR-069) is reachable',
    detail: 'Port 7547 lets a provider manage this device. It should not be reachable from user networks.',
    applies: (h) => has(h, 7547),
  },
  {
    id: 'smb-open',
    severity: 'low',
    title: 'File sharing (SMB) is reachable',
    detail: 'Check that shares require a password and that SMBv1 is disabled.',
    applies: (h) => has(h, 445),
  },
  {
    id: 'mqtt-plain',
    severity: 'low',
    title: 'MQTT without encryption',
    detail: 'Port 1883 carries IoT messages in clear text. Prefer MQTT over TLS (8883) with authentication.',
    applies: (h) => has(h, 1883),
  },
  {
    id: 'http-admin',
    severity: 'low',
    title: 'Management page without HTTPS',
    detail: 'The device serves its web page only over HTTP, so admin passwords travel unencrypted.',
    applies: (h) => MANAGED_TYPES.includes(h.type) && has(h, 80) && !has(h, 443, 8443),
  },
];

export function evaluateRisks(host: DiscoveredHost): RiskFinding[] {
  const order = { high: 0, medium: 1, low: 2 };
  return RISK_RULES.filter((r) => r.applies(host))
    .map(({ id, severity, title, detail }) => ({ ruleId: id, severity, title, detail }))
    .sort((a, b) => order[a.severity] - order[b.severity]);
}
