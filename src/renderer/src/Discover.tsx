import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import {
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  History,
  Loader,
  MonitorCheck,
  Play,
  PlugZap,
  Plus,
  Radar,
  ShieldAlert,
  Sparkle,
  Square,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { LocalTarget, PortProfile, ScanPhase, Timing } from '@shared/types';
import { cleanError, useStore } from './store';
import { compareAssets, Detail, type SortKey } from './Inventory';
import { DeviceTile, EmptyState, V6Pill, PortChips, SeverityBadge, displayName, relativeTime, topSeverity, typeLabel } from './ui';

const PHASES: { id: Exclude<ScanPhase, 'done'>; label: string }[] = [
  { id: 'liveness', label: 'Finding devices' },
  { id: 'names', label: 'Names & MAC' },
  { id: 'ports', label: 'Open ports' },
  { id: 'identify', label: 'Ask devices' },
  { id: 'analysis', label: 'Classify & check risks' },
];

const PROFILES: { id: PortProfile; label: string }[] = [
  { id: 'top', label: 'Common ports (~110)' },
  { id: 'all', label: 'All ports (1–65535)' },
  { id: 'custom', label: 'Custom ports…' },
  { id: 'none', label: 'Find devices only (no port scan)' },
];

/** One-line explanation under the selector of what each port profile checks. */
const PROFILE_HINT: Record<PortProfile, string> = {
  top: 'Checks about 110 common ports per device: SSH, Telnet, web, file sharing, printers, remote desktop, databases and more.',
  all: 'Checks all 65,535 ports per device: seconds for most devices, a few minutes for each one behind a firewall.',
  custom: 'Checks only the ports you list.',
  none: 'Only finds which devices are up. Ports noticed while doing so are shown, but most ports (Telnet, FTP, databases…) are not checked.',
};

function splitTokens(text: string): string[] {
  return text
    .split(/[;,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function TargetEditor({ disabled }: { disabled: boolean }) {
  const targets = useStore((s) => s.settings.targets);
  const setSettings = useStore((s) => s.setSettings);
  const [draft, setDraft] = useState('');
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [oversized, setOversized] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);
  const tokens = useMemo(() => splitTokens(targets), [targets]);

  useEffect(() => {
    let alive = true;
    void Promise.all(
      tokens.map(async (t) => {
        const r = await window.api.scan.parseTargets(t);
        return [t, r.errors.length > 0, r.tooLarge] as const;
      }),
    ).then((rows) => {
      if (!alive) return;
      setInvalid(new Set(rows.filter(([, bad]) => bad).map(([t]) => t)));
      setOversized(new Set(rows.filter(([, , big]) => big).map(([t]) => t)));
    });
    return () => {
      alive = false;
    };
  }, [tokens]);

  const commit = (text: string) => {
    const add = splitTokens(text).filter((t) => !tokens.includes(t));
    if (add.length) setSettings({ targets: [...tokens, ...add].join('; ') });
    setDraft('');
  };
  const remove = (t: string) => setSettings({ targets: tokens.filter((x) => x !== t).join('; ') });
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (['Enter', ',', ';', ' '].includes(e.key)) {
      e.preventDefault();
      if (draft.trim()) commit(draft);
    } else if (e.key === 'Backspace' && !draft && tokens.length) {
      remove(tokens[tokens.length - 1] as string);
    }
  };

  return (
    <div className="box" onClick={() => inputRef.current?.focus()}>
      {tokens.map((t) => (
        <span key={t} className={`tchip ${invalid.has(t) || oversized.has(t) ? 'bad' : ''}`} title={invalid.has(t) ? 'Not a valid IP, range or CIDR block' : oversized.has(t) ? 'Too many addresses for one scan' : undefined}>
          {t}
          {!disabled && (
            <button aria-label={`Remove ${t}`} onClick={() => remove(t)}>
              <X className="icon" />
            </button>
          )}
        </span>
      ))}
      <input
        ref={inputRef}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && commit(draft)}
        onPaste={(e) => {
          e.preventDefault();
          commit(e.clipboardData.getData('text'));
        }}
        placeholder={tokens.length ? 'Add IP, range or CIDR…' : 'e.g. 192.168.1.0/24, 10.0.0.1-50, 172.16.5.10'}
        aria-label="Scan targets"
        spellCheck={false}
      />
    </div>
  );
}

/** localStorage key set once the technician confirms they scan only networks they may assess. */
const AUTHORISED_KEY = 'scan-authorised';

/** Shown before the first scan: scanning networks without permission can be against the law. */
function AuthorisedDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (o: boolean) => void; onConfirm: () => void }) {
  const [agreed, setAgreed] = useState(false);
  useEffect(() => {
    if (open) setAgreed(false);
  }, [open]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog">
          <Dialog.Title asChild>
            <h2>Scan only networks you may assess</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p>
              Meshwork sends probes to every address in the range and reads network equipment. Use it only on networks and devices you own or are authorised to assess. Scanning
              without permission can be against the law where you are.
            </p>
          </Dialog.Description>
          <label className="map-check" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I own this network or am authorised to assess it
          </label>
          <div className="row">
            <Dialog.Close asChild>
              <button className="btn">Cancel</button>
            </Dialog.Close>
            <button className="btn primary" disabled={!agreed} onClick={onConfirm}>
              <Play className="icon" /> Start scan
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ScanControls() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const scan = useStore((s) => s.scan);
  const startScan = useStore((s) => s.startScan);
  const cancel = useStore((s) => s.cancelScan);
  const [askAuthorised, setAskAuthorised] = useState(false);
  // The first scan asks the technician to confirm they may scan; the answer is kept on this computer.
  const start = async () => {
    if (localStorage.getItem(AUTHORISED_KEY) !== '1') {
      setAskAuthorised(true);
      return;
    }
    await startScan();
  };
  const [local, setLocal] = useState<LocalTarget[]>([]);
  const [count, setCount] = useState<{ n: number; error?: string }>({ n: 0 });

  useEffect(() => {
    void window.api.scan.localTargets().then(setLocal);
  }, []);
  useEffect(() => {
    void window.api.scan
      .parseTargets(settings.targets)
      .then((r) =>
        setCount({
          n: r.count,
          error: r.largest
            ? `${r.largest.target} has ${r.largest.count.toLocaleString('en-US')} addresses: too many for one scan (limit 65,536). Check its prefix.`
            : r.tooLarge
              ? `Too many addresses for one scan: ${r.count.toLocaleString('en-US')} (limit 65,536).`
              : r.errors[0],
        }),
      );
  }, [settings.targets]);

  const tokens = splitTokens(settings.targets);
  const suggestions = local.filter((l) => !tokens.includes(l.cidr));
  const p = scan.progress;
  const phaseIndex = p ? PHASES.findIndex((x) => x.id === p.phase) : -1;
  const pct =
    p?.phase === 'done' ? 100 : p && phaseIndex >= 0 ? Math.round(((phaseIndex + (p.total ? p.done / p.total : 0)) / PHASES.length) * 100) : 0;
  const canStart = !scan.running && count.n > 0 && !count.error;

  return (
    <div className="panel">
      <div className="target">
        <TargetEditor disabled={scan.running} />
        <select
          className="select"
          value={settings.portProfile}
          disabled={scan.running}
          onChange={(e) => setSettings({ portProfile: e.target.value as PortProfile })}
          aria-label="Ports to scan"
        >
          {PROFILES.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
        {scan.running ? (
          <button className="btn danger" onClick={() => void cancel()}>
            <Square className="icon" /> Stop scan
          </button>
        ) : (
          <button className="btn primary" disabled={!canStart} onClick={() => void start()}>
            <Play className="icon" /> Start scan
          </button>
        )}
      </div>
      <AuthorisedDialog
        open={askAuthorised}
        onOpenChange={setAskAuthorised}
        onConfirm={() => {
          localStorage.setItem(AUTHORISED_KEY, '1');
          setAskAuthorised(false);
          void startScan();
        }}
      />

      {settings.portProfile === 'custom' && (
        <div className="suggest">
          <span className="muted">Ports</span>
          <div className="input" style={{ width: 320 }}>
            <input
              className="mono"
              value={settings.customPorts}
              disabled={scan.running}
              onChange={(e) => setSettings({ customPorts: e.target.value })}
              placeholder="22, 80, 443, 8000-8100"
              aria-label="Custom ports"
            />
          </div>
        </div>
      )}

      {!scan.running && (
        <div className="suggest">
          {count.error ? (
            <span style={{ color: 'var(--danger-text)' }}>{count.error}</span>
          ) : (
            <span className="muted">{count.n.toLocaleString()} addresses</span>
          )}
          <span className="profile-hint">
            <CircleHelp className="icon" />
            {PROFILE_HINT[settings.portProfile]}
          </span>
          {suggestions.map((l) => (
            <button key={l.iface + l.cidr} className="chip" onClick={() => setSettings({ targets: [...tokens, l.cidr].join('; ') })}>
              <Plus className="icon" /> {l.cidr} <span className="muted">{l.iface} · this computer</span>
            </button>
          ))}
        </div>
      )}

      {(scan.running || p) && (
        <div style={{ padding: '4px 14px 14px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 7 }}>
            <span>
              <b>{scan.running ? 'Scanning' : scan.summary?.status === 'cancelled' ? 'Stopped' : 'Finished'}</b>
              {scan.running && p && phaseIndex >= 0 && (
                <span className="muted">
                  {' '}
                  · {PHASES[phaseIndex]?.label.toLowerCase()} {p.done.toLocaleString()} of {p.total.toLocaleString()}
                  {p.phase === 'ports' ? ' checks' : ''}
                </span>
              )}
            </span>
            <span className="muted">{pct}%</span>
          </div>
          <div className={`progress ${scan.running ? 'running' : ''}`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <i style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
          <div className="phases">
            {PHASES.map((ph, i) => {
              const state = !p ? 'pending' : p.phase === 'done' || i < phaseIndex ? 'done' : i === phaseIndex && scan.running ? 'run' : 'pending';
              const Icon = state === 'done' ? CircleCheck : state === 'run' ? Loader : CircleDashed;
              return (
                <span key={ph.id} className={`phase ${state}`}>
                  <Icon className="icon" />
                  {ph.label}
                </span>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** What each scan speed trades off, shown when pointing at it. */
const SPEED_HINT: Record<Timing, string> = {
  cautious: 'Slowest and gentlest. Waits longest for each device: best over VPN or slow links, with strict firewalls, or on industrial and medical networks.',
  balanced: 'Recommended for most networks. A middle ground between speed and finding slow devices.',
  aggressive: 'Fastest. Waits less for each device: slow devices, weak WiFi or VPN links may be missed, and strict firewalls may block the scan.',
};

export function Discover() {
  const timing = useStore((s) => s.settings.timing);
  const setSettings = useStore((s) => s.setSettings);
  const scan = useStore((s) => s.scan);
  const assets = useStore((s) => s.assets);
  const runs = useStore((s) => s.runs);
  const removeRun = useStore((s) => s.removeRun);
  const openNetwork = useStore((s) => s.openNetwork);
  const networks = useStore((s) => s.networks);
  const networkName = (id?: string) => networks.find((n) => n.id === id)?.name;
  const scanNetwork = networkName(scan.networkId);
  const [openId, setOpenId] = useState<string>();
  const opened = openId ? assets[openId] : undefined;

  // Escape closes the device drawer.
  useEffect(() => {
    if (!openId) return;
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && setOpenId(undefined);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openId]);

  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'ip', dir: 1 });
  const seen = scan.seen.map((id) => assets[id]).filter((a) => a !== undefined);
  const rows = [...seen].sort((a, b) => compareAssets(a, b, sort.key) * sort.dir);
  const header = (key: SortKey, label: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'risk' ? -1 : 1 }))}>
        {label}
        {sort.key === key &&
          (sort.dir === 1 ? <ArrowUp className="icon" style={{ width: 12, height: 12 }} /> : <ArrowDown className="icon" style={{ width: 12, height: 12 }} />)}
      </button>
    </th>
  );
  const openPorts = seen.reduce((n, a) => n + a.ports.length, 0);
  const risks = seen.reduce((n, a) => n + a.risks.length, 0);
  const high = seen.reduce((n, a) => n + a.risks.filter((r) => r.severity === 'high').length, 0);
  const fresh = seen.filter((a) => a.isNew).length;
  const unknown = seen.filter((a) => a.type === 'unknown').length;
  const started = scan.running || !!scan.progress;
  const analysing = scan.running && scan.progress?.phase !== 'analysis';

  return (
    <>
    <div className="page fit">
      <div className="page-h">
        <div>
          <h1>Discover</h1>
          <p>Scan networks you are authorised to scan. Every device found is saved to Inventory.</p>
        </div>
        <div className="right">
          <span className="muted" style={{ fontSize: 12 }}>
            Speed
          </span>
          <span className="seg" role="group" aria-label="Scan speed">
            {(['cautious', 'balanced', 'aggressive'] as Timing[]).map((t) => (
              <button key={t} aria-pressed={timing === t} disabled={scan.running} title={SPEED_HINT[t]} onClick={() => setSettings({ timing: t })}>
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </span>
        </div>
      </div>

      <ScanControls />

      {!scan.running && scan.summary?.lanBlocked && (
        <div className="panel" role="alert" style={{ marginTop: 14, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <ShieldAlert className="icon" style={{ color: 'var(--danger-text)' }} />
          <div style={{ flex: 1, lineHeight: 1.45 }}>
            <b>macOS is blocking this app from your local network.</b>{' '}
            <span className="t2">
              Only this computer could be reached. Turn on this app in System Settings → Privacy &amp; Security → Local Network,
              then scan again.
            </span>
          </div>
          <button className="btn sm" onClick={() => void window.api.app.openLocalNetworkSettings()}>
            Open Local Network settings
          </button>
        </div>
      )}

      {!scan.running && scan.summary?.macHidden && (
        <div className="panel" role="alert" style={{ marginTop: 14, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <TriangleAlert className="icon" style={{ color: 'var(--warning-text)' }} />
          <div style={{ flex: 1, lineHeight: 1.45 }}>
            <b>Some MAC addresses and vendors are unavailable.</b>{' '}
            <span className="t2">
              This version of macOS does not share the network&apos;s MAC address table with this app. Addresses shown were
              reported by the devices themselves.
            </span>
          </div>
        </div>
      )}

      <div className="stats">
        <div className="panel stat">
          <div className="lab">
            <MonitorCheck className="icon" /> Devices found
          </div>
          <div className="val">{seen.length}</div>
          <div className="delta">
            {fresh ? <span style={{ color: 'var(--success-text)', fontWeight: 600 }}>+{fresh} new</span> : started ? 'none new yet' : 'start a scan'}
          </div>
        </div>
        <div className="panel stat">
          <div className="lab">
            <PlugZap className="icon" /> Open ports
          </div>
          <div className="val">{openPorts}</div>
          <div className="delta">across {seen.filter((a) => a.ports.length).length} devices</div>
        </div>
        <div className="panel stat">
          <div className="lab">
            <ShieldAlert className="icon" /> Risks found
          </div>
          <div className="val">{risks}</div>
          <div className="delta">{high > 0 ? <SeverityBadge severity="high">{high} high</SeverityBadge> : 'no high risks'}</div>
        </div>
        <div className="panel stat">
          <div className="lab">
            <CircleHelp className="icon" /> Unidentified
          </div>
          <div className="val">{unknown}</div>
          <div className="delta">open them to see what was detected</div>
        </div>
      </div>

      <div className="cols fill" style={{ gridTemplateColumns: 'minmax(0, 1fr) 320px' }}>
        <div className="panel results-panel">
          <div className="panel-h">
            Live results{' '}
            <span className="sub">
              {scanNetwork ? (
                <>
                  · {scan.running ? 'saving to' : 'saved to'} <b className="t2">{scanNetwork}</b>
                </>
              ) : (
                '· click a column to sort'
              )}
            </span>
            <div className="right">
              <button className="btn sm" disabled={!seen.length} onClick={() => openNetwork(scan.networkId)}>
                Open in Network Inventory
              </button>
            </div>
          </div>
          {seen.length === 0 ? (
            <EmptyState icon={Radar} title={scan.running ? 'Looking for devices…' : 'No results yet'}>
              {scan.running ? 'Devices appear here as soon as they answer.' : 'Pick a target above, usually your own subnet, and start a scan.'}
            </EmptyState>
          ) : (
            <div className="results-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    {header('name', 'Device')}
                    {header('ip', 'IP address')}
                    {header('vendor', 'MAC · vendor')}
                    <th>Ports</th>
                    {header('risk', 'Risk')}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a) => {
                    const sev = topSeverity(a);
                    return (
                      <tr
                        key={a.id}
                        className={a.isNew ? 'new' : ''}
                        aria-selected={a.id === openId}
                        onClick={() => setOpenId(a.id === openId ? undefined : a.id)}
                      >
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
                        <td className="mono">
                          {a.ip}
                          {a.ipv6?.length ? <V6Pill addresses={a.ipv6.map((x) => x.address)} /> : null}
                        </td>
                        <td className="clip" title={a.vendor}>
                          <div className="mono t2">{a.mac ?? '—'}</div>
                          {a.vendor && <div className="sub-line">{a.vendor}</div>}
                        </td>
                        <td>{analysing && !a.ports.length ? <span className="muted">…</span> : <PortChips ports={a.ports} max={3} />}</td>
                        <td>{sev ? <SeverityBadge severity={sev} /> : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="side-col">
          <div className="panel runs-panel">
            <div className="panel-h">
              Recent scans {runs.length > 0 && <span className="sub">· last {runs.length}</span>}
            </div>
            {runs.length === 0 ? (
              <div className="card-body muted">Your scans will be listed here.</div>
            ) : (
              <div className="runs-scroll">
              {runs.map((r) => (
                <div key={r.runId} className="run-row">
                <button
                  className="run"
                  disabled={!networkName(r.networkId)}
                  title={networkName(r.networkId) ? `Open ${networkName(r.networkId)} in Network Inventory` : undefined}
                  onClick={() => openNetwork(r.networkId)}
                >
                  <History className="icon muted" />
                  <div style={{ minWidth: 0 }}>
                    <div className="run-name">{networkName(r.networkId) ?? r.targets}</div>
                    <div className="meta">
                      {networkName(r.networkId) && networkName(r.networkId) !== r.targets && <span className="mono">{r.targets} · </span>}
                      {relativeTime(r.startedAt)}
                      {r.status === 'cancelled' ? ' · stopped' : ''}
                    </div>
                  </div>
                  <div className="num">
                    {r.live} {r.live === 1 ? 'device' : 'devices'}
                    <div style={{ color: r.newAssets ? 'var(--success-text)' : undefined, whiteSpace: 'nowrap' }}>
                      {r.newAssets ? (
                        <>
                          <Sparkle className="icon" style={{ width: 11, height: 11, verticalAlign: -1 }} /> {r.newAssets} new
                        </>
                      ) : (
                        `${r.risks} ${r.risks === 1 ? 'risk' : 'risks'}`
                      )}
                    </div>
                  </div>
                </button>
                <button
                  className="run-remove"
                  title="Remove from recent scans"
                  aria-label={`Remove the scan of ${networkName(r.networkId) ?? r.targets} from recent scans`}
                  onClick={() => void removeRun(r.runId)}
                >
                  <X className="icon" />
                </button>
                </div>
              ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
    {opened && <Detail asset={opened} className="drawer" onClose={() => setOpenId(undefined)} />}
    </>
  );
}
