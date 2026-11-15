/**
 * Network strip for Network Inventory: one card per stored network plus "All networks".
 * Cards show device and risk counts and the last scan, and offer inline rename and delete.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ChevronRight, Globe, Layers, Pencil, Router, Search, Trash2 } from 'lucide-react';
import type { Asset, Network } from '@shared/types';
import { useStore } from './store';
import { relativeTime } from './ui';

/** Card geometry used to work out how many network cards fit on one row (see .net-card in app.css). */
const CARD_MIN = 200;
const ALL_CARD = 180;
const MORE_CARD = 130;
const GAP = 10;

/** Number of network cards that fit beside "All networks" (and the "more" card when needed). */
function cardsThatFit(width: number, total: number): number {
  const room = width - ALL_CARD - GAP;
  const withoutMore = Math.floor((room + GAP) / (CARD_MIN + GAP));
  if (withoutMore >= total) return total;
  return Math.max(1, Math.floor((room - MORE_CARD) / (CARD_MIN + GAP)));
}

interface Counts {
  devices: number;
  risks: number;
}

function countByNetwork(assets: Asset[]): Map<string, Counts> {
  const out = new Map<string, Counts>();
  for (const a of assets) {
    const c = out.get(a.networkId) ?? { devices: 0, risks: 0 };
    c.devices++;
    if (a.risks.length) c.risks++;
    out.set(a.networkId, c);
  }
  return out;
}

/** True for networks this computer was attached to when scanned (identified by router or subnet). */
function isLocal(n: Network): boolean {
  return !n.fingerprint.startsWith('range:');
}

function NetworkCard({
  network,
  counts,
  selected,
  onSelect,
  onDelete,
}: {
  network: Network;
  counts: Counts;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const rename = useStore((s) => s.renameNetwork);
  // A network cannot be deleted while a scan is saving devices to it.
  const scanning = useStore((s) => s.scan.running && s.scan.networkId === network.id);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(network.name);
  const Icon = isLocal(network) ? Router : Globe;

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== network.name) void rename(network.id, name);
    else setDraft(network.name);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      setDraft(network.name);
      setEditing(false);
    }
  };

  return (
    <div className="net-card" aria-current={selected || undefined}>
      <button className="net-hit" onClick={onSelect} aria-label={`Show ${network.name}`} />
      <div className="net-icon" style={{ background: isLocal(network) ? 'var(--device-router)' : 'var(--device-server)' }}>
        <Icon className="icon" />
      </div>
      <div className="net-body">
        {editing ? (
          <input
            className="net-rename"
            autoFocus
            value={draft}
            maxLength={80}
            aria-label="Network name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onBlur={commit}
          />
        ) : (
          <div className="net-name" title={network.name}>
            {network.name}
          </div>
        )}
        {network.name !== network.cidr ? (
          <div className="net-cidr mono">{network.cidr}</div>
        ) : (
          network.gatewayIp && <div className="net-cidr">router {network.gatewayIp}</div>
        )}
        <div className="net-meta">
          <span>{counts.devices} devices</span>
          {counts.risks > 0 && <span className="net-risk">{counts.risks} at risk</span>}
          <span className="muted">{relativeTime(network.lastScanAt)}</span>
        </div>
      </div>
      <div className="net-actions">
        <button
          className="icon-btn"
          aria-label={`Rename ${network.name}`}
          title="Rename"
          onClick={() => {
            setDraft(network.name);
            setEditing(true);
          }}
        >
          <Pencil className="icon" />
        </button>
        <button
          className="icon-btn danger"
          aria-label={`Delete ${network.name}`}
          title={scanning ? 'A scan is running on this network. Stop it or wait for it to finish to delete the network.' : 'Delete network'}
          disabled={scanning}
          onClick={onDelete}
        >
          <Trash2 className="icon" />
        </button>
      </div>
    </div>
  );
}

