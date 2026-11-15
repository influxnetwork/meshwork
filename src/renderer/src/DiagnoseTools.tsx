/**
 * Quick tests in Diagnose: live ping, port test, DNS lookup, path MTU and DHCP servers. The live ping keeps running while
 * another tab or module is shown, and stops when asked or when the app closes.
 */
import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { MapPin, Play, Search, Square } from 'lucide-react';
import { isTraceTarget, pingStats, type DhcpCheckResult, type DhcpOfferResult, type DnsLookup, type DnsRecordType, type MtuResult, type PingSample, type PortCheck } from '@shared/diagnose';
import { cleanError, useStore } from './store';
import { displayName } from './ui';

/** Echoes kept for the chart and statistics: one hour at one per second. */
const MAX_SAMPLES = 3600;
/** Echoes drawn on the chart: the last two minutes. */
const CHART_SAMPLES = 120;

interface LivePingState {
  target: string;
  running: boolean;
  samples: PingSample[];
  error?: string;
  set(patch: Partial<Omit<LivePingState, 'set'>>): void;
}

const useLivePing = create<LivePingState>((set) => ({ target: '', running: false, samples: [], set: (patch) => set(patch) }));
let loop: number | undefined;

/** Sends one echo per second until stopped; a slow reply delays the next one instead of overlapping it. */
function startPing(target: string) {
  stopPing();
  const t = target.trim();
  useLivePing.getState().set({ target: t, running: true, samples: [], error: undefined });
  const token = Date.now();
  loop = token;
  const tick = async () => {
    if (loop !== token) return;
    const at = Date.now();
    try {
      const r = await window.api.diagnose.pingOnce(t);
      if (loop !== token) return;
      const samples = [...useLivePing.getState().samples, { at, rttMs: r.alive ? Math.round((r.rttMs ?? 0.5) * 10) / 10 : undefined }].slice(-MAX_SAMPLES);
      useLivePing.getState().set({ samples });
    } catch (err) {
      useLivePing.getState().set({ running: false, error: cleanError(err) });
      loop = undefined;
      return;
    }
    setTimeout(() => void tick(), Math.max(0, 1000 - (Date.now() - at)));
  };
  void tick();
}

function stopPing() {
  loop = undefined;
  useLivePing.getState().set({ running: false });
}

const fmtMs = (v?: number) => (v === undefined ? '—' : `${v} ms`);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Latency line for the last two minutes, with a red bar for every lost echo. Hovering shows each echo's time and value. */
function PingChart({ samples }: { samples: PingSample[] }) {
  const W = 720;
  const H = 150;
  const [hover, setHover] = useState<number | undefined>();
  const shown = samples.slice(-CHART_SAMPLES);
  const top = Math.max(10, ...shown.map((s) => s.rttMs ?? 0)) * 1.15;
  const x = (i: number) => (i / (CHART_SAMPLES - 1)) * W;
  const y = (v: number) => H - (v / top) * H;
  const offset = CHART_SAMPLES - shown.length;
  const segments: string[] = [];
  let d = '';
  shown.forEach((s, i) => {
    // A lost echo has no time to draw: the line breaks there and a red bar marks it.
    if (s.rttMs === undefined) {
      if (d) segments.push(d);
      d = '';
      return;
    }
    d += `${d ? 'L' : 'M'}${x(i + offset).toFixed(1)},${y(s.rttMs).toFixed(1)} `;
  });
  if (d) segments.push(d);

  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const slot = Math.round(((e.clientX - r.left) / r.width) * (CHART_SAMPLES - 1));
    const i = slot - offset;
    setHover(i >= 0 && i < shown.length ? i : undefined);
  };
  const h = hover !== undefined ? shown[hover] : undefined;
  const hx = hover !== undefined ? (x(hover + offset) / W) * 100 : 0;
  const n = samples.length - shown.length + (hover ?? 0) + 1;

  return (
    <div className="lp-chart-wrap" onMouseMove={onMove} onMouseLeave={() => setHover(undefined)}>
      <svg className="lp-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Round-trip time over the last two minutes">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} className="lp-grid" />
        ))}
        {shown.map((s, i) => (s.rttMs === undefined ? <rect key={i} x={x(i + offset) - 2} y="0" width="4" height={H} className="lp-loss" /> : null))}
        {segments.map((p, i) => (
          <path key={i} d={p} className="lp-line" />
        ))}
        {h && <line x1={x(hover! + offset)} x2={x(hover! + offset)} y1="0" y2={H} className="lp-cursor" />}
      </svg>
      {/* Axis labels and the hover point sit outside the stretched SVG so text and dots keep their shape. */}
      {[0, 0.25, 0.5, 0.75].map((f) => (
        <span key={f} className="lp-axis" style={{ top: `${f * 100}%` }}>
          {Math.round(top * (1 - f))} ms
        </span>
      ))}
      {h && h.rttMs !== undefined && <i className="lp-dot" style={{ left: `${hx}%`, top: `${(y(h.rttMs) / H) * 100}%` }} />}
      {h && (
        <div className={`lp-tip${hx > 70 ? ' left' : ''}`} style={{ left: `${hx}%` }}>
          <b className={h.rttMs === undefined ? 'lost' : ''}>{h.rttMs === undefined ? 'Lost' : `${h.rttMs} ms`}</b>
          <span>
            Echo {n} · {clock(h.at)}
          </span>
        </div>
      )}
    </div>
  );
}

