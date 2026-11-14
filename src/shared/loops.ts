/**
 * Finds network loops in what managed switches report over LLDP and in their MAC tables.
 *
 * A switch sends LLDP out of every port. When two of its ports are joined through other gear (an
 * unmanaged switch, a router's built-in ports, a cable plugged back in), the switch receives its own
 * announcement on the other port and lists itself as a neighbour, and learns the address of one of
 * its own ports on the other. That is a loop: spanning tree, if on, blocks one of the ports; if off,
 * broadcasts circle until the network stops working.
 */
import type { GearDevice, GearInterface, GearNeighbor } from './types';

/** A loop on one managed switch: the ports that are connected to each other. */
export interface NetworkLoop {
  switchIp: string;
  switchName?: string;
  /** Port names, in the switch's order (e.g. ["gi1", "gi21"]). */
  ports: string[];
}

const norm = (s: string) => s.toLowerCase();

/**
 * True when the neighbour on a port is the switch itself. A matching chassis MAC proves it; a
 * different one does not rule it out, because many switches announce a chassis MAC over LLDP that
 * differs from the bridge address read over SNMP, so the management address is checked as well.
 */
function isSelf(d: GearDevice, n: GearNeighbor): boolean {
  if (n.chassisMac && d.mac && norm(n.chassisMac) === norm(d.mac)) return true;
  if (n.mgmtIp) {
    const sameAddress = n.mgmtIp === d.ip || !!d.addresses?.some((a) => a.ip === n.mgmtIp);
    // Members of a stack or a redundant pair can share one management address: with different
    // chassis MACs, the name must match too.
    if (n.chassisMac && d.mac) return sameAddress && !!n.sysName && !!d.sysName && norm(n.sysName) === norm(d.sysName);
    return sameAddress;
  }
  if (n.chassisMac && d.mac) return false;
  // Only a name to go by: trusted when nothing else identifies the neighbour.
  return !!n.sysName && !!d.sysName && !n.chassisId && norm(n.sysName) === norm(d.sysName);
}

/** The switch's own port that a neighbour names as its remote port ("gi1", "GigabitEthernet1", an alias). */
function ownPort(d: GearDevice, remotePort: string | undefined) {
  if (!remotePort) return undefined;
  const r = norm(remotePort);
  return d.interfaces.find((i) => norm(i.name) === r || (i.descr && norm(i.descr) === r) || (i.alias && norm(i.alias) === r));
}

/** Every switch that sees itself over LLDP, with the ports that are joined. */
export function findLoops(devices: GearDevice[]): NetworkLoop[] {
  const out: NetworkLoop[] = [];
  for (const d of devices) {
    const found = new Map<string, number>();
    const add = (name: string, ifIndex?: number) => {
      if (!found.has(name)) found.set(name, ifIndex ?? Number.MAX_SAFE_INTEGER);
    };
    for (const n of d.neighbors) {
      if (!isSelf(d, n)) continue;
      const local = n.localIfIndex !== undefined ? d.interfaces.find((i) => i.ifIndex === n.localIfIndex) : undefined;
      add(local?.name ?? n.localPort, local?.ifIndex ?? n.localIfIndex);
      // The announcement left through the other port: the neighbour entry names it.
      const remote = ownPort(d, n.remotePort);
      if (remote) add(remote.name, remote.ifIndex);
    }
    // The MAC table tells it too, also without LLDP: the address of one of the switch's own ports,
    // learned on another of its ports, left through the first and came back through the second.
    // Only addresses that belong to a single interface tell which port sent them.
    const owners = new Map<string, GearInterface[]>();
    for (const i of d.interfaces) if (i.mac) owners.set(norm(i.mac), [...(owners.get(norm(i.mac)) ?? []), i]);
    const byIndex = new Map(d.interfaces.map((i) => [i.ifIndex, i]));
    for (const f of d.fdb) {
      const mine = owners.get(norm(f.mac));
      const owner = mine?.length === 1 ? mine[0] : undefined;
      const learnedOn = f.ifIndex !== undefined ? byIndex.get(f.ifIndex) : undefined;
      if (!owner || !learnedOn || owner.ifIndex === learnedOn.ifIndex) continue;
      add(learnedOn.name, learnedOn.ifIndex);
      add(owner.name, owner.ifIndex);
    }
    if (!found.size) continue;
    const ports = [...found].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([name]) => name);
    out.push({ switchIp: d.ip, switchName: d.sysName, ports });
  }
  return out;
}

/** One sentence naming the joined ports, e.g. "gi1 and gi21 are connected to each other through other gear". */
export function describeLoop(loop: NetworkLoop): string {
  const names = loop.ports;
  if (names.length === 1) return `${names[0]} receives the switch's own announcements: it is connected back to this switch through other gear`;
  const list = names.length === 2 ? `${names[0]} and ${names[1]}` : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} are connected to each other through other gear`;
}
