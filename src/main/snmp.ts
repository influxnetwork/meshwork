/**
 * Read-only SNMP v2c client for network gear: finds which addresses answer, reads each answering
 * device's ports, LLDP neighbours, learned MAC addresses and PoE state, and samples port traffic
 * counters. Nothing is ever written to the devices.
 */
import snmp, { type Session, type Varbind as SnmpVarbind } from 'net-snmp';
import type { GearDevice } from '@shared/types';
import { OID, num, parseGear, type GearWalks, type Varbind } from './snmp-parse';

const PROBE_TIMEOUT_MS = 1200;
const READ_TIMEOUT_MS = 2500;
const MAX_ROWS = 20_000; // per walk, so a misbehaving agent cannot run forever
const PROBE_CONCURRENCY = 16;
const RETRY_PAUSE_MS = 3000;
const REPETITIONS = 25;
const GENTLE_REPETITIONS = 8;
const GENTLE_GAP_MS = 600;

function open(ip: string, community: string, timeout: number, retries: number): Session {
  const session = snmp.createSession(ip, community, { version: snmp.Version2c, timeout, retries });
  // Socket errors are reported through each request's callback; this keeps them from being thrown.
  session.on('error', () => undefined);
  return session;
}

function clean(varbinds: SnmpVarbind[]): Varbind[] {
  return varbinds.filter((vb) => !snmp.isVarbindError(vb)).map((vb) => ({ oid: vb.oid, value: vb.value }));
}

function get(session: Session, oids: string[]): Promise<Varbind[]> {
  return new Promise((resolve) => {
    session.get(oids, (error, varbinds) => resolve(error ? [] : clean(varbinds)));
  });
}