export function LivePing({ suggestions }: { suggestions: { label: string; value: string }[] }) {
  const { target, running, samples, error } = useLivePing();
  const [draft, setDraft] = useState(target || suggestions[0]?.value || '');
  const valid = isTraceTarget(draft.trim());
  const stats = useMemo(() => pingStats(samples), [samples]);
  const last = samples.at(-1);

  return (
    <section className="panel dg-panel">
      <div className="panel-h">
        Live ping
        <span className="sub">One echo per second while you work: swap a cable, restart a switch or walk the building.</span>
      </div>
      <div className="dg-trace-bar">
        <form
          className="dg-trace-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!running && valid) startPing(draft);
          }}
        >
          <label className="input" style={{ width: 300 }}>
            <Search className="icon" />
            <input aria-label="Host or IP address to ping" placeholder="Host name or IP address" value={draft} spellCheck={false} disabled={running} onChange={(e) => setDraft(e.target.value)} />
          </label>
          {/* Keys keep Stop and Start as separate elements: reusing one would turn Stop into a submit button mid-click and restart the run. */}
          {running ? (
            <button
              key="stop"
              type="button"
              className="btn"
              onClick={(e) => {
                e.preventDefault();
                stopPing();
              }}
            >
              <Square className="icon" /> Stop
            </button>
          ) : (
            <button key="start" type="submit" className="btn primary" disabled={!valid}>
              <Play className="icon" /> Start
            </button>
          )}
        </form>
        <div className="dg-suggest">
          {suggestions.map((s) => (
            <button key={s.value} className="chip" disabled={running} onClick={() => setDraft(s.value)} title={s.value}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="dg-error">{error}</p>}
      {samples.length > 0 ? (
        <div className="lp-body">
          <div className="lp-stats">
            <div className={`lp-now ${last?.rttMs === undefined ? 'lost' : ''}`}>
              <b>{last?.rttMs === undefined ? 'Lost' : `${last.rttMs} ms`}</b>
              <span>{running ? `Pinging ${target}` : `Stopped · ${target}`}</span>
            </div>
            <div><b>{stats.sent}</b><span>sent</span></div>
            <div className={stats.lossPct > 0 ? 'warn' : ''}><b>{stats.lossPct}%</b><span>loss</span></div>
            <div><b>{fmtMs(stats.minMs)}</b><span>min</span></div>
            <div><b>{fmtMs(stats.avgMs)}</b><span>average</span></div>
            <div><b>{fmtMs(stats.maxMs)}</b><span>max</span></div>
            <div><b>{fmtMs(stats.jitterMs)}</b><span>jitter</span></div>
          </div>
          <PingChart samples={samples} />
          <div className="lp-outages">
            {stats.outages.length === 0 ? (
              <span className="muted">No echoes lost{samples.length > 1 ? ` since ${clock(samples[0]!.at)}` : ''}.</span>
            ) : (
              <>
                <b>{stats.outages.length === 1 ? '1 drop' : `${stats.outages.length} drops`}</b>
                {stats.outages
                  .slice(-6)
                  .reverse()
                  .map((o) => (
                    <span key={o.at} className="lp-drop">
                      {clock(o.at)} · {o.lost === 1 ? '1 echo' : `${o.lost} echoes`} lost
                    </span>
                  ))}
              </>
            )}
          </div>
        </div>
      ) : (
        !error && <p className="dg-hint muted">Pick the gateway, a switch or the device that drops. The chart keeps the last two minutes; statistics cover the whole run, up to an hour.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- port test

/** Common port sets offered as shortcuts. */
const PORT_SETS = [
  { label: 'Web', ports: '80, 443, 8080, 8443' },
  { label: 'Remote access', ports: '22, 23, 3389, 5900' },
  { label: 'Files & printing', ports: '21, 139, 445, 515, 631, 9100' },
  { label: 'Cameras & voice', ports: '554, 8000, 5060, 5061' },
];

const STATE_TEXT = { open: 'Open', closed: 'Closed', silent: 'Filtered', unreachable: 'Unreachable' } as const;

export function PortTest({ suggestions }: { suggestions: { label: string; value: string }[] }) {
  const assets = useStore((s) => s.assets);
  const [host, setHost] = useState(suggestions[0]?.value ?? '');
  const [ports, setPorts] = useState('22, 80, 443, 3389');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PortCheck>();
  const [error, setError] = useState<string>();
  const known = useMemo(() => (result ? Object.values(assets).find((a) => a.ip === result.ip) : undefined), [assets, result]);
  const valid = isTraceTarget(host.trim()) && /^[\d,\s-]+$/.test(ports.trim()) && /\d/.test(ports);

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await window.api.diagnose.ports(host.trim(), ports));
    } catch (err) {
      setResult(undefined);
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };
  const open = result?.results.filter((r) => r.state === 'open') ?? [];
  const rows = result ? (result.results.length <= 40 ? result.results : open) : [];

  return (
    <section className="panel dg-panel">
      <div className="panel-h">
        Port test
        <span className="sub">Which services a device accepts connections on.</span>
      </div>
      <form
        className="dg-trace-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void run();
        }}
      >
        <label className="input" style={{ width: 240 }}>
          <Search className="icon" />
          <input aria-label="Host or IP address" placeholder="Host name or IP address" value={host} spellCheck={false} onChange={(e) => setHost(e.target.value)} />
        </label>
        <label className="input" style={{ width: 260 }}>
          <input aria-label="Ports" placeholder="22, 80, 443 or 5060-5070" value={ports} spellCheck={false} onChange={(e) => setPorts(e.target.value)} />
        </label>
        <button type="submit" className="btn primary" disabled={!valid || busy}>
          <Play className="icon" /> {busy ? 'Testing…' : 'Test'}
        </button>
        <div className="dg-suggest">
          {suggestions.map((s) => (
            <button type="button" key={s.value} className="chip" onClick={() => setHost(s.value)} title={s.value}>
              {s.label}
            </button>
          ))}
          <span className="dg-sep" aria-hidden />
          {PORT_SETS.map((s) => (
            <button type="button" key={s.label} className="chip" onClick={() => setPorts(s.ports)} title={s.ports}>
              {s.label}
            </button>
          ))}
        </div>
      </form>
      {error && <p className="dg-error">{error}</p>}
      {result ? (
        <>
          <p className="pt-summary">
            <b>{known ? displayName(known) : result.host}</b>
            {result.ip !== result.host && <span className="mono muted"> {result.ip}</span>} · {open.length} of {result.results.length} ports open
            <span className="muted"> · {(result.ms / 1000).toFixed(1)} s</span>
          </p>
          {rows.length > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th className="num">Port</th>
                  <th>Service</th>
                  <th>State</th>
                  <th className="num">Connect time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.port}>
                    <td className="num mono">{r.port}</td>
                    <td>{r.service || <span className="muted">—</span>}</td>
                    <td>
                      <span className={`pt-state ${r.state}`}>{STATE_TEXT[r.state]}</span>
                    </td>
                    <td className="num mono">{r.ms !== undefined ? `${r.ms} ms` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="dg-hint muted">
            Open: a service accepted the connection. Closed: the device answered that nothing listens there. Filtered: no answer, usually a firewall.
          </p>
        </>
      ) : (
        !error && <p className="dg-hint muted">Up to 1,024 ports per test. Use the shortcuts for common sets, or type a list and ranges.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- DNS lookup

const DNS_VERDICT: Record<DnsLookup['agreement'], { status: 'ok' | 'warn' | 'fail'; title: string; text: string }> = {
  same: { status: 'ok', title: 'Consistent.', text: 'Every server that answered returned the same records.' },
  varies: {
    status: 'ok',
    title: 'Consistent.',
    text: 'The servers return different public addresses for this name, which is normal for large sites that spread their traffic.',
  },
  internal: {
    status: 'warn',
    title: 'Resolves differently inside the network.',
    text: "The network's DNS returns private addresses the public server does not. Expected for an internal system; otherwise an old internal entry is sending devices to the wrong place.",
  },
  missing: {
    status: 'warn',
    title: 'Some servers do not know this name.',
    text: 'One server finds the name and another reports it does not exist: a record only on one side, or a change that has not reached every server yet.',
  },
  none: { status: 'fail', title: 'No server returned a record.', text: 'Check the spelling, or whether this record type exists for the name.' },
};

function DnsVerdict({ agreement }: { agreement: DnsLookup['agreement'] }) {
  const v = DNS_VERDICT[agreement];
  return (
    <div className={`dg-verdict ${v.status}`} role="status">
      <span className={`dg-dot ${v.status}`} />
      <span>
        <b>{v.title}</b> {v.text}
      </span>
    </div>
  );
}

const RECORD_TYPES: DnsRecordType[] = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];

export function DnsTool() {
  const [name, setName] = useState('');
  const [type, setType] = useState<DnsRecordType>('A');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DnsLookup>();
  const [error, setError] = useState<string>();
  const valid = isTraceTarget(name.trim().replace(/\.$/, ''));
  const reverse = /^\d+\.\d+\.\d+\.\d+$/.test(name.trim());

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await window.api.diagnose.dnsLookup(name.trim(), type));
    } catch (err) {
      setResult(undefined);
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel dg-panel">
      <div className="panel-h">
        DNS lookup
        <span className="sub">Asks the network&apos;s DNS servers and a public one, side by side.</span>
      </div>
      <form
        className="dg-trace-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void run();
        }}
      >
        <label className="input" style={{ width: 300 }}>
          <Search className="icon" />
          <input aria-label="Name or IP address to look up" placeholder="erp.example.com, or an IP for its name" value={name} spellCheck={false} onChange={(e) => setName(e.target.value)} />
        </label>
        <span className="seg" role="group" aria-label="Record type">
          {RECORD_TYPES.map((t) => (
            <button type="button" key={t} aria-pressed={!reverse && type === t} disabled={reverse} onClick={() => setType(t)}>
              {t}
            </button>
          ))}
        </span>
        <button type="submit" className="btn primary" disabled={!valid || busy}>
          <Play className="icon" /> {busy ? 'Looking up…' : 'Look up'}
        </button>
      </form>
      {error && <p className="dg-error">{error}</p>}
      {result ? (
        <>
          <table className="data-table">
            <thead>
              <tr>
                <th>Server</th>
                <th>Records ({result.type})</th>
                <th className="num">Time</th>
              </tr>
            </thead>
            <tbody>
              {result.answers.map((a) => (
                <tr key={a.server}>
                  <td>
                    <span className="mono">{a.server}</span>
                    <span className="muted"> · {a.source === 'Network' ? 'this network' : 'public'}</span>
                  </td>
                  <td className="mono dns-records">{a.error ? <span className="muted">{a.error}</span> : a.records.map((r) => <div key={r}>{r}</div>)}</td>
                  <td className="num mono">{a.ms !== undefined ? `${a.ms} ms` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <DnsVerdict agreement={result.agreement} />
        </>
      ) : (
        !error && <p className="dg-hint muted">Type an IP address to find its name instead. A name that resolves differently inside the network than outside is the usual cause of &quot;works here, not there&quot;.</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- path MTU

export function MtuTool({ suggestions }: { suggestions: { label: string; value: string }[] }) {
  const [target, setTarget] = useState('1.1.1.1');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<MtuResult>();
  const [error, setError] = useState<string>();
  const valid = isTraceTarget(target.trim());

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await window.api.diagnose.mtu(target.trim()));
    } catch (err) {
      setResult(undefined);
      setError(cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel dg-panel">
      <div className="panel-h">
        Path MTU
        <span className="sub">The largest packet that reaches a destination without being split.</span>
      </div>
      <form
        className="dg-trace-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !busy) void run();
        }}
      >
        <label className="input" style={{ width: 300 }}>
          <Search className="icon" />
          <input aria-label="Host or IP address" placeholder="Host name or IP address" value={target} spellCheck={false} onChange={(e) => setTarget(e.target.value)} />
        </label>
        <button type="submit" className="btn primary" disabled={!valid || busy}>
          <Play className="icon" /> {busy ? 'Measuring…' : 'Measure'}
        </button>
        <div className="dg-suggest">
          {suggestions.map((s) => (
            <button type="button" key={s.value} className="chip" onClick={() => setTarget(s.value)} title={s.value}>
              {s.label}
            </button>
          ))}
        </div>
      </form>
      {error && <p className="dg-error">{error}</p>}
      {result ? (
        <div className="mtu-result">
          <div className={`mtu-value ${result.status}`}>
            <b>{result.mtu ? `${result.mtu} bytes` : '—'}</b>
            <span>
              to {result.target} · {result.probes} probes
            </span>
          </div>
          <div className={`dg-verdict ${result.status}`} role="status">
            <span className={`dg-dot ${result.status}`} />
            <span>{result.explanation}</span>
          </div>
        </div>
      ) : (
        !error && (
          <p className="dg-hint muted">
            Normal is 1500 bytes. A smaller value explains pages or transfers that hang, or a VPN that connects but freezes. Takes a few seconds.
          </p>
        )
      )}
    </section>
  );
}

// ---------------------------------------------------------------- DHCP servers

type DhcpResult = DhcpCheckResult;

const lease = (s?: number) => (s === undefined ? '—' : s >= 86400 ? `${Math.round(s / 86400)} d` : s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);

export function DhcpTool() {
  const assets = useStore((s) => s.assets);
  const platform = useStore((s) => s.info?.platform);
  const showOnMap = useStore((s) => s.showOnMap);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DhcpResult>();
  const byIp = useMemo(() => new Map(Object.values(assets).map((a) => [a.ip, a])), [assets]);

  const run = async () => {
    setBusy(true);
    try {
      const r = await window.api.diagnose.dhcp();
      setResult(r);
      // The switch reading filled MAC addresses into the inventory: reload it so "Show on map" finds the device.
      if (r.locate?.macsFilled) await useStore.getState().load();
    } catch (err) {
      setResult({ offers: [], listenedMs: 0, mode: 'direct', error: cleanError(err) });
    } finally {
      setBusy(false);
    }
  };
  const n = result?.offers.length ?? 0;
  const located = result?.offers.some((o) => o.location);

  /** Map node of a located server: its inventory entry, or the address the switches learned. */
  const mapNode = (o: DhcpOfferResult): { networkId: string; id: string } | undefined => {
    const loc = o.location;
    if (!loc?.where) return undefined;
    const mac = loc.mac?.toLowerCase();
    const mine = Object.values(assets).filter((a) => a.networkId === loc.networkId);
    const asset = (mac ? mine.find((a) => a.mac?.toLowerCase() === mac) : undefined) ?? (loc.nodeId ? mine.find((a) => a.ip === o.server) : undefined);
    const id = asset?.id ?? loc.nodeId ?? (mac ? `mac:${mac}` : undefined);
    return id ? { networkId: loc.networkId, id } : undefined;
  };

  return (
    <section className="panel dg-panel">
      <div className="panel-h">
        DHCP servers <span className="beta-tag" title="Beta: results may change between versions.">Beta</span>
        <span className="sub">Rogue DHCP detection: sends a DHCP Discover on this VLAN, lists every server that answers with an offer, and never takes a lease.</span>
        <div className="right">
          <button className="btn primary" disabled={busy} onClick={() => void run()}>
            <Play className="icon" /> {busy ? 'Listening…' : result ? 'Run again' : 'Find servers'}
          </button>
        </div>
      </div>
      {result?.error && <p className="dg-error" style={{ marginTop: 12 }}>{result.error}</p>}
      {result && !result.error ? (
        <>
          {n > 0 && (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Server</th>
                  <th>Device</th>
                  <th>Offers</th>
                  <th>Gateway</th>
                  <th>DNS</th>
                  <th className="num">Lease</th>
                  {located && <th>Switch port</th>}
                </tr>
              </thead>
              <tbody>
                {result.offers.map((o) => {
                  const known = byIp.get(o.server) ?? byIp.get(o.from);
                  const node = mapNode(o);
                  return (
                    <tr key={o.server}>
                      <td className="mono">
                        {o.server}
                        {o.from !== o.server && <div className="muted">via relay {o.from}</div>}
                      </td>
                      <td>
                        {known ? (
                          displayName(known)
                        ) : o.vendor ? (
                          o.vendor
                        ) : o.otherSubnet ? (
                          <span className="muted" title="Its address is outside this computer's subnet, so its MAC address cannot be read from here.">
                            Different subnet
                          </span>
                        ) : (
                          <span className="muted">Unknown</span>
                        )}
                        {(o.mac ?? o.location?.mac) && <div className="mono muted">{o.mac ?? o.location?.mac}</div>}
                      </td>
                      <td className="mono">{o.offered}</td>
                      <td className="mono">{o.router ?? '—'}</td>
                      <td className="mono">{o.dns.length ? o.dns.join(', ') : '—'}</td>
                      <td className="num">{lease(o.leaseSeconds)}</td>
                      {located && (
                        <td>
                          <ServerPort offer={o} />
                          {node && (
                            <button className="btn sm dg-map-btn" onClick={() => showOnMap(node.networkId, node.id)}>
                              <MapPin className="icon" /> Show on map
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {result.mode === 'relay' && (
            <p className="dg-hint muted">
              Found in relay mode, because this computer&apos;s DHCP client holds the usual port. Home routers that ignore relayed requests may not appear.
            </p>
          )}
          <div className={`dg-verdict ${n === 1 ? 'ok' : n === 0 ? 'fail' : 'warn'}`} role="status">
            <span className={`dg-dot ${n === 1 ? 'ok' : n === 0 ? 'fail' : 'warn'}`} />
            <span>
              {n === 1 ? (
                <>
                  <b>One DHCP server.</b> No rogue DHCP answered on this VLAN.
                </>
              ) : n === 0 ? (
                <>
                  <b>No DHCP server answered</b> in {result.listenedMs / 1000} seconds. Devices that join this network will not get an address unless they are set by hand.
                </>
              ) : (
                <>
                  <b>{n} DHCP servers answered: possible rogue DHCP.</b> Only one should answer. Compare the gateway and DNS each one offers to tell which is unauthorized; it is often a home router or a device plugged in by mistake. Unplug it or turn its DHCP off.
                </>
              )}
            </span>
          </div>
          {n === 0 && platform === 'win32' && (
            <p className="dg-hint muted">
              If Windows asked whether Meshwork may use networks and the answer was Cancel, the replies are blocked. Allow Meshwork in Windows Security → Firewall &amp; network protection → Allow an app through firewall, then run the test again.
            </p>
          )}
          {n > 1 && <LocateNote locate={result.locate} />}
        </>
      ) : (
        !result && (
          <p className="dg-hint muted">
            Explains devices that get an odd address or lose internet at random. Run it on the network being diagnosed; it listens for five seconds. When the network has been scanned and its managed switches are set up with SNMP in Map, it also shows which switch port an extra server is plugged into.
          </p>
        )
      )}
    </section>
  );
}

/** Where a server was found on the managed switches. */
function ServerPort({ offer }: { offer: DhcpOfferResult }) {
  const loc = offer.location;
  if (!loc) return <span className="muted">—</span>;
  if (!loc.mac && !loc.where) {
    return loc.unknownCount ? (
      <span className="muted" title="Its MAC address could not be read, and several unknown devices are on the switches, so Meshwork does not guess which one it is.">
        Not pinned down: {loc.unknownCount} unknown devices
      </span>
    ) : (
      <span className="muted" title="Its MAC address could not be read, and no unknown device was seen on the switches.">
        Not seen on the switches
      </span>
    );
  }
  const w = loc.where;
  if (!w) return <span className="muted">Not seen on the managed switches</span>;
  return (
    <div>
      <b>{w.switchName ?? w.switchIp}</b> · <span className="mono">{w.port}</span>
      {w.portAlias && <span className="muted"> ({w.portAlias})</span>}
      {w.gatewayPort && <div className="muted">This port leads to the gateway: the server is plugged into the gateway itself or a switch next to it</div>}
      {w.unmanaged && <div className="muted">Behind an unmanaged switch on this port</div>}
      {w.beyond && <div className="muted">Past this port, behind a switch without SNMP</div>}
      {loc.confidence === 'announced' && <div className="muted">It announced itself on this port (LLDP or CDP)</div>}
      {loc.confidence === 'likely' && <div className="muted">Most likely: the only new device on the switches</div>}
      {loc.confidence === 'recorded' && <div className="muted">Identified by the MAC address an earlier scan found at its address</div>}
    </div>
  );
}

/**
 * What the technician can do to learn where each server is plugged in: scan the network, then let
 * Meshwork read the switches over SNMP. Shown when more than one server answered.
 */
function LocateNote({ locate }: { locate: DhcpCheckResult['locate'] }) {
  const setView = useStore((s) => s.setView);
  if (!locate || locate.status === 'done') return null;
  const steps =
    locate.status === 'no-scan' ? (
      <>
        <li>
          Scan this network in <b>Discover</b>, so Meshwork knows its devices.
        </li>
        <li>
          In <b>Map</b>, choose <b>Set up SNMP community…</b> and enter the read-only community configured on the switches.
        </li>
        <li>Run this test again.</li>
      </>
    ) : locate.status === 'no-snmp' ? (
      <>
        <li>
          In <b>Map</b>, choose <b>Set up SNMP community…</b> and enter the read-only community configured on the switches.
        </li>
        <li>Run this test again.</li>
      </>
    ) : null;
  return (
    <div className="dg-locate">
      {steps ? (
        <>
          <p>
            <b>Find which switch port each server is plugged into.</b> Meshwork can ask the network&apos;s managed switches where each server is connected. To do that:
          </p>
          <ol>{steps}</ol>
          <p className="muted">Without managed switches, the list above still shows every server; you will need to trace its cable by hand.</p>
          <button className="btn sm" onClick={() => setView(locate.status === 'no-scan' ? 'discover' : 'map')}>
            {locate.status === 'no-scan' ? 'Open Discover' : 'Open Map'}
          </button>
        </>
      ) : locate.status === 'no-table' ? (
        <>
          <p>
            <b>The servers could not be placed on a port.</b> {locate.gear?.join(', ') || 'The network gear'} answered over SNMP, but does not share which device is
            plugged into which port (its MAC address table).
          </p>
          <p className="muted">
            Port location needs a managed switch that shares that table over SNMP; most managed switches do. Routers and firewalls with built-in ports often do not.
            Until then, trace each server&apos;s cable by hand.
          </p>
        </>
      ) : (
        <p className="muted">
          {locate.status === 'no-answer'
            ? 'No switch answered with the SNMP community saved for this network, so the servers could not be placed on a port. Check the community in Map, and that SNMP is turned on in the switches.'
            : `The switches could not be read, so the servers could not be placed on a port: ${locate.error ?? 'unknown error'}`}
        </p>
      )}
    </div>
  );
}
