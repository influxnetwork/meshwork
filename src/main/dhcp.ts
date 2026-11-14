/**
 * DHCP server detection: broadcasts one DISCOVER from a random, locally administered MAC and
 * collects every OFFER for a few seconds. No REQUEST is ever sent, so no address is leased.
 *
 * Offers normally arrive on UDP port 68. When the system's own DHCP client holds that port, the
 * request is sent the way a relay agent would, with this computer's address as the relay, so
 * servers answer on port 67 instead. Some home routers ignore relayed requests, so that mode can
 * miss them; the result says which mode was used.
 */
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { readArpTable } from '../scanner/probes';

const MAGIC = 0x63825363;

/** One DHCP server that answered. */
export interface DhcpOffer {
  /** Server identifier (option 54), or the sender when absent. */
  server: string;
  /** Address the offer came from: the server itself, or a relay. */
  from: string;
  offered: string;
  router?: string;
  dns: string[];
  leaseSeconds?: number;
  mac?: string;
}

export interface DhcpCheck {
  offers: DhcpOffer[];
  listenedMs: number;
  /** "relay" when port 68 was busy and the request went out as a relay agent's. */
  mode: 'direct' | 'relay';
  error?: string;
}

/**
 * Builds a DHCPDISCOVER asking for subnet, router, DNS and lease time. Without `relay`, replies
 * are broadcast; with it, they are sent to that address on port 67, as to a relay agent.
 */
export function buildDiscover(mac: Buffer, xid: Buffer, relay?: string): Buffer {
  const pkt = Buffer.alloc(300);
  pkt[0] = 1; // BOOTREQUEST
  pkt[1] = 1; // Ethernet
  pkt[2] = 6; // hardware address length
  xid.copy(pkt, 4);
  if (relay) {
    pkt[3] = 1; // hops: one relay
    Buffer.from(relay.split('.').map(Number)).copy(pkt, 24); // giaddr
  } else {
    pkt.writeUInt16BE(0x8000, 10); // broadcast flag: the client has no address yet
  }
  mac.copy(pkt, 28);
  pkt.writeUInt32BE(MAGIC, 236);
  const options = [53, 1, 1, 55, 4, 1, 3, 6, 51, 255];
  options.forEach((b, i) => (pkt[240 + i] = b));
  return pkt;
}

const ip4 = (b: Buffer, at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

/** Reads a DHCPOFFER for transaction `xid`; undefined for anything else. */
export function parseOffer(msg: Buffer, xid: Buffer, from: string): DhcpOffer | undefined {
  if (msg.length < 244 || msg[0] !== 2 || !msg.subarray(4, 8).equals(xid) || msg.readUInt32BE(236) !== MAGIC) return undefined;
  let type: number | undefined;
  let server: string | undefined;
  let router: string | undefined;
  let leaseSeconds: number | undefined;
  const dns: string[] = [];
  for (let i = 240; i < msg.length; ) {
    const code = msg[i] as number;
    if (code === 255) break;
    if (code === 0) {
      i++;
      continue;
    }
    const len = msg[i + 1] ?? 0;
    const at = i + 2;
    if (at + len > msg.length) break;
    if (code === 53) type = msg[at];
    else if (code === 54 && len >= 4) server = ip4(msg, at);
    else if (code === 3 && len >= 4) router = ip4(msg, at);
    else if (code === 6) for (let k = 0; k + 4 <= len; k += 4) dns.push(ip4(msg, at + k));
    else if (code === 51 && len === 4) leaseSeconds = msg.readUInt32BE(at);
    i = at + len;
  }
  if (type !== 2) return undefined;
  return { server: server ?? from, from, offered: ip4(msg, 16), router, dns, leaseSeconds };
}

type Attempt = { offers: DhcpOffer[]; busy?: boolean; error?: string };

/** One DISCOVER on `port`, listening `listenMs` for offers; `relay` sends it as a relay agent would. */
function attempt(port: 67 | 68, listenMs: number, relay?: string): Promise<Attempt> {
  return new Promise((resolve) => {
    const mac = Buffer.from([0x02, ...randomBytes(5)]);
    const xid = randomBytes(4);
    const offers = new Map<string, DhcpOffer>();
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let done = false;
    const finish = (r: Omit<Attempt, 'offers'> = {}) => {
      if (done) return;
      done = true;
      try {
        sock.close();
      } catch {
        // already closed
      }
      resolve({ offers: [...offers.values()], ...r });
    };
    sock.on('error', (err: NodeJS.ErrnoException) => {
      const busy = err.code === 'EADDRINUSE' || err.code === 'EACCES';
      finish(busy ? { busy } : { error: `The DHCP test could not run: ${err.message}` });
    });
    sock.on('message', (msg, rinfo) => {
      const offer = parseOffer(msg, xid, rinfo.address);
      if (offer && !offers.has(offer.server)) offers.set(offer.server, offer);
    });
    sock.bind(port, () => {
      sock.setBroadcast(true);
      sock.send(buildDiscover(mac, xid, relay), 67, '255.255.255.255', (err) => {
        if (err) finish({ error: `Could not send the DHCP request: ${err.message}` });
      });
      setTimeout(() => finish(), listenMs);
    });
  });
}

/**
 * Lists every server that offers an address within `listenMs`. `relayAddress` is this computer's
 * address on the network, used when port 68 is busy.
 */
export async function findDhcpServers(relayAddress: string | undefined, listenMs = 5000): Promise<DhcpCheck> {
  let mode: DhcpCheck['mode'] = 'direct';
  let result = await attempt(68, listenMs);
  if (result.busy) {
    if (!relayAddress) return { offers: [], listenedMs: listenMs, mode, error: 'The DHCP port is in use by the system and this computer has no address to relay from.' };
    mode = 'relay';
    result = await attempt(67, listenMs, relayAddress);
    if (result.busy) return { offers: [], listenedMs: listenMs, mode, error: 'Both DHCP ports are in use on this computer, so offers cannot be heard.' };
  }
  const arp = result.offers.length ? await readArpTable().catch(() => new Map<string, string>()) : new Map<string, string>();
  // A relayed offer (sender differs from the server identifier) comes from the relay: the sender's
  // MAC is the relay's, not the server's.
  const macOf = (o: DhcpOffer) => arp.get(o.server) ?? (o.from === o.server ? undefined : mode === 'direct' ? arp.get(o.from) : undefined);
  return { offers: result.offers.map((o) => ({ ...o, mac: macOf(o) })), listenedMs: listenMs, mode, error: result.error };
}
