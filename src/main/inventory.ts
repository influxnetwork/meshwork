/**
 * Local inventory of discovered devices, stored in SQLite in the user data folder.
 * Devices are grouped by network. Within a network a device is identified by its MAC when known,
 * otherwise by its IP address; the same device seen on two networks is kept once per network.
 */
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Asset, DiscoveredHost, GearSnapshot, Network, NetworkIdentity, ScanSummary } from '@shared/types';
import { toCsv } from '@shared/csv';
import { classifyHost } from '@shared/fingerprint';
import { uniqueGear } from '@shared/gear';
import { evaluateRisks } from '../scanner/analysis';

type Migration = string | ((db: DatabaseSync) => void);

const MIGRATIONS: Migration[] = [
  `create table assets (
     id            text primary key,
     key           text not null unique,
     ip            text not null,
     mac           text,
     data          text not null,
     first_seen    text not null,
     last_seen     text not null,
     first_run_id  text not null,
     last_run_id   text not null
   );
   create index assets_ip on assets(ip);
   create index assets_last_seen on assets(last_seen);
   create table scan_runs (
     id           text primary key,
     targets      text not null,
     started_at   text not null,
     finished_at  text not null,
     status       text not null check (status in ('done','cancelled','failed')),
     scanned      integer not null,
     live         integer not null,
     new_assets   integer not null,
     open_ports   integer not null,
     risks        integer not null
   );`,
  // v2: networks. Existing scans and devices are grouped by the targets of the scan that last saw them.
  (db) => {
    db.exec(`
      create table networks (
        id           text primary key,
        name         text not null,
        fingerprint  text not null unique,
        cidr         text not null,
        gateway_ip   text,
        gateway_mac  text,
        created_at   text not null,
        last_scan_at text not null
      );
      create table assets_v2 (
        id            text primary key,
        network_id    text not null references networks(id) on delete cascade,
        key           text not null,
        ip            text not null,
        mac           text,
        data          text not null,
        first_seen    text not null,
        last_seen     text not null,
        first_run_id  text not null,
        last_run_id   text not null,
        unique (network_id, key)
      );
      alter table scan_runs add column network_id text references networks(id) on delete cascade;
    `);
    const insertNetwork = db.prepare(
      'insert into networks (id, name, fingerprint, cidr, created_at, last_scan_at) values (?, ?, ?, ?, ?, ?)',
    );
    const byTargets = new Map<string, string>();
    const networkFor = (targets: string, at: string) => {
      let id = byTargets.get(targets);
      if (!id) {
        id = randomUUID();
        insertNetwork.run(id, targets, `legacy:${targets}`, targets, at, at);
        byTargets.set(targets, id);
      }
      return id;
    };
    const runs = db.prepare('select id, targets, started_at from scan_runs order by started_at').all() as {
      id: string;
      targets: string;
      started_at: string;
    }[];
    const runNetwork = new Map<string, string>();
    for (const r of runs) {
      const id = networkFor(r.targets, r.started_at);
      runNetwork.set(r.id, id);
      db.prepare('update scan_runs set network_id = ? where id = ?').run(id, r.id);
      db.prepare('update networks set last_scan_at = max(last_scan_at, ?) where id = ?').run(r.started_at, id);
    }
    const assets = db.prepare('select * from assets').all() as unknown as AssetRow[];
    for (const a of assets) {
      const networkId = runNetwork.get(a.last_run_id) ?? networkFor('Earlier scans', a.first_seen);
      db.prepare(
        `insert or ignore into assets_v2 (id, network_id, key, ip, mac, data, first_seen, last_seen, first_run_id, last_run_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.id, networkId, a.key, a.ip, a.mac, a.data, a.first_seen, a.last_seen, a.first_run_id, a.last_run_id);
    }
    db.exec(`
      drop table assets;
      alter table assets_v2 rename to assets;
      create index assets_network on assets(network_id);
      create index assets_ip on assets(ip);
      create index assets_last_seen on assets(last_seen);
      create index scan_runs_network on scan_runs(network_id);
      delete from networks where id not in (select network_id from assets);
    `);
  },
  // v3: networks left empty by scans that found nothing are not kept.
  'delete from networks where id not in (select network_id from assets);',
  // v4: SNMP access per network (the secret is encrypted by the caller) and the latest reading of
  // the network's managed devices.
  `create table snmp_credentials (
     network_id  text primary key references networks(id) on delete cascade,
     version     text not null,
     secret      text not null,
     updated_at  text not null
   );
   create table gear_snapshots (
     network_id    text primary key references networks(id) on delete cascade,
     collected_at  text not null,
     data          text not null
   );`,
];

interface AssetRow {
  id: string;
  network_id: string;
  key: string;
  ip: string;
  mac: string | null;
  data: string;
  first_seen: string;
  last_seen: string;
  first_run_id: string;
  last_run_id: string;
  /** Present when read through ASSET_SELECT: the run that last saw any device of the network. */
  latest_run_id?: string;
}

/**
 * Selects assets with the network's latest run: the run of the device seen most recently. A device
 * is new only when that run is the one that first saw it, so a device that appeared in one earlier
 * scan and was not seen again stops being new.
 */
const ASSET_SELECT = `select a.*, (select b.last_run_id from assets b where b.network_id = a.network_id
  order by b.last_seen desc limit 1) as latest_run_id from assets a`;

interface NetworkRow {
  id: string;
  name: string;
  fingerprint: string;
  cidr: string;
  gateway_ip: string | null;
  gateway_mac: string | null;
  created_at: string;
  last_scan_at: string;
}

function keyFor(host: DiscoveredHost): string {
  return host.mac ? `mac:${host.mac}` : `ip:${host.ip}`;
}

function toAsset(row: AssetRow): Asset {
  const host = JSON.parse(row.data) as DiscoveredHost;
  return {
    ...host,
    id: row.id,
    networkId: row.network_id,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    lastRunId: row.last_run_id,
    isNew: row.first_run_id === (row.latest_run_id ?? row.last_run_id),
  };
}

function toNetwork(row: NetworkRow): Network {
  return {
    id: row.id,
    name: row.name,
    fingerprint: row.fingerprint,
    cidr: row.cidr,
    gatewayIp: row.gateway_ip ?? undefined,
    gatewayMac: row.gateway_mac ?? undefined,
    createdAt: row.created_at,
    lastScanAt: row.last_scan_at,
  };
}

/** Default name for a new network: its subnet, plus the router maker when known. */
export function defaultNetworkName(identity: NetworkIdentity): string {
  if (!identity.local) return identity.cidr;
  const maker = identity.gatewayVendor && identity.gatewayVendor !== 'Private address' ? identity.gatewayVendor.split(/[ ,]/)[0] : undefined;
  return maker ? `${identity.cidr} · ${maker} router` : identity.cidr;
}

export class Inventory {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
    const { user_version } = this.db.prepare('pragma user_version').get() as { user_version: number };
    for (let v = user_version; v < MIGRATIONS.length; v++) {
      const step = MIGRATIONS[v] as Migration;
      this.db.exec('begin');
      try {
        if (typeof step === 'string') this.db.exec(step);
        else step(this.db);
        this.db.exec(`pragma user_version = ${v + 1}`);
        this.db.exec('commit');
      } catch (err) {
        this.db.exec('rollback');
        throw err;
      }
    }
  }

  private row(sql: string, ...params: (string | number | null)[]): AssetRow | undefined {
    return this.db.prepare(sql).get(...params) as unknown as AssetRow | undefined;
  }

  private networkRow(sql: string, ...params: (string | number | null)[]): NetworkRow | undefined {
    return this.db.prepare(sql).get(...params) as unknown as NetworkRow | undefined;
  }

  /**
   * Returns the network for a scan, creating it on first sight. A network known only by its
   * subnet (an earlier scan without the router's MAC) is adopted when the router is identified,
   * so the same network is not split in two.
   */
  resolveNetwork(identity: NetworkIdentity): Network {
    const now = new Date().toISOString();
    // A local scan that could not read the router's MAC (no local network permission, or the
    // router did not answer) belongs to the one known network on that subnet whose router is
    // identified. With two such networks it cannot tell them apart and keeps a subnet-only one.
    if (identity.local && !identity.gatewayMac) {
      const routed = this.db
        .prepare('select * from networks where cidr = ? and gateway_mac is not null order by last_scan_at desc limit 2')
        .all(identity.cidr) as unknown as NetworkRow[];
      if (routed.length === 1 && routed[0]) {
        this.db.prepare('update networks set last_scan_at = ? where id = ?').run(now, routed[0].id);
        return toNetwork(this.networkRow('select * from networks where id = ?', routed[0].id) as NetworkRow);
      }
    }
    let row = this.networkRow('select * from networks where fingerprint = ?', identity.fingerprint);
    if (!row) {
      // Networks migrated from before networks existed match any scan of the same range;
      // subnet-only networks are refined once their router is known.
      row = this.networkRow(
        `select * from networks where gateway_mac is null and cidr = ?
           and (fingerprint like 'legacy:%' or (? = 1 and fingerprint like 'subnet:%'))
         order by last_scan_at desc limit 1`,
        identity.cidr,
        identity.local ? 1 : 0,
      );
    }
    if (row) {
      this.db
        .prepare(
          `update networks set fingerprint = ?, cidr = ?, gateway_ip = coalesce(?, gateway_ip),
             gateway_mac = coalesce(?, gateway_mac), last_scan_at = ? where id = ?`,
        )
        .run(identity.fingerprint, identity.cidr, identity.gatewayIp ?? null, identity.gatewayMac ?? null, now, row.id);
      return toNetwork(this.networkRow('select * from networks where id = ?', row.id) as NetworkRow);
    }
    const id = randomUUID();
    this.db
      .prepare(
        `insert into networks (id, name, fingerprint, cidr, gateway_ip, gateway_mac, created_at, last_scan_at)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, defaultNetworkName(identity), identity.fingerprint, identity.cidr, identity.gatewayIp ?? null, identity.gatewayMac ?? null, now, now);
    return toNetwork(this.networkRow('select * from networks where id = ?', id) as NetworkRow);
  }

  networks(): Network[] {
    return (this.db.prepare('select * from networks order by last_scan_at desc').all() as unknown as NetworkRow[]).map(toNetwork);
  }

  renameNetwork(id: string, name: string): Network {
    this.db.prepare('update networks set name = ? where id = ?').run(name, id);
    const row = this.networkRow('select * from networks where id = ?', id);
    if (!row) throw new Error('Network not found');
    return toNetwork(row);
  }

  removeNetwork(id: string) {
    this.db.prepare('delete from networks where id = ?').run(id);
  }

  /** Deletes a network that holds no devices (a scan that found nothing). Returns true if deleted. */
  removeNetworkIfEmpty(id: string): boolean {
    const { n } = this.db.prepare('select count(*) as n from assets where network_id = ?').get(id) as { n: number };
    if (n > 0) return false;
    this.removeNetwork(id);
    return true;
  }

  /**
   * Inserts or updates the asset for a host seen in `runId` on `networkId`. Within a run, later
   * events carry more complete data and replace earlier ones. A host first seen without a MAC is
   * re-keyed when its MAC becomes known.
   */
  upsert(host: DiscoveredHost, runId: string, networkId: string): Asset {
    const now = new Date().toISOString();
    const key = keyFor(host);
    let row = this.row('select * from assets where network_id = ? and key = ?', networkId, key);
    if (!row && host.mac) row = this.row('select * from assets where network_id = ? and key = ?', networkId, `ip:${host.ip}`);
    if (!row && !host.mac)
      row = this.row('select * from assets where network_id = ? and ip = ? order by last_seen desc limit 1', networkId, host.ip);

    // A scan that cannot see MAC addresses (a remote range, or no local network permission) keeps
    // the MAC already known for the device, and where it came from, until a scan sees one.
    if (row && !host.mac && row.mac) {
      const prev = JSON.parse(row.data) as DiscoveredHost;
      host = { ...host, mac: row.mac, macSource: prev.macSource, vendor: host.vendor ?? prev.vendor };
    }
    // Identify evidence is collected only by some scans (not without a port scan, and devices do
    // not always answer): a scan without it keeps the evidence already known, and the type it gives.
    // Only for the same device: an address alone may have been handed to another device.
    if (row && !host.observed && host.mac && row.mac === host.mac) {
      const prev = JSON.parse(row.data) as DiscoveredHost;
      if (prev.observed) {
        const gateway = this.networkRow('select * from networks where id = ?', networkId)?.gateway_ip;
        host = { ...host, observed: prev.observed };
        Object.assign(host, classifyHost(host, gateway ? [gateway] : []));
        host.risks = evaluateRisks(host);
      }
    }
    const data = JSON.stringify(host);
    if (row) {
      const newKey = host.mac ? keyFor(host) : row.key;
      this.db
        .prepare('update assets set key = ?, ip = ?, mac = coalesce(?, mac), data = ?, last_seen = ?, last_run_id = ? where id = ?')
        .run(newKey, host.ip, host.mac ?? null, data, now, runId, row.id);
      return toAsset(this.row(`${ASSET_SELECT} where a.id = ?`, row.id) as AssetRow);
    }

    const id = randomUUID();
    this.db
      .prepare(
        `insert into assets (id, network_id, key, ip, mac, data, first_seen, last_seen, first_run_id, last_run_id)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, networkId, key, host.ip, host.mac ?? null, data, now, now, runId, runId);
    return toAsset(this.row(`${ASSET_SELECT} where a.id = ?`, id) as AssetRow);
  }

  list(): Asset[] {
    return (this.db.prepare(`${ASSET_SELECT} order by a.last_seen desc`).all() as unknown as AssetRow[]).map(toAsset);
  }

  /** Returns the assets with these ids, in the order the ids were given; unknown ids are skipped. */
  get(ids: string[]): Asset[] {
    if (!ids.length) return [];
    const marks = ids.map(() => '?').join(',');
    const found = new Map(
      (this.db.prepare(`${ASSET_SELECT} where a.id in (${marks})`).all(...ids) as unknown as AssetRow[]).map((r) => {
        const a = toAsset(r);
        return [a.id, a] as const;
      }),
    );
    return ids.flatMap((id) => found.get(id) ?? []);
  }

  remove(id: string) {
    this.db.prepare('delete from assets where id = ?').run(id);
  }

  clear() {
    this.db.exec('delete from assets; delete from scan_runs; delete from networks;');
  }

  countNew(runId: string): number {
    return (this.db.prepare('select count(*) as n from assets where first_run_id = ?').get(runId) as { n: number }).n;
  }

  recordRun(s: ScanSummary) {
    this.db
      .prepare(
        `insert or replace into scan_runs (id, network_id, targets, started_at, finished_at, status, scanned, live, new_assets, open_ports, risks)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.runId, s.networkId ?? null, s.targets, s.startedAt, s.finishedAt, s.status, s.scanned, s.live, s.newAssets, s.openPorts, s.risks);
  }

  /** Removes one scan from the history; devices and networks are kept. */
  removeRun(id: string) {
    this.db.prepare('delete from scan_runs where id = ?').run(id);
  }

  runs(limit = 20): ScanSummary[] {
    const rows = this.db.prepare('select * from scan_runs order by started_at desc limit ?').all(limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      runId: String(r.id),
      networkId: r.network_id ? String(r.network_id) : undefined,
      targets: String(r.targets),
      startedAt: String(r.started_at),
      finishedAt: String(r.finished_at),
      status: r.status as ScanSummary['status'],
      scanned: Number(r.scanned),
      live: Number(r.live),
      newAssets: Number(r.new_assets),
      openPorts: Number(r.open_ports),
      risks: Number(r.risks),
    }));
  }

  /**
   * Gives MAC addresses (and vendors) read over SNMP to devices of a network that have none, or
   * whose address also came from SNMP and has changed (the IP now belongs to another device).
   * Device identity is untouched, so later scans without MAC addresses still match by IP.
   * Returns how many devices were updated.
   */
  fillMacs(networkId: string, entries: { ip: string; mac: string; vendor?: string }[]): number {
    const byIp = new Map(entries.map((e) => [e.ip, e]));
    const rows = this.db.prepare('select * from assets where network_id = ?').all(networkId) as unknown as AssetRow[];
    const update = this.db.prepare('update assets set mac = ?, data = ? where id = ?');
    let changed = 0;
    for (const row of rows) {
      const found = byIp.get(row.ip);
      if (!found) continue;
      const host = JSON.parse(row.data) as DiscoveredHost;
      const replaceable = !host.mac || (host.macSource === 'snmp' && host.mac !== found.mac);
      if (!replaceable) continue;
      const vendor = found.vendor && found.vendor !== 'Private address' ? found.vendor : host.macSource === 'snmp' ? undefined : host.vendor;
      update.run(found.mac, JSON.stringify({ ...host, mac: found.mac, macSource: 'snmp', vendor }), row.id);
      changed++;
    }
    return changed;
  }

  /**
   * Names the vendor of devices that have a MAC address but no vendor yet, after the vendor
   * database grew. Returns how many devices were updated.
   */
  fillVendors(lookup: (mac: string) => string | undefined): number {
    const rows = this.db.prepare('select * from assets where mac is not null').all() as unknown as AssetRow[];
    const update = this.db.prepare('update assets set data = ? where id = ?');
    let changed = 0;
    for (const row of rows) {
      const host = JSON.parse(row.data) as DiscoveredHost;
      if (host.vendor && host.vendor !== 'Private address') continue;
      const vendor = lookup(row.mac as string);
      if (!vendor || vendor === host.vendor) continue;
      update.run(JSON.stringify({ ...host, vendor }), row.id);
      changed++;
    }
    return changed;
  }

  /** Encrypted SNMP secret of a network, as stored by `setSnmpSecret`. */
  snmpSecret(networkId: string): { version: string; secret: string; updatedAt: string } | undefined {
    const row = this.db.prepare('select version, secret, updated_at from snmp_credentials where network_id = ?').get(networkId) as
      | { version: string; secret: string; updated_at: string }
      | undefined;
    return row ? { version: row.version, secret: row.secret, updatedAt: row.updated_at } : undefined;
  }

  setSnmpSecret(networkId: string, version: string, secret: string) {
    this.db
      .prepare(
        `insert into snmp_credentials (network_id, version, secret, updated_at) values (?, ?, ?, ?)
         on conflict(network_id) do update set version = excluded.version, secret = excluded.secret, updated_at = excluded.updated_at`,
      )
      .run(networkId, version, secret, new Date().toISOString());
  }

  clearSnmpSecret(networkId: string) {
    this.db.prepare('delete from snmp_credentials where network_id = ?').run(networkId);
  }

  gearSnapshot(networkId: string): GearSnapshot | null {
    const row = this.db.prepare('select data from gear_snapshots where network_id = ?').get(networkId) as { data: string } | undefined;
    if (!row) return null;
    // Readings stored before devices were merged can hold one device several times.
    const snapshot = JSON.parse(row.data) as GearSnapshot;
    return { ...snapshot, devices: uniqueGear(snapshot.devices) };
  }

  saveGearSnapshot(snapshot: GearSnapshot) {
    this.db
      .prepare(
        `insert into gear_snapshots (network_id, collected_at, data) values (?, ?, ?)
         on conflict(network_id) do update set collected_at = excluded.collected_at, data = excluded.data`,
      )
      .run(snapshot.networkId, snapshot.collectedAt, JSON.stringify(snapshot));
  }

  close() {
    this.db.close();
  }
}

