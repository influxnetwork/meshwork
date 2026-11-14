import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDownToLine, RefreshCw, RotateCw, ShieldCheck } from 'lucide-react';
import { create } from 'zustand';
import type { UpdateMode, UpdateStatus } from '@shared/types';
import { notesSince } from '@shared/release-notes';
import { cleanError, useStore } from './store';
import { relativeTime } from './ui';
import logoUrl from './assets/logo.png';

interface UpdatesStore {
  status?: UpdateStatus;
  set: (status: UpdateStatus) => void;
}

/** The latest update status pushed by the main process. */
export const useUpdates = create<UpdatesStore>((set) => ({ set: (status) => set({ status }) }));

/** Loads the update status once and keeps it current; mount once near the app root. */
export function useUpdateFeed() {
  const set = useUpdates((s) => s.set);
  useEffect(() => {
    void window.api.updates.status().then(set);
    return window.api.updates.onStatus(set);
  }, [set]);
}

async function run(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (err) {
    useStore.getState().toast('error', cleanError(err));
  }
}

/** Title-bar chip that appears only while a new version is on offer, downloading or ready. */
export function UpdateChip() {
  const state = useUpdates((s) => s.status?.state);
  if (state?.kind === 'available') {
    return (
      <button className="chip update" onClick={() => void run(() => window.api.updates.download())} title="Download the new version">
        <ArrowDownToLine className="icon" /> Update to v{state.version}
      </button>
    );
  }
  if (state?.kind === 'downloading') {
    return (
      <span className="chip update" role="status">
        <RefreshCw className="icon spin" /> Downloading {state.percent}%
      </span>
    );
  }
  if (state?.kind === 'ready') {
    return (
      <button className="chip update ready" onClick={() => void run(() => window.api.updates.install())} title={`Restart Meshwork to start v${state.version}`}>
        <RotateCw className="icon" /> Restart to update
      </button>
    );
  }
  return null;
}

const MODES: { value: UpdateMode; label: string }[] = [
  { value: 'notify', label: 'Ask first' },
  { value: 'auto', label: 'Automatic' },
];

