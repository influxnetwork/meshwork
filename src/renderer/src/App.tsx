import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Activity, Layers, Moon, Radar, Settings, Sun, Waypoints, Wifi } from 'lucide-react';
import { cleanError, useStore, type View } from './store';
import { Toasts } from './ui';
import { Discover } from './Discover';
import { Inventory } from './Inventory';
import { Wifi as WifiPage } from './Wifi';
import { MapView } from './MapView';
import { SettingsDialog } from './Settings';
import { Diagnose } from './Diagnose';
import { UpdateChip, useUpdateFeed, useUpdates, WelcomeNotice, WhatsNewNotice } from './Updates';
import logoUrl from './assets/logo.png';

// In the order of a site visit: find the devices, keep them, draw them, troubleshoot, then the air.
const MODULES: { id: View; label: string; icon: typeof Radar; ready: boolean }[] = [
  { id: 'discover', label: 'Discover', icon: Radar, ready: true },
  { id: 'inventory', label: 'Network Inventory', icon: Layers, ready: true },
  { id: 'map', label: 'Map', icon: Waypoints, ready: true },
  { id: 'diagnose', label: 'Diagnose', icon: Activity, ready: true },
  { id: 'wifi', label: 'WiFi', icon: Wifi, ready: true },
];

const TITLES: Record<View, string> = { map: 'Map', discover: 'Discover', inventory: 'Network Inventory', diagnose: 'Diagnose', wifi: 'WiFi' };

export function App() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const load = useStore((s) => s.load);
  const handleEvent = useStore((s) => s.handleEvent);
  const info = useStore((s) => s.info);
  const scanning = useStore((s) => s.scan.running);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useUpdateFeed();

  useEffect(() => {
    void load();
    return window.api.scan.onEvent(handleEvent);
  }, [load, handleEvent]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(
    () =>
      window.menu.onCommand((command) => {
        const s = useStore.getState();
        if (command === 'view.discover' || command === 'scan.new') s.setView('discover');
        else if (command === 'view.inventory') s.setView('inventory');
        else if (command === 'view.wifi') s.setView('wifi');
        else if (command === 'view.map') s.setView('map');
        else if (command === 'view.diagnose') s.setView('diagnose');
        else if (command === 'theme.toggle') s.toggleTheme();
        else if (command === 'inventory.reload') void s.load();
        else if (command === 'settings.open') setSettingsOpen(true);
        else if (command === 'updates.check') {
          setSettingsOpen(true);
          void window.api.updates.check().then(useUpdates.getState().set, () => undefined);
        }
        else if (command === 'inventory.export') {
          void window.api.inventory.exportCsv().then((path) => path && s.toast('success', `Exported devices to ${path}`));
        }
      }),
    [],
  );

  return (
    <div className={`app platform-${info?.platform ?? 'darwin'}`}>
      <header className="titlebar">
        <div className="brand">
          <img className="logo" src={logoUrl} alt="" />
          Meshwork
        </div>
        <span className="muted">/</span>
        <span className="crumbs">{TITLES[view]}</span>
        <div className="tb-right">
          <UpdateChip />
          {info?.version && (
            <button className="app-version" title="About Meshwork" aria-label={`About Meshwork, version ${info.version}`} onClick={() => setAboutOpen(true)}>
              v{info.version}
            </button>
          )}
          {scanning && (
            <button className="chip" onClick={() => setView('discover')}>
              <Radar className="icon" style={{ color: 'var(--accent)' }} /> Scanning…
            </button>
          )}
          <button className="icon-btn" onClick={() => setSettingsOpen(true)} aria-label="Settings" title="Settings">
            <Settings className="icon" />
          </button>
          <button className="icon-btn" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>
            {theme === 'dark' ? <Sun className="icon" /> : <Moon className="icon" />}
          </button>
        </div>
      </header>

      <nav className="rail" aria-label="Modules">
        {MODULES.map((m) => (
          <button
            key={m.id}
            className={view === m.id ? 'active' : ''}
            disabled={!m.ready}
            aria-label={m.label}
            aria-current={view === m.id ? 'page' : undefined}
            onClick={() => m.ready && setView(m.id)}
          >
            <m.icon className="icon" />
            <span className="tip">{m.label}</span>
            {m.id === 'discover' && scanning && view !== 'discover' && <span className="badge" />}
          </button>
        ))}
        <div className="spacer" />
      </nav>

      <main className="main">
        {view === 'discover' ? <Discover /> : view === 'wifi' ? <WifiPage /> : view === 'map' ? <MapView /> : view === 'diagnose' ? <Diagnose /> : <Inventory />}
      </main>
      <Toasts />
      <AboutDialog open={aboutOpen} onOpenChange={setAboutOpen} version={info?.version} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <WelcomeNotice />
      <WhatsNewNotice />
    </div>
  );
}

/** Version, copyright and the third-party licences; reachable on every platform from the title bar. */
function AboutDialog({ open, onOpenChange, version }: { open: boolean; onOpenChange: (o: boolean) => void; version?: string }) {
  const toast = useStore((s) => s.toast);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog about">
          <img className="about-logo" src={logoUrl} alt="" />
          <Dialog.Title asChild>
            <h2>Meshwork</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="muted">Version {version ?? '—'}</p>
          </Dialog.Description>
          <p className="about-copy">© {new Date().getFullYear()} Influx Network LLC</p>
          <p className="about-by">
            Free software, GPL-3.0 ·{' '}
            <a href="https://meshwork.influxnetwork.com" target="_blank" rel="noreferrer">
              meshwork.influxnetwork.com
            </a>
          </p>
          <p className="about-note">Meshwork is built with open-source software. Their licences and copyright notices ship with the app.</p>
          <div className="row">
            <button className="btn" onClick={() => void window.api.app.openLicense().catch((err: unknown) => toast('error', cleanError(err)))}>
              Licence
            </button>
            <button
              className="btn"
              onClick={() =>
                void window.api.app.openAcknowledgements().catch((err: unknown) => toast('error', cleanError(err)))
              }
            >
              Third-party licences
            </button>
            <Dialog.Close asChild>
              <button className="btn primary">Close</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

