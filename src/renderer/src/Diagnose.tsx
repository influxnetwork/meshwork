/**
 * Diagnose: answers "is it the network or the provider?" by testing each link from this computer
 * to the internet, and traces the route to any host hop by hop. Results stay while the app is open
 * and are not saved.
 */
import { useEffect, useMemo, useState } from 'react';
import { create } from 'zustand';
import { AppWindow, Globe, Laptop, Play, Plus, RotateCw, Router, Search, Square } from 'lucide-react';
import { hopStats, isTraceTarget, parseServiceTarget, verdict, type CheckStatus, type CheckStep, type CheckStepId, type LocalLink, type PublicAddress, type TraceEvent, type TraceHop } from '@shared/diagnose';
import { cleanError, useStore } from './store';
import { Copyable, displayName } from './ui';
import { DhcpTool, DnsTool, LivePing, MtuTool, PortTest } from './DiagnoseTools';
import type { ReportCheck } from '@shared/report';

const STEPS: { id: CheckStepId; name: string; icon: typeof Globe }[] = [
  { id: 'local', name: 'This computer', icon: Laptop },
  { id: 'gateway', name: 'Gateway', icon: Router },
  { id: 'dns', name: 'DNS', icon: Search },
  { id: 'internet', name: 'Internet', icon: Globe },
  { id: 'service', name: 'Service', icon: AppWindow },
];

/** localStorage key for the service the technician asked to check, kept between runs. */
const SERVICE_KEY = 'diagnose-service';

type StepState = CheckStep | { id: CheckStepId; status: 'running' | 'idle' };

interface TraceState {
  id?: string;
  target: string;
  running: boolean;
  hops: TraceHop[];
  destination?: string;
  done?: { reached: boolean; stoppedEarly?: boolean };
  error?: string;
}

interface DiagnoseState {
  steps: Record<CheckStepId, StepState>;
  link?: LocalLink;
  /** Host, host:port or web address checked after the internet step; empty for none. */
  service: string;
  checking: boolean;
  checkedAt?: number;
  /** Public addresses of the last check: undefined before they answer, null without an answer. */
  publicAddress?: PublicAddress | null;
  trace: TraceState;
  setStep(step: StepState): void;
  set(patch: Partial<Omit<DiagnoseState, 'set' | 'setStep'>>): void;
  setTrace(patch: Partial<TraceState>): void;
}

const idle = (id: CheckStepId): StepState => ({ id, status: 'idle' });

/** Kept outside the component so results survive switching to another module and back. */
const useDiagnose = create<DiagnoseState>((set) => ({
  steps: { local: idle('local'), gateway: idle('gateway'), dns: idle('dns'), internet: idle('internet'), service: idle('service') },
  service: localStorage.getItem(SERVICE_KEY) ?? '',
  checking: false,
  trace: { target: '1.1.1.1', running: false, hops: [] },
  setStep: (step) => set((s) => ({ steps: { ...s.steps, [step.id]: step } })),
  set: (patch) => set(patch),
  setTrace: (patch) => set((s) => ({ trace: { ...s.trace, ...patch } })),
}));

/**
 * The last connectivity check, for the site-visit report: its finished steps and the address this
 * computer had. Undefined when no check ran in this session.
 */
export function connectivityForReport(): { checks: ReportCheck[]; checkedAt?: string; address?: string; publicAddress?: PublicAddress } | undefined {
  const d = useDiagnose.getState();
  if (!d.checkedAt || d.checking) return undefined;
  const checks = STEPS.map((s) => d.steps[s.id])
    .filter((st): st is CheckStep => st.status !== 'idle' && st.status !== 'running')
    .map((st) => ({ name: STEPS.find((s) => s.id === st.id)?.name ?? st.id, status: st.status, summary: st.summary, target: st.target }));
  return checks.length ? { checks, checkedAt: new Date(d.checkedAt).toISOString(), address: d.link?.address, publicAddress: d.publicAddress ?? undefined } : undefined;
}

const skipped = (id: CheckStepId, summary: string): CheckStep => ({ id, status: 'skipped', summary, details: [] });

