/**
 * Touches the local network from the app's main process so macOS registers the app for
 * Local Network access and shows its permission prompt. The scanner runs in a helper process
 * and spawns system tools; macOS only lists and prompts for the app bundle when the main
 * executable itself sends traffic to the LAN.
 */
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';

const MDNS_GROUP = '224.0.0.251';
const MDNS_PORT = 5353;

/** DNS query for `_services._dns-sd._udp.local` PTR, the standard service-browse question. */
function serviceBrowseQuery(): Buffer {
  const labels = ['_services', '_dns-sd', '_udp', 'local'];
  const name = Buffer.concat([
    ...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')])),
    Buffer.from([0]),
  ]);
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  const question = Buffer.from([0, 12, 0, 1]); // type PTR, class IN
  return Buffer.concat([header, name, question]);
}

/** Directed broadcast addresses of the active IPv4 interfaces. */
function broadcastAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.push(ip.map((o, i) => (o | (~(mask[i] ?? 255) & 255)) & 255).join('.'));
    }
  }
  return out;
}

/**
 * Sends one mDNS browse query and a broadcast probe. Resolves once the packets are sent or
 * after a short timeout; never rejects, because a denied permission must not block a scan.
 */
export function requestLocalNetworkAccess(): Promise<void> {
  if (process.platform !== 'darwin') return Promise.resolve();
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve();
    };
    const timer = setTimeout(finish, 1500);
    socket.on('error', finish);
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // broadcast not permitted on this socket; mDNS still goes out
      }
      const query = serviceBrowseQuery();
      const targets = [MDNS_GROUP, ...broadcastAddresses()];
      let pending = targets.length;
      for (const host of targets) {
        socket.send(query, MDNS_PORT, host, () => {
          if (--pending === 0) setTimeout(finish, 300);
        });
      }
    });
  });
}