export function NetworkStrip({ assets }: { assets: Asset[] }) {
  const networks = useStore((s) => s.networks);
  const filter = useStore((s) => s.networkFilter);
  const setFilter = useStore((s) => s.setNetworkFilter);
  const removeNetwork = useStore((s) => s.removeNetwork);
  const [pendingDelete, setPendingDelete] = useState<Network>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreQuery, setMoreQuery] = useState('');
  const counts = useMemo(() => countByNetwork(assets), [assets]);
  const stripRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // Most recently scanned first; as many as fit on one row; the selected network always keeps its card.
  const visible = networks.slice(0, width ? cardsThatFit(width, networks.length) : networks.length);
  const selectedHidden = networks.find((n) => n.id === filter && !visible.includes(n));
  if (selectedHidden) visible[visible.length - 1] = selectedHidden;
  const hidden = networks.length - visible.length;
  const q = moreQuery.trim().toLowerCase();
  const matches = networks.filter((n) => !q || n.name.toLowerCase().includes(q) || n.cidr.includes(q) || n.gatewayIp?.includes(q));
  const total = assets.length;
  const atRisk = assets.filter((a) => a.risks.length).length;

  return (
    <>
      <div className="net-strip" role="list" aria-label="Networks" ref={stripRef}>
        <div className="net-card all" role="listitem" aria-current={filter === 'all' || undefined}>
          <button className="net-hit" onClick={() => setFilter('all')} aria-label="Show all networks" />
          <div className="net-icon" style={{ background: 'var(--accent)' }}>
            <Layers className="icon" />
          </div>
          <div className="net-body">
            <div className="net-name">All networks</div>
            <div className="net-cidr">
              {networks.length} {networks.length === 1 ? 'network' : 'networks'}
            </div>
            <div className="net-meta">
              <span>{total} devices</span>
              {atRisk > 0 && <span className="net-risk">{atRisk} at risk</span>}
            </div>
          </div>
        </div>
        {visible.map((n) => (
          <div key={n.id} role="listitem" className="net-item">
            <NetworkCard
              network={n}
              counts={counts.get(n.id) ?? { devices: 0, risks: 0 }}
              selected={filter === n.id}
              onSelect={() => setFilter(n.id)}
              onDelete={() => setPendingDelete(n)}
            />
          </div>
        ))}
        {hidden > 0 && (
          <div role="listitem" className="net-item more-item">
            <button className="net-card more" onClick={() => setMoreOpen(true)}>
              <span className="net-more-count">+{hidden}</span>
              <span>
                more {hidden === 1 ? 'network' : 'networks'}
                <ChevronRight className="icon" />
              </span>
            </button>
          </div>
        )}
      </div>

      <Dialog.Root
        open={moreOpen}
        onOpenChange={(o) => {
          setMoreOpen(o);
          if (!o) setMoreQuery('');
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="scrim" />
          <Dialog.Content className="dialog net-picker">
            <Dialog.Title asChild>
              <h2 style={{ margin: '0 0 4px' }}>All networks</h2>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p className="muted" style={{ margin: '0 0 12px' }}>
                {networks.length} networks, most recently scanned first.
              </p>
            </Dialog.Description>
            <label className="input">
              <Search className="icon" />
              <input
                autoFocus
                value={moreQuery}
                placeholder="Search by name, subnet or router IP"
                aria-label="Search networks"
                onChange={(e) => setMoreQuery(e.target.value)}
              />
            </label>
            <ul className="net-list">
              {matches.map((n) => {
                const c = counts.get(n.id) ?? { devices: 0, risks: 0 };
                const Icon = isLocal(n) ? Router : Globe;
                return (
                  <li key={n.id}>
                    <button
                      aria-current={filter === n.id || undefined}
                      onClick={() => {
                        setFilter(n.id);
                        setMoreOpen(false);
                        setMoreQuery('');
                      }}
                    >
                      <span className="net-icon sm" style={{ background: isLocal(n) ? 'var(--device-router)' : 'var(--device-server)' }}>
                        <Icon className="icon" />
                      </span>
                      <span className="net-list-main">
                        <span className="net-name">{n.name}</span>
                        <span className="net-cidr mono">
                          {n.cidr}
                          {n.gatewayIp ? ` · router ${n.gatewayIp}` : ''}
                        </span>
                      </span>
                      <span className="net-list-side">
                        <span>
                          {c.devices} devices
                          {c.risks > 0 && <span className="net-risk"> · {c.risks} at risk</span>}
                        </span>
                        <span className="muted">{relativeTime(n.lastScanAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
              {matches.length === 0 && <li className="muted net-list-empty">No network matches “{moreQuery}”.</li>}
            </ul>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <Dialog.Root open={!!pendingDelete} onOpenChange={(o) => !o && setPendingDelete(undefined)}>
        <Dialog.Portal>
          <Dialog.Overlay className="scrim" />
          <Dialog.Content className="dialog">
            <Dialog.Title asChild>
              <h2 style={{ margin: '0 0 8px' }}>Delete {pendingDelete?.name}?</h2>
            </Dialog.Title>
            <Dialog.Description asChild>
              <p>
                This removes the network, its {pendingDelete ? (counts.get(pendingDelete.id)?.devices ?? 0) : 0} devices and its scan
                history from this computer. Scanning it again adds it back.
              </p>
            </Dialog.Description>
            <div className="row">
              <Dialog.Close asChild>
                <button className="btn">Cancel</button>
              </Dialog.Close>
              <button
                className="btn danger"
                onClick={() => {
                  if (pendingDelete) void removeNetwork(pendingDelete.id);
                  setPendingDelete(undefined);
                }}
              >
                <Trash2 className="icon" /> Delete network
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