function walkOnce(session: Session, oid: string, repetitions: number): Promise<{ rows: Varbind[]; failed: boolean }> {
  return new Promise((resolve) => {
    const rows: Varbind[] = [];
    session.subtree(
      oid,
      repetitions,
      (varbinds) => {
        rows.push(...clean(varbinds));
        return rows.length >= MAX_ROWS;
      },
      (error) => resolve({ rows, failed: !!error }),
    );
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Pace of a read. Some switches stop answering for a while when asked too much too quickly; once a
 * device times out, the rest of its read goes gently: smaller requests with a pause between tables.
 */
interface Pace {
  gentle: boolean;
}

/**
 * Walks a subtree; resolves with whatever was read, empty when the device does not have it. A walk
 * that times out is tried again once, after a pause and at the gentle pace, so a busy agent does
 * not silently lose a whole table.
 */
async function walk(session: Session, oid: string, pace: Pace): Promise<Varbind[]> {
  if (pace.gentle) await pause(GENTLE_GAP_MS);
  const first = await walkOnce(session, oid, pace.gentle ? GENTLE_REPETITIONS : REPETITIONS);
  if (!first.failed) return first.rows;
  pace.gentle = true;
  await pause(RETRY_PAUSE_MS);
  const second = await walkOnce(session, oid, GENTLE_REPETITIONS);
  return second.rows.length >= first.rows.length ? second.rows : first.rows;
}

/** True when the address answers SNMP with this community. */
export async function probe(ip: string, community: string): Promise<boolean> {
  const session = open(ip, community, PROBE_TIMEOUT_MS, 0);
  try {
    return (await get(session, [OID.sysName])).length > 0;
  } finally {
    session.close();
  }
}

/** Reads everything the map uses from one device. */
export async function readGear(ip: string, community: string): Promise<GearDevice> {
  const session = open(ip, community, READ_TIMEOUT_MS, 1);
  const pace: Pace = { gentle: false };
  try {
    const system = [
      ...(await get(session, [OID.sysName, OID.sysDescr, OID.sysObjectId, OID.sysUpTime])),
      ...(await get(session, [OID.baseBridgeAddress, OID.stpPriority])),
      ...(await get(session, [OID.ipForwarding, OID.ipRouteNextHopDefault, OID.ipRouteIfIndexDefault])),
    ];
    // Tables are read one after another: small switches answer slowly to parallel walks.
    const w: GearWalks = {
      system,
      ifName: await walk(session, OID.ifName, pace),
      ifDescr: await walk(session, OID.ifDescr, pace),
      ifPhysAddress: await walk(session, OID.ifPhysAddress, pace),
      ifAlias: await walk(session, OID.ifAlias, pace),
      ifOperStatus: await walk(session, OID.ifOperStatus, pace),
      ifHighSpeed: await walk(session, OID.ifHighSpeed, pace),
      basePortIfIndex: await walk(session, OID.basePortIfIndex, pace),
      stpPortState: await walk(session, OID.stpPortState, pace),
      qFdbPort: await walk(session, OID.qFdbPort, pace),
      qFdbStatus: await walk(session, OID.qFdbStatus, pace),
      dot1dFdbPort: [],
      dot1dFdbStatus: [],
      ipNetToMedia: await walk(session, OID.ipNetToMedia, pace),
      ipAdEntIfIndex: await walk(session, OID.ipAdEntIfIndex, pace),
      ipAdEntNetMask: await walk(session, OID.ipAdEntNetMask, pace),
      defaultRoutes: [...(await walk(session, OID.ipCidrRouteIfIndexDefault, pace)), ...(await walk(session, OID.inetCidrRouteIfIndexDefault, pace))],
      vlanStaticName: await walk(session, OID.vlanStaticName, pace),
      vlanStaticEgress: await walk(session, OID.vlanStaticEgress, pace),
      vlanStaticUntagged: await walk(session, OID.vlanStaticUntagged, pace),
      vlanCurrentEgress: await walk(session, OID.vlanCurrentEgress, pace),
      vlanCurrentUntagged: await walk(session, OID.vlanCurrentUntagged, pace),
      pvid: await walk(session, OID.pvid, pace),
      lldpLocPortId: await walk(session, OID.lldpLocPortId, pace),
      lldpRem: await walk(session, OID.lldpRem, pace),
      lldpRemManAddr: await walk(session, OID.lldpRemManAddr, pace),
      cdpCache: await walk(session, OID.cdpCache, pace),
      pethPortDetection: await walk(session, OID.pethPortDetection, pace),
      pethMain: await walk(session, OID.pethMain, pace),
      poePortMilliwatts: await walk(session, OID.poePortMilliwattsSb, pace),
    };
    // Devices that publish their ARP table only in the newer IP-MIB table.
    if (!w.ipNetToMedia.length) w.ipNetToPhysical = await walk(session, OID.ipNetToPhysical, pace);
    // Switches that publish VLANs only in the IEEE 802.1Q bridge tables (indexed by component).
    if (!w.vlanStaticName.length && !w.pvid.length && !w.vlanCurrentEgress.length && !w.vlanStaticEgress.length) {
      w.ieeeVlanStaticName = await walk(session, OID.ieeeVlanStaticName, pace);
      w.ieeePvid = await walk(session, OID.ieeePvid, pace);
      w.ieeeVlanStaticEgress = await walk(session, OID.ieeeVlanStaticEgress, pace);
      w.ieeeVlanStaticUntagged = await walk(session, OID.ieeeVlanStaticUntagged, pace);
    }
    // Cisco switches that publish no 802.1Q tables at all: their own VLAN tables.
    const noVlans = [w.vlanStaticName, w.pvid, w.vlanCurrentEgress, w.vlanStaticEgress, w.ieeeVlanStaticName, w.ieeePvid, w.ieeeVlanStaticEgress].every((x) => !x?.length);
    if (noVlans) {
      w.ciscoVlanName = await walk(session, OID.ciscoVlanName, pace);
      if (w.ciscoVlanName.length) {
        w.ciscoTrunkStatus = await walk(session, OID.ciscoTrunkStatus, pace);
        w.ciscoTrunkNative = await walk(session, OID.ciscoTrunkNative, pace);
        w.ciscoTrunkVlans = [];
        for (const oid of [OID.ciscoTrunkVlans1k, OID.ciscoTrunkVlans2k, OID.ciscoTrunkVlans3k, OID.ciscoTrunkVlans4k]) w.ciscoTrunkVlans.push(...(await walk(session, oid, pace)));
        w.ciscoAccessVlan = await walk(session, OID.ciscoAccessVlan, pace);
      }
    }
    // Port duplex is compared with what CDP neighbours announce, so it is read only when there are some.
    if (w.cdpCache?.length) w.dot3Duplex = await walk(session, OID.dot3Duplex, pace);
    // Switches that do not publish per-port watts one way may publish them the other.
    if (!w.poePortMilliwatts.length && w.pethPortDetection.length) w.poePortMilliwatts = await walk(session, OID.poePortMilliwattsCisco, pace);
    if (!w.qFdbPort.length) {
      w.dot1dFdbPort = await walk(session, OID.dot1dFdbPort, pace);
      w.dot1dFdbStatus = await walk(session, OID.dot1dFdbStatus, pace);
    }
    return parseGear(ip, w);
  } finally {
    session.close();
  }
}

/** Probes every address and reads the devices that answer. */
export async function readNetwork(ips: string[], community: string): Promise<GearDevice[]> {
  const answering: string[] = [];
  const queue = [...ips];
  await Promise.all(
    Array.from({ length: Math.min(PROBE_CONCURRENCY, queue.length) }, async () => {
      for (let ip = queue.shift(); ip; ip = queue.shift()) {
        if (await probe(ip, community)) answering.push(ip);
      }
    }),
  );
  const devices: GearDevice[] = [];
  for (const ip of answering) devices.push(await readGear(ip, community));
  return devices;
}

/** Octet counters (in, out) for the given interfaces of one device. */
export async function readCounters(ip: string, community: string, ifIndexes: number[]): Promise<Map<number, { in: number; out: number }>> {
  const out = new Map<number, { in: number; out: number }>();
  if (!ifIndexes.length) return out;
  const session = open(ip, community, READ_TIMEOUT_MS, 0);
  try {
    // Small batches keep each request under common response size limits.
    for (let i = 0; i < ifIndexes.length; i += 10) {
      const batch = ifIndexes.slice(i, i + 10);
      const varbinds = await get(session, batch.flatMap((n) => [`${OID.ifHCInOctets}.${n}`, `${OID.ifHCOutOctets}.${n}`]));
      for (const vb of varbinds) {
        const ifIndex = Number(vb.oid.split('.').at(-1));
        const value = num(vb.value);
        if (value === undefined) continue;
        const entry = out.get(ifIndex) ?? { in: 0, out: 0 };
        if (vb.oid.replace(/^\./, '').startsWith(OID.ifHCInOctets)) entry.in = value;
        else entry.out = value;
        out.set(ifIndex, entry);
      }
    }
    return out;
  } finally {
    session.close();
  }
}
