import { deviceDetailsText, reportedIdentity, type DeviceDetailsInput } from '@shared/device-details';
import { parseDeviceModel } from '@shared/model';
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ClipboardCopy,
  Download,
  Globe,
  Layers,
  MonitorUp,
  Radar,
  RadioTower,
  Search,
  ShieldAlert,
  Sparkle,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { Asset, DeviceType, PingResult } from '@shared/types';
import type { ConnectionRow, NodeFacts } from './map-model';
import { cleanError, useStore } from './store';
import { NetworkStrip } from './Networks';
import { Copyable, DeviceTile, EmptyState, V6Pill, PortChips, SeverityBadge, displayName, relativeTime, topSeverity, typeLabel } from './ui';

export type SortKey = 'name' | 'ip' | 'mac' | 'vendor' | 'type' | 'risk' | 'seen';
type Filter = 'all' | 'risks' | 'new';

const WEB_PORTS = [80, 443, 8080, 8443, 8000, 8008, 8081, 8888, 9000, 5000, 5001];
const ipValue = (ip: string) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);
const riskValue = (a: Asset) => (a.risks.length ? { high: 3, medium: 2, low: 1 }[topSeverity(a) ?? 'low'] : 0);

/** Orders two assets by one column; callers multiply by 1 or -1 for direction. */
export function compareAssets(a: Asset, b: Asset, key: SortKey): number {
  switch (key) {
    case 'name':
      return displayName(a).localeCompare(displayName(b));
    case 'ip':
      return ipValue(a.ip) - ipValue(b.ip);
    case 'mac':
      return (a.mac ?? '~').localeCompare(b.mac ?? '~');
    case 'vendor':
      return (a.vendor ?? '~').localeCompare(b.vendor ?? '~');
    case 'type':
      return typeLabel(a.type).localeCompare(typeLabel(b.type));
    case 'risk':
      return riskValue(a) - riskValue(b) || a.risks.length - b.risks.length;
    case 'seen':
      return Date.parse(a.lastSeen) - Date.parse(b.lastSeen);
  }
}

const RISK_LABEL = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' } as const;
/** Four-packet ping series: one row per echo request, then loss and round-trip statistics. */
function PingPanel({ ip, result, onClose }: { ip: string; result?: PingResult; onClose: () => void }) {
  const slowest = Math.max(1, ...(result?.replies.map((r) => r.timeMs ?? 0) ?? []));
  return (
    <section className="ping-panel" aria-label={`Ping results for ${ip}`} aria-busy={!result}>
      <div className="ping-head">
        <span>Ping {ip}</span>
        {result && (
          <span className={`ping-loss ${result.lossPct === 0 ? 'ok' : result.lossPct === 100 ? 'bad' : 'warn'}`}>
            {result.lossPct}% loss
          </span>
        )}
        <button className="icon-btn" aria-label="Close ping results" onClick={onClose}>
          <X className="icon" />
        </button>
      </div>
      <ol className="ping-rows">
        {(result?.replies ?? [1, 2, 3, 4].map((seq) => ({ seq, timeMs: undefined }))).map((r) => (
          <li key={r.seq} className={!result ? 'pending' : r.timeMs === undefined ? 'lost' : 'ok'}>
            <span className="seq">#{r.seq}</span>
            <span className="bar">
              {result && r.timeMs !== undefined && <span style={{ width: `${Math.max(4, (r.timeMs / slowest) * 100)}%` }} />}
            </span>
            <span className="val mono">
              {!result ? '…' : r.timeMs === undefined ? 'timeout' : `${Math.round(r.timeMs * 10) / 10} ms`}
            </span>
          </li>
        ))}
      </ol>
      {result && (
        <div className="ping-stats">
          <span>
            {result.sent} sent · {result.received} received
          </span>
          {result.received > 0 && (
            <span className="mono">
              min {result.minMs} / avg {result.avgMs} / max {result.maxMs} ms
            </span>
          )}
        </div>
      )}
    </section>
  );
}

/** User names accepted for SSH: the portable POSIX set plus dots, up to 64 characters. */
const SSH_USER = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;

/** localStorage key for the last SSH user, per device or across all devices. */
function sshUserKey(assetId?: string) {
  return assetId ? `ssh-user:${assetId}` : 'ssh-user';
}

const SCOPE_LABEL = { global: 'global', 'unique-local': 'unique local', 'link-local': 'link-local' } as const;