/** Settings section: the current version, a manual check and how new versions are installed. */
export function UpdateSettings() {
  const status = useUpdates((s) => s.status);
  const set = useUpdates((s) => s.set);
  const version = useStore((s) => s.info?.version);
  const state = status?.state;
  const checking = state?.kind === 'checking';

  const line =
    state?.kind === 'unsupported'
      ? state.reason
      : state?.kind === 'checking'
        ? 'Checking…'
        : state?.kind === 'current'
          ? `Up to date · checked ${relativeTime(state.checkedAt)}`
          : state?.kind === 'available'
            ? `Version ${state.version} is available`
            : state?.kind === 'downloading'
              ? `Downloading version ${state.version} · ${state.percent}%`
              : state?.kind === 'ready'
                ? `Version ${state.version} is ready; it installs when Meshwork restarts`
                : state?.kind === 'error'
                  ? `Could not check: ${state.message}`
                  : 'Checks run shortly after launch and every few hours.';

  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h3 id="settings-updates">
        <RefreshCw className="icon muted" /> Updates
      </h3>
      <div className="opt-row">
        <div>
          <b>Meshwork {version ? `v${version}` : ''}</b>
          <p>{line}</p>
        </div>
        {status?.appStore ? null : state?.kind === 'ready' ? (
          <button className="btn sm primary" onClick={() => void run(() => window.api.updates.install())}>
            <RotateCw className="icon" /> Restart now
          </button>
        ) : state?.kind === 'available' ? (
          <button className="btn sm primary" onClick={() => void run(() => window.api.updates.download())}>
            <ArrowDownToLine className="icon" /> Download
          </button>
        ) : (
          <button
            className="btn sm"
            disabled={checking || state?.kind === 'unsupported' || state?.kind === 'downloading'}
            onClick={() => void run(async () => set(await window.api.updates.check()))}
          >
            <RefreshCw className="icon" style={checking ? { animation: 'spin 1.2s linear infinite' } : undefined} />
            {checking ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>
      {!status?.appStore && (
        <div className="opt-row">
          <div>
            <b>Install new versions</b>
            <p>Automatic downloads in the background and installs when you quit. Ask first shows a button in the title bar.</p>
          </div>
          <span className="seg" role="group" aria-label="Install new versions">
            {MODES.map((m) => (
              <button
                key={m.value}
                aria-pressed={status?.mode === m.value}
                disabled={!status}
                onClick={() => void run(async () => set(await window.api.updates.setMode(m.value)))}
              >
                {m.label}
              </button>
            ))}
          </span>
        </div>
      )}
    </section>
  );
}

/** Settings section: the anonymous usage count sent with update checks. */
export function PrivacySettings() {
  const status = useUpdates((s) => s.status);
  const set = useUpdates((s) => s.set);
  return (
    <section className="settings-section" aria-labelledby="settings-privacy">
      <h3 id="settings-privacy">
        <ShieldCheck className="icon muted" /> Privacy
      </h3>
      {status?.appStore ? (
        <div className="opt-row">
          <div>
            <b>Nothing is sent</b>
            <p>Meshwork sends no usage data. Nothing about the networks you scan ever leaves this computer.</p>
          </div>
        </div>
      ) : (
        <label className="opt-row check-row">
          <div>
            <b>Send an anonymous usage count</b>
            <p>
              With each update check: a random installation id, the app version and the platform (system and processor type). Nothing about the
              networks you scan ever leaves this computer.
            </p>
          </div>
          <input
            type="checkbox"
            className="switch"
            checked={status?.usageCount ?? false}
            disabled={!status}
            onChange={(e) => void run(async () => set(await window.api.updates.setUsageCount(e.target.checked)))}
          />
        </label>
      )}
    </section>
  );
}

/** Shown once on first launch: the licence, update checks and the usage count, with its switch. */
export function WelcomeNotice() {
  const status = useUpdates((s) => s.status);
  const set = useUpdates((s) => s.set);
  const [usage, setUsage] = useState(true);
  const open = !!status && !status.noticeSeen;

  const done = () =>
    void run(async () => {
      if (!usage) await window.api.updates.setUsageCount(false);
      set(await window.api.updates.dismissNotice());
    });

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && done()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog welcome">
          <img className="about-logo" src={logoUrl} alt="" />
          <Dialog.Title asChild>
            <h2>Welcome to Meshwork</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="muted">Discover, inventory and map your networks. Free software, by Influx Network.</p>
          </Dialog.Description>
          <ul className="welcome-points">
            <li>Everything you scan stays on this computer.</li>
            {!status?.appStore && <li>Meshwork checks for new versions and lets you know when one is ready.</li>}
          </ul>
          {!status?.appStore && (
            <label className="welcome-check">
              <input type="checkbox" checked={usage} onChange={(e) => setUsage(e.target.checked)} />
              <span>Send an anonymous usage count with update checks: a random id, the app version and the platform (system and processor type).</span>
            </label>
          )}
          <p className="welcome-legal">
            Meshwork is free software under the{' '}
            <button className="link" onClick={() => void run(() => window.api.app.openLicense())}>
              GNU General Public License v3
            </button>
            .{status?.appStore ? '' : ' You can change these choices any time in Settings.'}
          </p>
          <div className="row">
            <button className="btn primary" onClick={done}>
              Continue
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Shown once after an update: what changed since the version that ran before. */
export function WhatsNewNotice() {
  const status = useUpdates((s) => s.status);
  const set = useUpdates((s) => s.set);
  const range = status?.noticeSeen ? status.whatsNew : null;
  const notes = range ? notesSince(range.from, range.to) : [];
  const open = notes.length > 0;

  const done = () => void run(async () => set(await window.api.updates.dismissWhatsNew()));

  // An update without notes (or a downgrade) is marked as read without interrupting.
  useEffect(() => {
    if (range && !open) done();
  }, [range?.from, range?.to, open]);

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && done()}>
      <Dialog.Portal>
        <Dialog.Overlay className="scrim" />
        <Dialog.Content className="dialog welcome">
          <img className="about-logo" src={logoUrl} alt="" />
          <Dialog.Title asChild>
            <h2>Meshwork was updated to v{range?.to}</h2>
          </Dialog.Title>
          <Dialog.Description asChild>
            <p className="muted">Here is what changed{range?.from ? ` since v${range.from}` : ''}.</p>
          </Dialog.Description>
          {/* Notes for several versions can be long: they scroll, with the title and button kept in view. */}
          <div className="welcome-notes">
            {notes.map((n) => (
              <section key={n.version} className="whats-new">
                {notes.length > 1 && <h3>v{n.version}</h3>}
                <ul className="welcome-points">
                  {n.notes.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="row">
            <button className="btn primary" onClick={done}>
              Got it
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
