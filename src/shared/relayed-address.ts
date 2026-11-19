/**
 * Wi-Fi extenders that rewrite the MAC address of every device behind them. Such an extender gives
 * each address it relays its own last three bytes as a prefix, marked as locally administered, and
 * keeps the last three bytes of the device: a switch then learns addresses no device has. Its own
 * address goes through the same rewriting, so it shows as its last three bytes twice. The pattern
 * is recognised from that structure alone, on the addresses one switch port learned.
 */

/** One extender found on a port, with what its rewritten addresses stand for. */
export interface Relay {
  /** The three bytes every address the extender relays begins with, as "aa:bb:cc". */
  prefix: string;
  /** The extender's own address as the switch learned it, when it is among the addresses. */
  self?: string;
  /** The extender's real MAC address, when one inventory device alone ends with its three bytes. */
  realMac?: string;
  /** Rewritten address → real MAC address of the one inventory device it stands for. */
  alias: Map<string, string>;
  /** Every rewritten address of the extender on the port, its own included, sorted. */
  members: string[];
}

const bytes = (mac: string) => mac.toLowerCase().split(':');
const head = (mac: string) => bytes(mac).slice(0, 3).join(':');
const tail = (mac: string) => bytes(mac).slice(3).join(':');
/** Locally administered and not a group address: what a rewritten address always is. */
const local = (mac: string) => (parseInt(bytes(mac)[0] ?? '', 16) & 0x03) === 0x02;
/** The prefix an extender whose real address ends with `last` (as "aa:bb:cc") gives the addresses it relays. */
const prefixFor = (last: string) => {
  const [first = '', ...rest] = last.split(':');
  return [(parseInt(first, 16) | 0x02).toString(16).padStart(2, '0'), ...rest].join(':');
};

/** The MAC addresses of the inventory by their last three bytes (as "aa:bb:cc"), in lower case and each once. */
export function byLastBytes(known: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const mac of new Set([...known].map((m) => m.toLowerCase()))) index.set(tail(mac), [...(index.get(tail(mac)) ?? []), mac]);
  return index;
}

/**
 * The extenders behind one switch port, from the addresses the port learned (`learned`) and the
 * real MAC addresses the inventory holds (`known`, as `byLastBytes` gives them). An extender is
 * taken as found when its own rewritten address is there, or when at least two rewritten
 * addresses each stand for one inventory device. A rewritten address whose last three bytes two
 * inventory devices share stands for neither. Addresses that share a prefix by chance are left
 * alone.
 */
export function relaysOnPort(learned: Iterable<string>, known: ReadonlyMap<string, readonly string[]>): Relay[] {
  const groups = new Map<string, string[]>();
  for (const mac of new Set([...learned].map((m) => m.toLowerCase()))) {
    if (mac.length === 17 && local(mac)) groups.set(head(mac), [...(groups.get(head(mac)) ?? []), mac]);
  }
  const relays: Relay[] = [];
  for (const [prefix, members] of groups) {
    const self = members.find((m) => prefixFor(tail(m)) === prefix);
    // One address alone that is not an extender's own tells nothing.
    if (!self && members.length < 2) continue;
    // The one inventory device with these last three bytes; one held under a rewritten address is a member itself.
    const own = new Set(members);
    const one = (last: string) => {
      const found = (known.get(last) ?? []).filter((mac) => !own.has(mac));
      return found.length === 1 ? found[0] : undefined;
    };
    const alias = new Map<string, string>();
    for (const m of members.filter((x) => x !== self).sort()) {
      const real = one(tail(m));
      if (real) alias.set(m, real);
    }
    if (!self && alias.size < 2) continue;
    relays.push({ prefix, self, realMac: self ? one(tail(self)) : undefined, alias, members: [...members].sort() });
  }
  return relays.sort((p, q) => p.prefix.localeCompare(q.prefix));
}