const NAME_SOURCE = { mdns: 'Bonjour / mDNS', netbios: 'NetBIOS', dns: 'DNS' } as const;

/**
 * Device inspector: identity, actions, risks, ports, names and classification evidence.
 * `onClose` adds a close button and is used when the inspector floats over another page.
 */
/** Where a device is plugged in: the device above it, the switch port, VLAN, PoE and the path up. */
export function ConnectionSection({ row }: { row: ConnectionRow }) {
  return (
    <>
      <div className="section-title">Connection</div>
      <dl className="kv">
        {row.connectedTo && (
          <>
            <dt>Connected to</dt>
            <dd>
              {row.connectedTo.name}
              {row.connectedTo.ip && <span className="muted mono"> · {row.connectedTo.ip}</span>}
            </dd>
          </>
        )}
        {row.switch && (
          <>
            <dt>Switch port</dt>
            <dd>
              {row.switchPort ? <span className="mono">{row.switchPort}</span> : <span className="muted">Unknown port</span>}
              <span className="muted"> on {row.switch.name}</span>
            </dd>
          </>
        )}
        {row.vlan !== undefined && (
          <>
            <dt>VLAN</dt>
            <dd>{row.vlan}</dd>
          </>
        )}
        {row.poeWatts !== undefined && (
          <>
            <dt>PoE</dt>
            <dd>{row.poeWatts} W</dd>
          </>
        )}
        {row.path && (
          <>
            <dt>Path</dt>
            <dd className="conn-path">{row.path}</dd>
          </>
        )}
        <dt>Source</dt>
        <dd>{row.confirmed ? 'Seen by a switch' : <span className="muted">Assumed from device roles</span>}</dd>
      </dl>
    </>
  );
}

/**
 * Drawer for a device on the map that is not in the inventory: one a switch learned on a port, a
 * neighbour that announced itself over LLDP, or an unmanaged segment. Shows what the map knows.
 */
export function NodeDetail({
  facts,
  gear,
  connection,
  note,
  behind,
  onClose,
}: {
  facts: NodeFacts;
  gear?: GearFacts;
  connection?: ConnectionRow;
  /** One line on where Meshwork learned about the device. */
  note: string;
  /** Devices drawn behind it (for a segment or access point). */
  behind?: number;
  onClose: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult>();
  const [pingOpen, setPingOpen] = useState(false);
  const type = gear?.type && gear.type !== 'unknown' ? gear.type : (facts.type ?? 'unknown');
  const ip = facts.ip;
  const ping = async () => {
    if (!ip) return;
    setPinging(true);
    setPingOpen(true);
    setPingResult(undefined);
    try {
      setPingResult(await window.api.actions.ping(ip));
    } catch (err) {
      setPingOpen(false);
      toast('error', cleanError(err));
    } finally {
      setPinging(false);
    }
  };
  return (
    <aside className="detail drawer" aria-label="Device details">
      <div className="insp-head">
        <DeviceTile type={type} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h3>{facts.name}</h3>
          <p className="mono muted">{[ip, facts.mac].filter(Boolean).join(' · ') || 'No address known'}</p>
          <p style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="chip static" style={{ height: 20 }}>
              {typeLabel(type)}
            </span>
            <span className="chip static" style={{ height: 20 }}>
              Not in inventory
            </span>
          </p>
        </div>
        <button className="icon-btn insp-close" aria-label="Close device details" onClick={onClose}>
          <X className="icon" />
        </button>
      </div>
      {ip && (
        <div className="actions">
          <button title="Open the device's web page" onClick={() => void window.api.actions.web(ip, false).catch((err: unknown) => toast('error', cleanError(err)))}>
            <Globe className="icon" />
            Web
          </button>
          <button disabled={pinging} title="Send four pings" onClick={() => void ping()}>
            <RadioTower className="icon" />
            {pinging ? 'Pinging…' : 'Ping'}
          </button>
        </div>
      )}
      {ip && pingOpen && <PingPanel ip={ip} result={pingResult} onClose={() => setPingOpen(false)} />}
      <div className="insp-body">
        <DeviceSectionTitle
          details={() => ({
            name: facts.name,
            ip,
            mac: facts.mac,
            vendor: facts.vendor,
            type: typeLabel(type),
            gear,
            connection: connection && connectionDetails(connection),
            note: behind !== undefined ? `${note} ${behind} ${behind === 1 ? 'device' : 'devices'} behind it.` : note,
          })}
        />
        <dl className="kv">
          <dt>IP address</dt>
          <dd>{ip ? <Copyable value={ip} label="IP address" mono /> : <span className="muted">Unknown</span>}</dd>
          <dt>MAC address</dt>
          <dd>{facts.mac ? <Copyable value={facts.mac} label="MAC address" mono /> : <span className="muted">Unknown</span>}</dd>
          <dt>Vendor</dt>
          <dd>{facts.vendor ? <Copyable value={facts.vendor} label="vendor" /> : <span className="muted">Unknown</span>}</dd>
          {gear && <GearRows gear={gear} />}
          {behind !== undefined && (
            <>
              <dt>Behind it</dt>
              <dd>
                {behind} {behind === 1 ? 'device' : 'devices'}
              </dd>
            </>
          )}
        </dl>
        {connection && <ConnectionSection row={connection} />}
        <p className="muted node-note">{note}</p>
      </div>
    </aside>
  );
}

function connectionDetails(row: ConnectionRow): NonNullable<DeviceDetailsInput['connection']> {
  return { path: row.path, switchName: row.switch?.name, switchPort: row.switchPort, vlan: row.vlan, poeWatts: row.poeWatts, confirmed: row.confirmed };
}

/** "Device" heading of the drawer with a button that copies everything known about the device as text. */
function DeviceSectionTitle({ details }: { details: () => DeviceDetailsInput }) {
  const toast = useStore((s) => s.toast);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="section-title with-action">
      <span>Device</span>
      <button
        type="button"
        className="btn ghost sm"
        title="Copy everything shown about this device as text"
        onClick={() =>
          window.api.app
            .copyText(deviceDetailsText(details()))
            .then(() => setCopied(true))
            .catch(() => toast('error', 'Could not copy the device details.'))
        }
      >
        {copied ? <Check className="icon" /> : <ClipboardCopy className="icon" />}
        {copied ? 'Copied' : 'Copy details'}
      </button>
    </div>
  );
}

