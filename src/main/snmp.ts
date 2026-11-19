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
const UNANSWERED_LIMIT = 2;
const READ_CONCURRENCY = 4;

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

/**
 * What a walk read. `failed`: it ended with an error, so rows may be missing. `silent`: that error
 * was the device not answering at all, as opposed to answering with an error status.
 */
interface Walked {
  rows: Varbind[];
  failed: boolean;
  silent: boolean;
}

const walked = (rows: Varbind[], error?: Error | null): Walked => ({ rows, failed: !!error, silent: error instanceof snmp.RequestTimedOutError });

function walkOnce(session: Session, oid: string, repetitions: number): Promise<Walked> {
  return new Promise((resolve) => {
    const rows: Varbind[] = [];
    session.subtree(
      oid,
      repetitions,
      (varbinds) => {
        rows.push(...clean(varbinds));
        return rows.length >= MAX_ROWS;
      },
      (error) => resolve(walked(rows, error)),
    );
  });
}

/** True when object identifier `a` comes after `b` in the order agents list them. */
function oidAfter(a: string, b: string): boolean {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] as number) > (y[i] as number);
  return x.length > y.length;
}

/**
 * Walks a subtree one row per request, starting after `from`, for agents that answer single
 * requests but not bulk ones. The table ends where the agent has nothing more, says there is no
 * such name, leaves the subtree or gives a row that does not come after the one asked from.
 */
function walkSingly(session: Session, oid: string, from = oid): Promise<Walked> {
  return new Promise((resolve) => {
    const rows: Varbind[] = [];
    const step = (after: string) => {
      session.getNext([after], (error, varbinds) => {
        if (error instanceof snmp.RequestFailedError && error.status === snmp.ErrorStatus.NoSuchName) return resolve(walked(rows));
        if (error) return resolve(walked(rows, error));
        const [next] = clean(varbinds ?? []);
        if (!next || !next.oid.startsWith(`${oid}.`) || !oidAfter(next.oid, after)) return resolve(walked(rows));
        rows.push(next);
        if (rows.length >= MAX_ROWS) return resolve(walked(rows));
        step(next.oid);
      });
    };
    step(from);
  });
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * State of one device's read. Some switches stop answering for a while when asked too much too
 * quickly; once a device times out, the rest of its read goes gently: smaller requests with a
 * pause between tables.
 */
interface Pace {
  gentle: boolean;
  /** True once a bulk request was answered: the device is not one that only answers single requests. */
  bulkAnswered: boolean;
  /** True when the device answers single requests but not bulk ones: its tables are read one row at a time. */
  singly: boolean;
  /** Tables in a row that got no answer at all, after every try. */
  unanswered: number;
  /** True when the device answers a plain request but gives no answer at all for some tables. */
  mute?: boolean;
  /** True when the device stopped answering altogether: it is not asked again. */
  gone?: boolean;
}

/** A table the device answered, with rows or with an error status, ends the count of unanswered ones. */
function note(pace: Pace, ...tries: Walked[]): void {
  pace.unanswered = tries.every((t) => t.silent && !t.rows.length) ? pace.unanswered + 1 : 0;
}

/**
 * Reads a table one row at a time. A read that stops answering part of the way is taken up once
 * more, after a pause, from the last row it gave.
 */
async function walkRows(session: Session, oid: string, pace: Pace): Promise<Varbind[]> {
  const first = await walkSingly(session, oid);
  if (!first.silent || !first.rows.length) {
    note(pace, first);
    return first.rows;
  }
  await pause(RETRY_PAUSE_MS);
  const rest = await walkSingly(session, oid, first.rows.at(-1)?.oid);
  note(pace, rest);
  return [...first.rows, ...rest.rows];
}

/**
 * Walks a subtree; resolves with whatever was read, empty when the device does not have it. A
 * walk that fails is tried again once, after a pause and at the gentle pace, so a busy agent does
 * not silently lose a whole table. A device that never answered a bulk request is asked one row
 * at a time first; when it answers that and, after a pause, misses a second bulk request, it is
 * read one row at a time from then on. A device that left `UNANSWERED_LIMIT` tables in a row with
 * no answer at all is asked for its name: when that gets no answer either, it is not asked again;
 * when it does, the device is there and only keeps silent on tables it does not hold, so the read
 * goes on at the gentle pace, and a table with no answer that follows another one is not tried a
 * second time.
 */
async function walk(session: Session, oid: string, pace: Pace): Promise<Varbind[]> {
  if (pace.gone) return [];
  if (pace.unanswered >= UNANSWERED_LIMIT) {
    if (!(await get(session, [OID.sysName])).length) {
      pace.gone = true;
      return [];
    }
    // From the second time on the count starts at one, so a run of tables it keeps silent on is not tried twice each.
    pace.unanswered = pace.mute ? 1 : 0;
    pace.mute = true;
    pace.gentle = true;
  }
  if (pace.singly) return walkRows(session, oid, pace);
  if (pace.gentle) await pause(GENTLE_GAP_MS);
  const first = await walkOnce(session, oid, pace.gentle ? GENTLE_REPETITIONS : REPETITIONS);
  if (!first.silent || first.rows.length) pace.bulkAnswered = true;
  if (!first.failed) {
    pace.unanswered = 0;
    return first.rows;
  }
  // Right after another table with no answer; a single table missed among answered ones is still tried again.
  if (pace.mute && pace.bulkAnswered && pace.unanswered > 0 && first.silent && !first.rows.length) {
    note(pace, first);
    return [];
  }
  if (!pace.bulkAnswered) {
    const single = await walkSingly(session, oid);
    if (!single.failed) {
      // The device is there. After a pause, one more bulk request tells a device that missed a
      // request from one that answers none of them.
      await pause(RETRY_PAUSE_MS);
      const again = await walkOnce(session, oid, GENTLE_REPETITIONS);
      pace.unanswered = 0;
      if (!again.silent || again.rows.length) pace.bulkAnswered = true;
      else pace.singly = true;
      return again.rows.length >= single.rows.length ? again.rows : single.rows;
    }
  }
  pace.gentle = true;
  await pause(RETRY_PAUSE_MS);
  const second = await walkOnce(session, oid, GENTLE_REPETITIONS);
  if (!second.silent || second.rows.length) pace.bulkAnswered = true;
  note(pace, first, second);
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
  const pace: Pace = { gentle: false, bulkAnswered: false, singly: false, unanswered: 0 };
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
      ifStack: await walk(session, OID.ifStackStatus, pace),
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

/** Runs `task` over every item, `limit` at a time; the results keep the order of the items. */
async function pooled<T, R>(items: T[], limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (let i = next++; i < items.length; i = next++) results[i] = await task(items[i] as T);
    }),
  );
  return results;
}

/**
 * Probes every address and reads the devices that answer, in the order of `ips`. Several devices
 * are read at a time, each on its own session, so one that answers slowly does not hold back the
 * others; the tables of one device are still read one after another.
 */
export async function readNetwork(ips: string[], community: string): Promise<GearDevice[]> {
  const answers = await pooled(ips, PROBE_CONCURRENCY, (ip) => probe(ip, community));
  return pooled(ips.filter((_, i) => answers[i]), READ_CONCURRENCY, (ip) => readGear(ip, community));
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