/** Runs the four steps in chain order, showing each as it finishes. */
async function runCheck() {
  const d = useDiagnose.getState();
  if (d.checking) return;
  d.set({
    checking: true,
    publicAddress: undefined,
    steps: { local: { id: 'local', status: 'running' }, gateway: idle('gateway'), dns: idle('dns'), internet: idle('internet'), service: idle('service') },
  });
  const api = window.api.diagnose;
  // Asked while the chain runs; it only needs the internet, not the earlier steps.
  const address = api
    .publicAddress()
    .then((p) => d.set({ publicAddress: p ?? null }))
    .catch(() => d.set({ publicAddress: null }));
  const guard = async (id: CheckStepId, run: () => Promise<CheckStep>) => {
    d.setStep({ id, status: 'running' });
    try {
      d.setStep(await run());
    } catch (err) {
      d.setStep({ id, status: 'fail', summary: 'Check failed', details: [cleanError(err)] });
    }
  };
  try {
    const { link, step } = await api.local();
    d.set({ link });
    d.setStep(step);
    if (link.gateway) await guard('gateway', () => api.gateway(link.gateway as string));
    else d.setStep(skipped('gateway', 'No gateway to test'));
    await guard('dns', () => api.dns(link.dnsServers));
    await guard('internet', () => api.internet());
    const service = useDiagnose.getState().service;
    if (parseServiceTarget(service)) await guard('service', () => api.service(service));
  } catch (err) {
    d.setStep({ id: 'local', status: 'fail', summary: 'Check failed', details: [cleanError(err)] });
  } finally {
    await address;
    d.set({ checking: false, checkedAt: Date.now() });
  }
}

/** The public address line under the check: addresses with copy buttons, the provider and the reverse name. */
function PublicAddressLine() {
  const p = useDiagnose((s) => s.publicAddress);
  const checking = useDiagnose((s) => s.checking);
  if (p === undefined) return checking ? <p className="dg-public muted">Public address: asking…</p> : null;
  if (p === null || (!p.ipv4 && !p.ipv6))
    return <p className="dg-public muted">Public address: no answer from the public service, or the internet could not be reached.</p>;
  return (
    <p className="dg-public">
      <span className="muted">Public address</span>
      {p.ipv4 && <Copyable value={p.ipv4} label="public IPv4 address" mono />}
      {p.ipv6 && (
        <span>
          <span className="muted">IPv6 </span>
          <Copyable value={p.ipv6} label="public IPv6 address" mono />
        </span>
      )}
      {p.provider && (
        <span>
          <span className="muted">Provider </span>
          {p.provider}
          {p.asn ? <span className="muted"> · AS{p.asn}</span> : null}
        </span>
      )}
      {p.name && (
        <span>
          <span className="muted">Name </span>
          <span className="mono">{p.name}</span>
        </span>
      )}
    </p>
  );
}

function startTrace(target: string) {
  const t = target.trim();
  const id = `t${Date.now()}`;
  useDiagnose.getState().setTrace({ id, target: t, running: true, hops: [], destination: undefined, done: undefined, error: undefined });
  window.api.diagnose.trace(id, t).catch((err: unknown) => useDiagnose.getState().setTrace({ running: false, error: cleanError(err) }));
}

/** Applies one trace event to the store, ignoring events from an earlier trace. */
function onTraceEvent(e: TraceEvent) {
  const { trace, setTrace } = useDiagnose.getState();
  if (e.id !== trace.id) return;
  if (e.kind === 'start') setTrace({ destination: e.destination });
  else if (e.kind === 'hop') setTrace({ hops: [...trace.hops.filter((h) => h.n !== e.hop.n), e.hop].sort((a, b) => a.n - b.n) });
  else if (e.kind === 'done') setTrace({ running: false, destination: e.destination ?? trace.destination, done: { reached: e.reached, stoppedEarly: e.stoppedEarly } });
  else setTrace({ running: false, error: e.message });
}

function StatusDot({ status }: { status: CheckStatus | 'running' | 'idle' }) {
  return <span className={`dg-dot ${status}`} aria-hidden />;
}