/** What a device told the identify phase: the model and maker it reports, its web page, certificate and SSH greeting. */
function ObservedRows({ asset }: { asset: Asset }) {
  const o = asset.observed;
  if (!o) return null;
  const id = reportedIdentity(o);
  const page = o['http.title']?.[0];
  return (
    <>
      {id?.model && (
        <>
          <dt>Model</dt>
          <dd>
            <Copyable value={id.model} label="model" /> <span className="muted">· {id.source}</span>
          </dd>
        </>
      )}
      {id?.manufacturer && (
        <>
          <dt>Maker</dt>
          <dd>{id.manufacturer}</dd>
        </>
      )}
      {page && (
        <>
          <dt>Web page</dt>
          <dd className="gear-descr" title={page}>
            {page}
          </dd>
        </>
      )}
      {o['tls.subject']?.[0] && (
        <>
          <dt>Certificate</dt>
          <dd className="gear-descr mono" title={o['tls.subject'][0]}>
            {o['tls.subject'][0]}
          </dd>
        </>
      )}
      {o.ssh?.[0] && (
        <>
          <dt>SSH</dt>
          <dd className="mono">{o.ssh[0]}</dd>
        </>
      )}
      {o.services?.length ? (
        <>
          <dt>Announces</dt>
          <dd className="gear-descr" title={o.services.join(', ')}>
            {o.services.join(', ')}
          </dd>
        </>
      ) : null}
    </>
  );
}

/** What a device says about itself over SNMP or LLDP, shown in the drawer when the map knows it. */
export interface GearFacts {
  name?: string;
  /** Type the map gives the device (a switch read over SNMP, an access point that announced itself). */
  type?: DeviceType;
  description?: string;
  source: 'snmp' | 'lldp';
}

/** Model, firmware, announced name and full description from SNMP or LLDP. */
export function GearRows({ gear }: { gear: GearFacts }) {
  const { model, firmware } = parseDeviceModel(gear.description);
  const via = gear.source === 'snmp' ? 'read over SNMP' : 'announced over LLDP';
  return (
    <>
      {gear.description !== undefined && (
        <>
          <dt>Model</dt>
          <dd>{model ? <Copyable value={model} label="model" /> : <span className="muted">Not reported</span>}</dd>
        </>
      )}
      {firmware && (
        <>
          <dt>Firmware</dt>
          <dd>
            <Copyable value={firmware} label="firmware" mono />
          </dd>
        </>
      )}
      {gear.name && (
        <>
          <dt>Device name</dt>
          <dd>
            <Copyable value={gear.name} label="device name" /> <span className="muted">· {via}</span>
          </dd>
        </>
      )}
      {gear.description && (
        <>
          <dt>Description</dt>
          <dd className="gear-descr" title={gear.description}>
            {gear.description}
          </dd>
        </>
      )}
    </>
  );
}

