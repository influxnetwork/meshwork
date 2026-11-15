import { create } from 'zustand';
import {
  DEFAULT_SETTINGS,
  type Asset,
  type AppInfo,
  type Network,
  type ScanEvent,
  type ScanProgress,
  type ScanSettings,
  type ScanSummary,
  type VendorDbStatus,
} from '@shared/types';

export type View = 'map' | 'discover' | 'inventory' | 'diagnose' | 'wifi';
export type Theme = 'dark' | 'light';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

interface ScanState {
  runId?: string;
  running: boolean;
  progress?: ScanProgress;
  /** Asset ids seen in the current or last run, newest first. */
  seen: string[];
  /** Inventory network the current or last run is saved to. */
  networkId?: string;
  summary?: ScanSummary;
  error?: string;
}

interface State {
  info?: AppInfo;
  view: View;
  theme: Theme;
  settings: ScanSettings;
  assets: Record<string, Asset>;
  runs: ScanSummary[];
  networks: Network[];
  /** Network shown in Network Inventory, or every network. */
  networkFilter: 'all' | string;
  vendors?: VendorDbStatus;
  scan: ScanState;
  selectedId?: string;
  toasts: Toast[];
  /** Device the map should show when it opens: a network and the node to zoom to. */
  mapFocus?: { networkId: string; nodeId: string };

  setView(view: View): void;
  toggleTheme(): void;
  setSettings(patch: Partial<ScanSettings>): void;
  select(id?: string): void;
  /** Shows one network (or all) in Network Inventory and switches to it. */
  openNetwork(id: 'all' | string | undefined): void;
  /** Switches to the map and zooms to one node of one network. */
  showOnMap(networkId: string, nodeId: string): void;
  clearMapFocus(): void;
  setNetworkFilter(id: 'all' | string): void;
  renameNetwork(id: string, name: string): Promise<void>;
  removeNetwork(id: string): Promise<void>;
  removeRun(id: string): Promise<void>;
  load(): Promise<void>;
  startScan(): Promise<void>;
  /** Scans `targets` with the current settings and adds what is found to an existing network. */
  scanInto(networkId: string, targets: string): Promise<void>;
  cancelScan(): Promise<void>;
  removeAsset(id: string): Promise<void>;
  toast(kind: Toast['kind'], text: string): void;
  dismissToast(id: number): void;
  handleEvent(event: ScanEvent): void;
  refreshVendors(): Promise<void>;
}

