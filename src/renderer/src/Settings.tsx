import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Database, Download, FileText, RefreshCw, ShieldCheck } from 'lucide-react';
import type { VendorAutoCheck } from '@shared/types';
import { cleanError, useStore } from './store';
import { relativeTime } from './ui';
import { PrivacySettings, UpdateSettings } from './Updates';
import { ReportSettings } from './ReportDialog';

const AUTO_CHECK: { value: VendorAutoCheck; label: string }[] = [
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'off', label: 'Off' },
];

const TABS = [
  { id: 'updates', label: 'Updates', icon: Download, body: UpdateSettings },
  { id: 'vendors', label: 'Vendor database', icon: Database, body: VendorSettings },
  { id: 'report', label: 'Report', icon: FileText, body: ReportSettings },
  { id: 'privacy', label: 'Privacy', icon: ShieldCheck, body: PrivacySettings },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Tab shown when Settings opens again in the same session. */
let lastTab: TabId = 'updates';

/**
 * App-wide settings, opened from the app menu (macOS), File menu (Windows) or the title bar. One
 * tab per topic; arrow keys move between tabs.
 */
export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const refresh = useStore((s) => s.refreshVendors);
  const [tab, setTab] = useState<TabId>(lastTab);
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);
  const choose = (id: TabId) => {
    lastTab = id;
    setTab(id);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = TABS[(i + step + TABS.length) % TABS.length] as (typeof TABS)[number];
    choose(next.id);
    document.getElementById(`settings-tab-${next.id}`)?.focus();
  };
  const Body = (TABS.find((t) => t.id === tab) ?? TABS[0]).body;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog settings">
          <Dialog.Title asChild>
            <h2>Settings</h2>
          </Dialog.Title>
          <Dialog.Description className="muted" style={{ margin: '0 0 14px', fontSize: 12.5 }}>
            Apply to the whole app and are saved on this computer.
          </Dialog.Description>
          <div className="settings-layout">
            <div className="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings sections" onKeyDown={onKey}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  id={`settings-tab-${t.id}`}
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls="settings-panel"
                  tabIndex={tab === t.id ? 0 : -1}
                  onClick={() => choose(t.id)}
                >
                  <t.icon className="icon" /> {t.label}
                </button>
              ))}
            </div>
            <div className="settings-panel" id="settings-panel" role="tabpanel" aria-labelledby={`settings-tab-${tab}`}>
              <Body />
            </div>
          </div>
          <div className="row">
            <Dialog.Close asChild>
              <button className="btn primary">Done</button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** MAC vendor database: what is installed, a manual update and how often the app checks by itself. */
function VendorSettings() {
  const vendors = useStore((s) => s.vendors);
  const refresh = useStore((s) => s.refreshVendors);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);

  const update = async () => {
    setBusy(true);
    try {
      const res = await window.api.vendors.update();
      toast(res.updated ? 'success' : 'info', res.message);
      await refresh();
      if (res.inventoryChanged) await useStore.getState().load();
    } catch (err) {
      toast('error', cleanError(err));
    } finally {
      setBusy(false);
    }
  };

  const setAutoCheck = async (every: VendorAutoCheck) => {
    try {
      useStore.setState({ vendors: await window.api.vendors.setAutoCheck(every) });
    } catch (err) {
      toast('error', cleanError(err));
    }
  };

  return (
    <section className="settings-section" aria-labelledby="settings-vendors">
      <h3 id="settings-vendors">
        <Database className="icon muted" /> MAC vendor database
      </h3>
      <div className="opt-row">
        <div>
          <b>{vendors ? `${vendors.prefixes.toLocaleString()} manufacturers · ${vendors.version}` : 'Loading…'}</b>
          <p>
            Names device makers in Discover, Network Inventory, WiFi and Map, from the IEEE public lists.
            {vendors && (
              <>
                <br />
                {vendors.source === 'downloaded' && vendors.updatedAt ? `Updated ${relativeTime(vendors.updatedAt)}` : 'Included with the app'}
                {vendors.lastCheckAt ? ` · last checked ${relativeTime(vendors.lastCheckAt)}` : ''}
              </>
            )}
          </p>
        </div>
        <button className="btn sm" disabled={busy} onClick={() => void update()}>
          <RefreshCw className="icon" style={busy ? { animation: 'spin 1.2s linear infinite' } : undefined} />
          {busy ? 'Checking…' : 'Check now'}
        </button>
      </div>
      <div className="opt-row">
        <div>
          <b>Check for updates automatically</b>
          <p>The IEEE publishes its lists every day. Checks run in the background while the app is open.</p>
        </div>
        <span className="seg" role="group" aria-label="Check for vendor updates">
          {AUTO_CHECK.map((c) => (
            <button key={c.value} aria-pressed={vendors?.autoCheck === c.value} disabled={!vendors} onClick={() => void setAutoCheck(c.value)}>
              {c.label}
            </button>
          ))}
        </span>
      </div>
    </section>
  );
}