function CheckPanel() {
  const steps = useDiagnose((s) => s.steps);
  const checking = useDiagnose((s) => s.checking);
  const checkedAt = useDiagnose((s) => s.checkedAt);
  const service = useDiagnose((s) => s.service);
  const set = useDiagnose((s) => s.set);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(service);
  // The service step shows once one is set, or when the last run checked one.
  const shown = STEPS.filter((s) => s.id !== 'service' || parseServiceTarget(service) || steps.service.status !== 'idle');
  const done = shown.map((s) => steps[s.id]).filter((s): s is CheckStep => 'summary' in s);
  const answer = !checking && checkedAt && done.length === shown.length ? verdict(done) : undefined;
  const saveService = (text: string) => {
    const clean = text.trim();
    localStorage.setItem(SERVICE_KEY, clean);
    set({ service: clean, steps: { ...useDiagnose.getState().steps, service: idle('service') } });
    setEditing(false);
  };
  const draftValid = !draft.trim() || !!parseServiceTarget(draft);

  return (
    <section className="panel dg-panel">
      <div className="panel-h">
        Network or provider?
        <span className="sub">Tests each link from this computer to the internet, in order.</span>
        <div className="right">
          {checkedAt && !checking && <span className="muted dg-when">Checked {new Date(checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
          <button className="btn primary" disabled={checking} onClick={() => void runCheck()}>
            {checkedAt ? <RotateCw className="icon" /> : <Play className="icon" />} {checking ? 'Checking…' : checkedAt ? 'Run again' : 'Run check'}
          </button>
        </div>
      </div>
      <ol className="dg-chain" style={{ gridTemplateColumns: `repeat(${shown.length}, minmax(0, 1fr))` }}>
        {shown.map((def, i) => {
          const st = steps[def.id];
          const result = 'summary' in st ? st : undefined;
          const next = i < shown.length - 1 ? steps[(shown[i + 1] as (typeof STEPS)[number]).id] : undefined;
          return (
            <li key={def.id} className={`dg-step ${st.status}${answer?.culprit === def.id && answer.status === 'fail' ? ' culprit' : ''}`}>
              {next && <span className={`dg-link ${st.status === 'ok' || st.status === 'warn' ? (next.status === 'idle' ? 'half' : 'on') : ''}`} aria-hidden />}
              <span className="dg-node">
                <def.icon className="icon" />
                <StatusDot status={st.status} />
              </span>
              <b>{def.name}</b>
              <span className="mono dg-target">{result?.target ?? (st.status === 'running' ? 'Testing…' : def.id === 'service' ? service : '—')}</span>
              <span className="dg-summary">{result?.summary ?? ''}</span>
              {result && result.details.length > 0 && (
                <ul className="dg-details">
                  {result.details.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
      <PublicAddressLine />
      <div className="dg-service">
        {editing ? (
          <form
            className="dg-service-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (draftValid) saveService(draft);
            }}
          >
            <label className={`input${draftValid ? '' : ' invalid'}`} style={{ width: 340 }}>
              <AppWindow className="icon" />
              <input
                autoFocus
                aria-label="Service to check"
                placeholder="erp.example.com, 10.0.5.20:3389 or https://portal.example.com"
                value={draft}
                spellCheck={false}
                onChange={(e) => setDraft(e.target.value)}
              />
            </label>
            <button type="submit" className="btn sm primary" disabled={!draftValid}>
              Save
            </button>
            <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            {!draftValid && <span className="dg-error-inline">Use a host name, an IP address, host:port or a web address.</span>}
          </form>
        ) : service ? (
          <span className="muted">
            Also checking <span className="mono">{service}</span> ·{' '}
            <button className="link" disabled={checking} onClick={() => (setDraft(service), setEditing(true))}>
              Change
            </button>{' '}
            ·{' '}
            <button className="link" disabled={checking} onClick={() => saveService('')}>
              Remove
            </button>
          </span>
        ) : (
          <button className="link" disabled={checking} onClick={() => (setDraft(''), setEditing(true))}>
            <Plus className="icon" /> Add a service the customer relies on, such as their business system, VPN or portal
          </button>
        )}
      </div>
      {answer ? (
        <div className={`dg-verdict ${answer.status}`} role="status">
          <StatusDot status={answer.status} />
          <span>
            <b>{answer.status === 'ok' ? 'All clear.' : answer.status === 'warn' ? 'Works, with warnings.' : 'Found the break.'}</b> {answer.text}
          </span>
        </div>
      ) : (
        !checking && <p className="dg-hint muted">Run the check from the spot where the problem is reported, on the same cable or WiFi network as the affected devices.</p>
      )}
    </section>
  );
}

function TracePanel() {
  const trace = useDiagnose((s) => s.trace);
  const setTrace = useDiagnose((s) => s.setTrace);
  const link = useDiagnose((s) => s.link);
  const assets = useStore((s) => s.assets);
  const [draft, setDraft] = useState(trace.target);
  const byIp = useMemo(() => new Map(Object.values(assets).map((a) => [a.ip, a])), [assets]);
  const valid = isTraceTarget(draft.trim());
  const slowest = Math.max(1, ...trace.hops.flatMap((h) => h.times.filter((t): t is number => t !== null)));
  const service = parseServiceTarget(useDiagnose((s) => s.service));
  const suggestions = [link?.gateway && { label: 'Gateway', value: link.gateway }, { label: 'Public DNS', value: '1.1.1.1' }, service && { label: service.host, value: service.host }].filter(
    (x): x is { label: string; value: string } => !!x,
  );

  const submit = () => {
    if (trace.running || !valid) return;
    setTrace({ target: draft.trim() });
    startTrace(draft);
  };

  return (
    <section className="panel dg-panel">
      <div className="panel-h">
        Traceroute
        <span className="sub">The route to a host, hop by hop, and where it stops answering.</span>
      </div>
      <div className="dg-trace-bar">
        <form
          className="dg-trace-form"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="input" style={{ width: 300 }}>
            <Search className="icon" />
            <input aria-label="Host or IP address to trace" placeholder="Host name or IP address" value={draft} spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
          </label>
          {trace.running ? (
            <button type="button" className="btn" onClick={() => trace.id && void window.api.diagnose.cancelTrace(trace.id)}>
              <Square className="icon" /> Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!valid}>
              <Play className="icon" /> Trace
            </button>
          )}
        </form>
        <div className="dg-suggest">
          {suggestions.map((s) => (
            <button key={s.value} className="chip" disabled={trace.running} onClick={() => setDraft(s.value)} title={s.value}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {trace.error && <p className="dg-error">{trace.error}</p>}
      {trace.hops.length > 0 || trace.running ? (
        <table className="data-table dg-hops">
          <thead>
            <tr>
              <th className="num">Hop</th>
              <th>Address</th>
              <th>Name</th>
              <th>Replies</th>
              <th className="num">Average</th>
              <th className="dg-barcol">Latency</th>
            </tr>
          </thead>
          <tbody>
            {trace.hops.map((h) => {
              const { lossPct, avgMs } = hopStats(h);
              const known = h.ip ? byIp.get(h.ip) : undefined;
              const isDest = !!h.ip && h.ip === trace.destination;
              return (
                <tr key={h.n} className={h.ip ? '' : 'silent'}>
                  <td className="num mono">{h.n}</td>
                  <td className="mono">
                    {h.ip ?? '* * *'}
                    {h.others.length > 0 && <span className="muted"> +{h.others.length}</span>}
                  </td>
                  <td>
                    {known ? displayName(known) : h.ip ? (isDest ? trace.target : '') : <span className="muted">No reply. Normal for routers that ignore traceroute.</span>}
                    {h.flags.length > 0 && <span className="dg-flag"> Unreachable ({h.flags.join(' ')})</span>}
                  </td>
                  <td>
                    <span className="dg-probes" aria-label={`${100 - lossPct}% of probes answered`}>
                      {h.times.map((t, i) => (
                        <i key={i} className={t === null ? 'lost' : ''} />
                      ))}
                    </span>
                  </td>
                  <td className="num mono">{avgMs !== undefined ? `${avgMs} ms` : '—'}</td>
                  <td className="dg-barcol">
                    {avgMs !== undefined && <span className="dg-bar" style={{ width: `${Math.max(2, (avgMs / slowest) * 100)}%` }} />}
                  </td>
                </tr>
              );
            })}
            {trace.running && (
              <tr className="dg-pending">
                <td className="num mono">{(trace.hops.at(-1)?.n ?? 0) + 1}</td>
                <td colSpan={5} className="muted">
                  Waiting for replies…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      ) : (
        !trace.error && <p className="dg-hint muted">Trace the gateway, a public address or any host the customer cannot reach. Names come from the inventory when a hop is a known device.</p>
      )}
      {trace.done && (
        <div className={`dg-verdict ${trace.done.reached ? 'ok' : 'warn'}`} role="status">
          <StatusDot status={trace.done.reached ? 'ok' : 'warn'} />
          <span>
            {trace.done.reached
              ? `Reached ${trace.target}${trace.destination && trace.destination !== trace.target ? ` (${trace.destination})` : ''} in ${trace.hops.at(-1)?.n ?? 0} hops.`
              : trace.done.stoppedEarly
                ? `Stopped after ${trace.hops.filter((h) => !h.ip).length >= 5 ? 'five' : 'several'} hops in a row with no reply. The path likely breaks after hop ${[...trace.hops].reverse().find((h) => h.ip)?.n ?? 0}, or the destination blocks traceroute.`
                : `Did not reach ${trace.target}. The last hop that answered is ${[...trace.hops].reverse().find((h) => h.ip)?.ip ?? 'none'}.`}
          </span>
        </div>
      )}
    </section>
  );
}

// Subscribed once for the life of the window, so a trace keeps updating while another module is shown.
window.api.diagnose.onTrace(onTraceEvent);

const TOOLS = [
  { id: 'check', label: 'Network or provider?' },
  { id: 'trace', label: 'Traceroute' },
  { id: 'ping', label: 'Live ping' },
  { id: 'ports', label: 'Port test' },
  { id: 'dns', label: 'DNS lookup' },
  { id: 'mtu', label: 'Path MTU' },
  { id: 'dhcp', label: 'DHCP servers', beta: true },
] as const;
type ToolId = (typeof TOOLS)[number]['id'];

/** Tool shown when Diagnose opens again in the same session. */
let lastTool: ToolId = 'check';

/** Hosts offered as shortcuts by the quick tests: the gateway, public DNS and the configured service. */
function useSuggestions() {
  const link = useDiagnose((s) => s.link);
  const service = parseServiceTarget(useDiagnose((s) => s.service));
  return [link?.gateway && { label: 'Gateway', value: link.gateway }, { label: 'Public DNS', value: '1.1.1.1' }, service && { label: service.host, value: service.host }].filter(
    (x): x is { label: string; value: string } => !!x,
  );
}

export function Diagnose() {
  const [tool, setTool] = useState<ToolId>(lastTool);
  const suggestions = useSuggestions();
  const choose = (id: ToolId) => {
    lastTool = id;
    setTool(id);
  };
  // The gateway shortcut needs this computer's connection, which the check also reads.
  const link = useDiagnose((s) => s.link);
  useEffect(() => {
    if (!link) void window.api.diagnose.local().then(({ link: l }) => useDiagnose.getState().set({ link: l }), () => undefined);
  }, [link]);
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const i = TOOLS.findIndex((t) => t.id === tool);
    const next = TOOLS[(i + step + TOOLS.length) % TOOLS.length] as (typeof TOOLS)[number];
    choose(next.id);
    document.getElementById(`dg-tab-${next.id}`)?.focus();
  };
  return (
    <div className="page dg-page">
      <div className="page-h">
        <div>
          <h1>Diagnose</h1>
          <p>Find where a connection breaks, from this computer out to the internet.</p>
        </div>
      </div>
      <div className="dg-tabs" role="tablist" aria-label="Diagnose tools" onKeyDown={onKey}>
        {TOOLS.map((t) => (
          <button
            key={t.id}
            id={`dg-tab-${t.id}`}
            role="tab"
            aria-selected={tool === t.id}
            aria-controls="dg-tool"
            tabIndex={tool === t.id ? 0 : -1}
            onClick={() => choose(t.id)}
          >
            {t.label}
            {'beta' in t && <span className="beta-tag">Beta</span>}
          </button>
        ))}
      </div>
      <div id="dg-tool" role="tabpanel" aria-labelledby={`dg-tab-${tool}`}>
        {tool === 'check' ? (
          <CheckPanel />
        ) : tool === 'trace' ? (
          <TracePanel />
        ) : tool === 'ping' ? (
          <LivePing suggestions={suggestions} />
        ) : tool === 'ports' ? (
          <PortTest suggestions={suggestions} />
        ) : tool === 'dns' ? (
          <DnsTool />
        ) : tool === 'mtu' ? (
          <MtuTool suggestions={suggestions} />
        ) : (
          <DhcpTool />
        )}
      </div>
    </div>
  );
}