const SETTINGS_KEY = 'scan-settings';
const THEME_KEY = 'theme';

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function initialSettings(): ScanSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<ScanSettings>) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Strips Electron's "Error invoking remote method" prefix from IPC errors. */
export function cleanError(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  view: 'discover',
  theme: initialTheme(),
  settings: initialSettings(),
  assets: {},
  runs: [],
  networks: [],
  networkFilter: 'all',
  scan: { running: false, seen: [] },
  toasts: [],

  // Leaving the map drops a request to show a device that could not be shown, so it does not fire on a later visit.
  setView: (view) => set(view === 'map' ? { view } : { view, mapFocus: undefined }),

  toggleTheme: () => {
    const theme = get().theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, theme);
    set({ theme });
  },

  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    set({ settings });
  },

  select: (selectedId) => set({ selectedId }),

  openNetwork: (id) => set({ view: 'inventory', networkFilter: id ?? 'all' }),

  showOnMap: (networkId, nodeId) => set({ view: 'map', mapFocus: { networkId, nodeId } }),

  clearMapFocus: () => set({ mapFocus: undefined }),

  setNetworkFilter: (networkFilter) => set({ networkFilter }),

  renameNetwork: async (id, name) => {
    try {
      const network = await window.api.inventory.renameNetwork(id, name);
      set((s) => ({ networks: s.networks.map((n) => (n.id === id ? network : n)) }));
    } catch (err) {
      get().toast('error', cleanError(err));
    }
  },

  removeRun: async (id) => {
    try {
      await window.api.inventory.removeRun(id);
      set((s) => ({ runs: s.runs.filter((r) => r.runId !== id) }));
    } catch (err) {
      get().toast('error', cleanError(err));
    }
  },

  removeNetwork: async (id) => {
    const network = get().networks.find((n) => n.id === id);
    await window.api.inventory.removeNetwork(id);
    set((s) => {
      const assets = Object.fromEntries(Object.entries(s.assets).filter(([, a]) => a.networkId !== id));
      return {
        assets,
        networks: s.networks.filter((n) => n.id !== id),
        runs: s.runs.filter((r) => r.networkId !== id),
        networkFilter: s.networkFilter === id ? 'all' : s.networkFilter,
        selectedId: s.selectedId && assets[s.selectedId] ? s.selectedId : undefined,
        scan: s.scan.networkId === id ? { running: s.scan.running, seen: [] } : s.scan,
      };
    });
    if (network) get().toast('info', `Deleted ${network.name} and its devices.`);
  },

  load: async () => {
    const [info, list, runs, networks, vendors, local] = await Promise.all([
      window.api.app.info(),
      window.api.inventory.list(),
      window.api.inventory.runs(),
      window.api.inventory.networks(),
      window.api.vendors.status(),
      window.api.scan.localTargets(),
    ]);
    const assets = Object.fromEntries(list.map((a) => [a.id, a]));
    set({ info, assets, runs, networks, vendors, selectedId: list[0]?.id });
    // Costly effects (glows, soft shadows) are dropped when drawing without a graphics card.
    document.documentElement.dataset.gfx = info.lowGraphics ? 'low' : 'full';
    if (!get().settings.targets && local[0]) get().setSettings({ targets: local[0].cidr });
  },

  startScan: async () => {
    const { settings } = get();
    try {
      set({ scan: { running: true, seen: [], progress: undefined } });
      const { runId } = await window.api.scan.start(settings);
      set((s) => ({ scan: { ...s.scan, runId } }));
    } catch (err) {
      const message = cleanError(err);
      set({ scan: { running: false, seen: [], error: message } });
      get().toast('error', message);
    }
  },

  scanInto: async (networkId, targets) => {
    const { settings, scan } = get();
    if (scan.running) {
      get().toast('info', 'A scan is already running. Try again when it finishes.');
      return;
    }
    try {
      set({ scan: { running: true, seen: [], progress: undefined } });
      const { runId } = await window.api.scan.start({ ...settings, targets, intoNetwork: networkId });
      set((s) => ({ scan: { ...s.scan, runId } }));
    } catch (err) {
      const message = cleanError(err);
      set({ scan: { running: false, seen: [], error: message } });
      get().toast('error', message);
    }
  },

  cancelScan: async () => {
    const { runId } = get().scan;
    if (runId) await window.api.scan.cancel(runId);
  },

  removeAsset: async (id) => {
    await window.api.inventory.remove(id);
    set((s) => {
      const assets = { ...s.assets };
      delete assets[id];
      return {
        assets,
        selectedId: s.selectedId === id ? undefined : s.selectedId,
        scan: { ...s.scan, seen: s.scan.seen.filter((x) => x !== id) },
      };
    });
  },

  toast: (kind, text) => {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    if (kind !== 'error') setTimeout(() => get().dismissToast(id), 5000);
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  refreshVendors: async () => set({ vendors: await window.api.vendors.status() }),

  handleEvent: (event) => {
    switch (event.type) {
      case 'progress':
        set((s) => (event.progress.runId === s.scan.runId || s.scan.running ? { scan: { ...s.scan, runId: event.progress.runId, progress: event.progress } } : {}));
        return;
      case 'network': {
        const n = event.network;
        set((s) => ({
          networks: [n, ...s.networks.filter((x) => x.id !== n.id)],
          scan: event.runId === s.scan.runId || s.scan.running ? { ...s.scan, networkId: n.id } : s.scan,
        }));
        return;
      }
      case 'network-removed':
        set((s) => ({
          networks: s.networks.filter((n) => n.id !== event.networkId),
          networkFilter: s.networkFilter === event.networkId ? 'all' : s.networkFilter,
          scan: s.scan.networkId === event.networkId ? { ...s.scan, networkId: undefined } : s.scan,
        }));
        return;
      case 'asset': {
        const a = event.asset;
        set((s) => ({
          assets: { ...s.assets, [a.id]: a },
          scan: a.lastRunId === s.scan.runId && !s.scan.seen.includes(a.id) ? { ...s.scan, seen: [a.id, ...s.scan.seen] } : s.scan,
        }));
        return;
      }
      case 'done': {
        const s = event.summary;
        if (s.discarded) {
          // The network was deleted while the scan ran: the scan ends with nothing saved or listed.
          set((st) => ({ scan: { ...st.scan, running: false, networkId: undefined, seen: [] } }));
          get().toast('info', 'Scan stopped: its network was deleted.');
          return;
        }
        set((st) => ({ scan: { ...st.scan, running: false, summary: s }, runs: [s, ...st.runs.filter((r) => r.runId !== s.runId)] }));
        const where = get().networks.find((n) => n.id === s.networkId)?.name;
        get().toast(
          s.status === 'done' ? 'success' : 'info',
          (s.status === 'done'
            ? `Scan finished: ${s.live} devices, ${s.newAssets} new, ${s.risks} risks.`
            : `Scan stopped after finding ${s.live} devices.`) + (where ? ` Saved to ${where}.` : ''),
        );
        return;
      }
      case 'error':
        set((st) => ({ scan: { ...st.scan, running: false, error: event.message } }));
        get().toast('error', event.message);
        return;
    }
  },
}));