/** Numeric value of a dotted IPv4 address, so 10.0.0.9 sorts before 10.0.0.10. */
const ipv4Value = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + (Number(o) || 0), 0);

/** Orders assets by IPv4 address, lowest first. */
export function sortByIp(assets: Asset[]): Asset[] {
  return [...assets].sort((a, b) => ipv4Value(a.ip) - ipv4Value(b.ip));
}

/** Serialises assets as CSV with a header row. */
export function assetsToCsv(assets: Asset[], networkNames: Record<string, string> = {}): string {
  const header = ['Network', 'Name', 'IP address', 'IPv6 addresses', 'MAC address', 'Vendor', 'Type', 'Operating system', 'Open ports', 'Risks', 'First seen', 'Last seen'];
  const rows = assets.map((a) => [
      networkNames[a.networkId] ?? '',
      a.hostname ?? '',
      a.ip,
      (a.ipv6 ?? []).map((x) => x.address).join(' '),
      a.mac ?? '',
      a.vendor ?? '',
      a.type,
      a.os ?? '',
      a.ports.map((p) => `${p.port}/${p.service}`).join(' '),
      a.risks.map((r) => `${r.severity}: ${r.title}`).join('; '),
      a.firstSeen,
      a.lastSeen,
  ]);
  return toCsv(header, rows);
}