export function Detail({
  asset,
  gear,
  connection,
  onClose,
  className,
}: {
  asset: Asset;
  gear?: GearFacts;
  /** Where the map shows the device plugged in. */
  connection?: ConnectionRow;
  onClose?: () => void;
  className?: string;
}) {
  const remove = useStore((s) => s.removeAsset);
  const toast = useStore((s) => s.toast);
  const networkName = useStore((s) => s.networks.find((n) => n.id === asset.networkId)?.name);
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<PingResult>();
  const [pingOpen, setPingOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [sshUser, setSshUser] = useState('');
  const has = (...ports: number[]) => asset.ports.some((p) => ports.includes(p.port));

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (err) {
      toast('error', cleanError(err));
    }
  };
  const ping = async () => {
    setPinging(true);
    setPingOpen(true);
    setPingResult(undefined);
    try {
      setPingResult(await window.api.actions.ping(asset.ip));
    } catch (err) {
      setPingOpen(false);
      toast('error', cleanError(err));
    } finally {
      setPinging(false);
    }
  };

  const top = asset.risks[0];
  // What a device reports about itself over SNMP or LLDP beats the scan's guess, as on the map.
  const type = gear?.type && gear.type !== 'unknown' ? gear.type : asset.type;
  return (
    <aside className={className ? `detail ${className}` : 'detail'} aria-label="Device details">
      <div className="insp-head">
        <DeviceTile type={type} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h3>{asset.hostname || gear?.name || displayName(asset)}</h3>
          <p className="mono muted">
            {asset.ip}
            {asset.mac ? ` · ${asset.mac}` : ''}
          </p>
          <p style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {top && <SeverityBadge severity={top.severity}>{RISK_LABEL[top.severity]}</SeverityBadge>}
            <span className="chip static" style={{ height: 20 }}>
              {typeLabel(type)}
            </span>
            {asset.isNew && (
              <span className="new-pill" style={{ marginLeft: 0 }}>
                New
              </span>
            )}
          </p>
        </div>
        {onClose && (
          <button className="icon-btn insp-close" aria-label="Close device details" onClick={onClose}>
            <X className="icon" />
          </button>
        )}
      </div>

      <div className="actions">
        <button
          disabled={!has(22)}
          title={has(22) ? 'Open an SSH session in Terminal' : 'SSH (port 22) is not open'}
          aria-expanded={sshOpen}
          onClick={() => {
            setSshUser(localStorage.getItem(sshUserKey(asset.id)) ?? localStorage.getItem(sshUserKey()) ?? '');
            setSshOpen((open) => !open);
          }}
        >
          <Terminal className="icon" />
          SSH
        </button>
        <button
          disabled={!has(...WEB_PORTS)}
          title={has(...WEB_PORTS) ? "Open the device's web page" : 'No web port is open'}
          onClick={() => void run(() => window.api.actions.web(asset.ip, has(443, 8443, 5001) && !has(80)))}
        >
          <Globe className="icon" />
          Web
        </button>
        <button
          disabled={!has(3389)}
          title={has(3389) ? 'Open a remote desktop session' : 'Remote desktop (3389) is not open'}
          onClick={() => void run(() => window.api.actions.remoteDesktop(asset.ip))}
        >
          <MonitorUp className="icon" />
          Remote
        </button>
        <button disabled={pinging} title="Send four pings" onClick={() => void ping()}>
          <RadioTower className="icon" />
          {pinging ? 'Pinging…' : 'Ping'}
        </button>
      </div>

      {pingOpen && <PingPanel ip={asset.ip} result={pingResult} onClose={() => setPingOpen(false)} />}

      {sshOpen && (
        <form
          className="ssh-form"
          onSubmit={(e) => {
            e.preventDefault();
            const user = sshUser.trim();
            if (!SSH_USER.test(user)) {
              toast('error', 'Enter a valid user name (letters, digits, dot, dash or underscore).');
              return;
            }
            localStorage.setItem(sshUserKey(asset.id), user);
            localStorage.setItem(sshUserKey(), user);
            setSshOpen(false);
            void run(() => window.api.actions.ssh(asset.ip, user));
          }}
        >
          <label className="input">
            <span className="sr-only">SSH user</span>
            <input
              autoFocus
              placeholder="User, e.g. admin"
              value={sshUser}
              spellCheck={false}
              autoCapitalize="off"
              onChange={(e) => setSshUser(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setSshOpen(false))}
            />
          </label>
          <button className="btn primary sm" type="submit">
            Connect
          </button>
        </form>
      )}

      <div className="insp-body">
        <DeviceSectionTitle
          details={() => ({
            name: asset.hostname || gear?.name || displayName(asset),
            ip: asset.ip,
            mac: asset.mac,
            vendor: asset.vendor,
            type: typeLabel(type),
            scanType: type !== asset.type && asset.type !== 'unknown' ? typeLabel(asset.type) : undefined,
            confidence: asset.typeConfidence,
            os: asset.os,
            osConfidence: asset.osConfidence,
            hostname: asset.hostname,
            names: asset.names,
            aliveVia: asset.aliveVia,
            rttMs: asset.rttMs,
            ttl: asset.ttl,
            ports: asset.ports,
            evidence: asset.evidence,
            fingerprint: asset.fingerprint,
            observed: asset.observed,
            gear,
            connection: connection && connectionDetails(connection),
          })}
        />
        <dl className="kv">
          <dt>IP address</dt>
          <dd>
            <Copyable value={asset.ip} label="IP address" mono />
          </dd>
          {asset.ipv6?.length ? (
            <>
              <dt>IPv6</dt>
              <dd className="v6-list">
                {asset.ipv6.map((a) => (
                  <div key={a.address}>
                    <Copyable value={a.address} label="IPv6 address" mono />
                    <span className="v6-scope">{SCOPE_LABEL[a.scope]}</span>
                  </div>
                ))}
              </dd>
            </>
          ) : null}
          <dt>MAC address</dt>
          <dd>{asset.mac ? <Copyable value={asset.mac} label="MAC address" mono /> : <span className="muted">Unknown</span>}</dd>
          <dt>Vendor</dt>
          <dd>{asset.vendor ? <Copyable value={asset.vendor} label="vendor" /> : <span className="muted">Unknown</span>}</dd>
          {gear && <GearRows gear={gear} />}
          {!gear && <ObservedRows asset={asset} />}
          <dt>Network</dt>
          <dd>{networkName ? <Copyable value={networkName} label="network name" /> : <span className="muted">Unknown</span>}</dd>
          <dt>Type</dt>
          <dd>
            {typeLabel(type)}
            {type !== asset.type ? (
              <span className="muted"> · {gear?.source === 'snmp' ? 'read over SNMP' : 'announced over LLDP'}</span>
            ) : (
              asset.typeConfidence > 0 && <span className="muted"> · {Math.round(asset.typeConfidence * 100)}% confidence</span>
            )}
          </dd>
          <dt>OS</dt>
          <dd>
            {asset.os ?? <span className="muted">Unknown</span>}
            {asset.os && asset.osConfidence ? <span className="muted"> · {Math.round(asset.osConfidence * 100)}% confidence</span> : null}
          </dd>
          <dt>Hostname</dt>
          <dd>{asset.hostname ? <Copyable value={asset.hostname} label="hostname" mono /> : <span className="muted">Not found</span>}</dd>
          <dt>Answered by</dt>
          <dd>
            {asset.aliveVia.map((v) => ({ tcp: 'TCP', icmp: 'ping', arp: 'ARP' })[v]).join(', ') || '—'}
            {asset.rttMs !== undefined ? ` · ${asset.rttMs} ms` : ''}
            {asset.ttl !== undefined ? ` · TTL ${asset.ttl}` : ''}
          </dd>
          <dt>First seen</dt>
          <dd>{new Date(asset.firstSeen).toLocaleString()}</dd>
          <dt>Last seen</dt>
          <dd>{relativeTime(asset.lastSeen)}</dd>
        </dl>

        {connection && <ConnectionSection row={connection} />}

        {type !== asset.type ? (
          <>
            <div className="section-title">Why this type</div>
            <ul className="evidence">
              <li>
                {gear?.source === 'snmp' ? 'reports itself' : 'announces itself over LLDP'} as {typeLabel(type).toLowerCase()}
              </li>
              {asset.type !== 'unknown' && <li className="muted">the scan alone guessed {typeLabel(asset.type).toLowerCase()}</li>}
            </ul>
          </>
        ) : (
          asset.evidence.length > 0 && (
            <>
              <div className="section-title">Why this type</div>
              <ul className="evidence">
                {asset.evidence.map((e) => (
                  <li key={e}>{e}</li>
                ))}
              </ul>
            </>
          )
        )}

        <div className="section-title">Risks · {asset.risks.length}</div>
        {asset.risks.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No risks detected on the ports that were scanned.
          </p>
        ) : (
          asset.risks.map((r) => (
            <div key={r.ruleId} className="risk-item">
              <SeverityBadge severity={r.severity} />
              <div>
                <div className="ttl">{r.title}</div>
                <div className="fix">{r.detail}</div>
              </div>
            </div>
          ))
        )}

        <div className="section-title">Open ports · {asset.ports.length}</div>
        {asset.ports.length ? (
          <div className="ports" style={{ gap: 6 }}>
            {asset.ports.map((p) => (
              <span key={p.port} className="port">
                {p.port} {p.service}
              </span>
            ))}
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            None found.
          </p>
        )}

        {asset.names.length > 0 && (
          <>
            <div className="section-title">Names</div>
            <dl className="kv">
              {asset.names.map((n) => (
                <div key={n.source + n.name} style={{ display: 'contents' }}>
                  <dt>{NAME_SOURCE[n.source]}</dt>
                  <dd>
                    <Copyable value={n.name} label={`${NAME_SOURCE[n.source]} name`} mono />
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}

        <div style={{ marginTop: 22 }}>
          <button className="btn sm ghost" style={{ color: 'var(--danger-text)' }} onClick={() => void remove(asset.id)}>
            <Trash2 className="icon" /> Remove from inventory
          </button>
        </div>
      </div>
    </aside>
  );
}

export function Inventory() {
  const assets = useStore((s) => s.assets);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const runs = useStore((s) => s.runs);
  const networks = useStore((s) => s.networks);
  const networkFilter = useStore((s) => s.networkFilter);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [type, setType] = useState<DeviceType | 'any'>('any');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'ip', dir: 1 });

  const everything = useMemo(() => Object.values(assets), [assets]);
  const network = networkFilter === 'all' ? undefined : networks.find((n) => n.id === networkFilter);
  const all = useMemo(() => (network ? everything.filter((a) => a.networkId === network.id) : everything), [everything, network]);
  const networkName = useMemo(() => Object.fromEntries(networks.map((n) => [n.id, n.name])), [networks]);
  const lastScan = network ? network.lastScanAt : runs[0]?.startedAt;
  const types = useMemo(() => [...new Set(all.map((a) => a.type))].sort(), [all]);
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((a) => filter === 'all' || (filter === 'risks' ? a.risks.length > 0 : a.isNew))
      .filter((a) => type === 'any' || a.type === type)
      .filter(
        (a) =>
          !q ||
          [a.hostname, a.ip, a.mac, a.vendor, a.os, typeLabel(a.type), ...a.ports.map((p) => `${p.port} ${p.service}`), ...(a.ipv6 ?? []).map((x) => x.address)].some((v) =>
            v?.toLowerCase().includes(q),
          ),
      )
      .sort((a, b) => compareAssets(a, b, sort.key) * sort.dir);
  }, [all, query, filter, type, sort]);

  // A device from another network stays selected in the store but is not shown here.
  const selected = selectedId ? all.find((a) => a.id === selectedId) : undefined;
  const withRisks = all.filter((a) => a.risks.length).length;
  const fresh = all.filter((a) => a.isNew).length;

  const exportCsv = async () => {
    try {
      const path = await window.api.inventory.exportCsv(rows.map((r) => r.id));
      if (path) toast('success', `Exported ${rows.length} devices to ${path}`);
    } catch (err) {
      toast('error', cleanError(err));
    }
  };

  const header = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'risk' || key === 'seen' ? -1 : 1 }))}>
        {label}
        {sort.key === key &&
          (sort.dir === 1 ? <ArrowUp className="icon" style={{ width: 12, height: 12 }} /> : <ArrowDown className="icon" style={{ width: 12, height: 12 }} />)}
      </button>
    </th>
  );

  if (everything.length === 0) {
    return (
      <div className="page">
        <div className="page-h">
          <div>
            <h1>Inventory</h1>
            <p>Every device you discover is kept here, across scans.</p>
          </div>
        </div>
        <div className="panel">
          <EmptyState
            icon={Radar}
            title="No devices yet"
            action={
              <button className="btn primary" onClick={() => setView('discover')}>
                <Radar className="icon" /> Go to Discover
              </button>
            }
          >
            Run a scan to fill your inventory. Devices are remembered between scans so you can see what is new.
          </EmptyState>
        </div>
      </div>
    );
  }

  return (
    <div className="inv">
      <div className="inv-main">
        <div className="page-h">
          <div>
            <h1>Network Inventory</h1>
            <p>
              {network ? (
                <>
                  <span className="mono">{network.cidr}</span>
                  {network.gatewayIp ? ` · router ${network.gatewayIp}` : ''} · {all.length} devices
                </>
              ) : (
                `${networks.length} ${networks.length === 1 ? 'network' : 'networks'} · ${all.length} devices`
              )}
              {lastScan ? ` · last scan ${relativeTime(lastScan)}` : ''}
            </p>
          </div>
          <div className="right">
            <button className="btn" onClick={() => void exportCsv()}>
              <Download className="icon" /> Export CSV
            </button>
          </div>
        </div>
        <NetworkStrip assets={everything} />
        <div className="filters">
          <div className="input">
            <Search className="icon" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
              placeholder="Search name, IP, MAC, vendor, port…"
              aria-label="Search devices"
            />
            {query && (
              <button className="input-clear" aria-label="Clear search" title="Clear search" onClick={() => setQuery('')}>
                <X className="icon" />
              </button>
            )}
          </div>
          <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
            <Layers className="icon" /> All
          </button>
          <button className="chip" aria-pressed={filter === 'risks'} onClick={() => setFilter('risks')}>
            <ShieldAlert className="icon" /> Has risks · {withRisks}
          </button>
          <button className="chip" aria-pressed={filter === 'new'} onClick={() => setFilter('new')}>
            <Sparkle className="icon" /> New · {fresh}
          </button>
          <select
            className="select"
            style={{ height: 24, fontSize: 12, backgroundPosition: 'calc(100% - 14px) 10px, calc(100% - 9px) 10px' }}
            value={type}
            onChange={(e) => setType(e.target.value as DeviceType | 'any')}
            aria-label="Device type"
          >
            <option value="any">Any type</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {typeLabel(t)}
              </option>
            ))}
          </select>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>
            {rows.length} shown
          </span>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {header('name', 'Device')}
                {header('ip', 'IP address')}
                {header('vendor', 'MAC · vendor')}
                <th>Open ports</th>
                {header('risk', 'Risk')}
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const sev = topSeverity(a);
                return (
                  <tr key={a.id} aria-selected={a.id === selectedId} className={a.isNew ? 'new' : ''} onClick={() => select(a.id)}>
                    <td>
                      <div className="cell-dev">
                        <DeviceTile type={a.type} size="sm" />
                        <div>
                          <div className="n">
                            {displayName(a)}
                            {a.isNew && <span className="new-pill">New</span>}
                          </div>
                          <div className="s">
                            {typeLabel(a.type)}
                            {a.os ? ` · ${a.os}` : ''}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="clip">
                      <div className="mono">
                        {a.ip}
                        {a.ipv6?.length ? <V6Pill addresses={a.ipv6.map((x) => x.address)} /> : null}
                      </div>
                      {!network && <div className="sub-line">{networkName[a.networkId]}</div>}
                    </td>
                    <td className="clip" title={a.vendor}>
                      <div className="mono t2">{a.mac ?? '—'}</div>
                      {a.vendor && <div className="sub-line">{a.vendor}</div>}
                    </td>
                    <td>
                      <PortChips ports={a.ports} max={3} />
                    </td>
                    <td>{sev ? <SeverityBadge severity={sev} /> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 && (
            <EmptyState icon={Search} title="No matching devices">
              Try a different search or filter.
            </EmptyState>
          )}
        </div>
      </div>
      {selected ? (
        <Detail asset={selected} />
      ) : (
        <aside className="detail">
          <EmptyState icon={Layers} title="Select a device">
            Pick a row to see its details, risks and actions.
          </EmptyState>
        </aside>
      )}
    </div>
  );
}
