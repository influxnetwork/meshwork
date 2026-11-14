import { app, type BrowserWindow } from 'electron';
import electronUpdater from 'electron-updater';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { UpdateMode, UpdateState, UpdateStatus } from '@shared/types';
import { appVersion } from './ipc';
import { isAppStoreBuild } from '../scanner/sandbox-net';

const { autoUpdater } = electronUpdater;

/** Where release files and their version manifests are published. */
export const UPDATES_URL = 'https://meshwork.influxnetwork.com/updates';

const FIRST_CHECK_MS = 20_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

interface Prefs {
  updateMode: UpdateMode;
  usageCount: boolean;
  noticeSeen: boolean;
  /** Random id of this installation; carries no information about the user or their networks. */
  installId: string;
  /** The version whose notes were last shown; absent before the first update after it was introduced. */
  seenVersion?: string;
}

let state: UpdateState = { kind: 'idle' };
let getWindow: () => BrowserWindow | undefined = () => undefined;
let started = false;

function prefsPath(): string {
  return join(app.getPath('userData'), 'app-prefs.json');
}

function readPrefs(): Prefs {
  let saved: Partial<Prefs> = {};
  try {
    saved = JSON.parse(readFileSync(prefsPath(), 'utf8')) as Partial<Prefs>;
  } catch {
    // first run, or an unreadable file: defaults below
  }
  const prefs: Prefs = {
    updateMode: saved.updateMode === 'auto' ? 'auto' : 'notify',
    usageCount: saved.usageCount !== false,
    noticeSeen: saved.noticeSeen === true,
    installId: typeof saved.installId === 'string' && /^[0-9a-f-]{36}$/.test(saved.installId) ? saved.installId : randomUUID(),
    ...(typeof saved.seenVersion === 'string' ? { seenVersion: saved.seenVersion } : {}),
  };
  if (prefs.installId !== saved.installId) writePrefs(prefs);
  return prefs;
}

function writePrefs(prefs: Prefs) {
  mkdirSync(dirname(prefsPath()), { recursive: true });
  writeFileSync(prefsPath(), JSON.stringify(prefs, null, 2));
}

function updatePrefs(patch: Partial<Prefs>): Prefs {
  const prefs = { ...readPrefs(), ...patch };
  writePrefs(prefs);
  applyPrefs(prefs);
  return prefs;
}

export function updateStatus(): UpdateStatus {
  const { updateMode, usageCount, noticeSeen, seenVersion } = readPrefs();
  const version = appVersion();
  // A first run shows the welcome notice instead; afterwards a different version means it was updated.
  const whatsNew = noticeSeen && seenVersion !== version ? { from: seenVersion, to: version } : null;
  return { mode: updateMode, usageCount, noticeSeen, whatsNew, state, appStore: isAppStoreBuild() };
}

function setState(next: UpdateState) {
  state = next;
  getWindow()?.webContents.send('updates:status', updateStatus());
}

/**
 * Download behaviour follows the chosen mode. With the usage count on, each check carries the install
 * id, version and platform as request headers; with it off, or before the first-launch notice
 * that offers the switch has been answered, the request carries none of them.
 */
function applyPrefs(prefs: Prefs) {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = prefs.updateMode === 'auto';
  autoUpdater.requestHeaders = prefs.usageCount && prefs.noticeSeen
    ? {
        'X-Meshwork-Install': prefs.installId,
        'X-Meshwork-Version': appVersion(),
        'X-Meshwork-Platform': `${process.platform}-${process.arch}`,
      }
    : null;
}

async function check(): Promise<void> {
  if (!app.isPackaged || isAppStoreBuild()) return;
  if (state.kind === 'downloading' || state.kind === 'ready') return;
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setState({ kind: 'error', message: err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err) });
  }
}

/** Starts the background checks: shortly after launch, then every few hours while the app is open. */
export function startUpdates(windowGetter: () => BrowserWindow | undefined) {
  getWindow = windowGetter;
  if (started) return;
  started = true;
  if (!app.isPackaged) {
    // While developing, MESHWORK_PREVIEW_UPDATE=<version> shows the update prompts without a server.
    const preview = process.env.MESHWORK_PREVIEW_UPDATE;
    state = preview
      ? { kind: 'available', version: preview }
      : { kind: 'unsupported', reason: 'Updates are checked in the installed app, not while developing.' };
    return;
  }
  if (isAppStoreBuild()) {
    // The Mac App Store installs updates itself; this build never downloads from our server.
    state = { kind: 'unsupported', reason: 'Updates come from the Mac App Store.' };
    return;
  }
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATES_URL });
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  applyPrefs(readPrefs());

  autoUpdater.on('checking-for-update', () => setState({ kind: 'checking' }));
  autoUpdater.on('update-not-available', () => setState({ kind: 'current', checkedAt: new Date().toISOString() }));
  autoUpdater.on('update-available', (info) => setState({ kind: 'available', version: info.version }));
  autoUpdater.on('download-progress', (p) => {
    const version = state.kind === 'available' || state.kind === 'downloading' ? state.version : '';
    setState({ kind: 'downloading', version, percent: Math.round(p.percent) });
  });
  autoUpdater.on('update-downloaded', (info) => setState({ kind: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => setState({ kind: 'error', message: (err?.message ?? String(err)).split('\n')[0] ?? '' }));

  setTimeout(() => void check(), FIRST_CHECK_MS).unref();
  setInterval(() => void check(), CHECK_EVERY_MS).unref();
}

export async function checkNow(): Promise<UpdateStatus> {
  await check();
  return updateStatus();
}

export async function downloadUpdate(): Promise<void> {
  if (state.kind !== 'available') throw new Error('There is no new version to download.');
  if (!app.isPackaged) return previewDownload(state.version);
  await autoUpdater.downloadUpdate();
}

/** Development preview of the download: progress, then ready. */
function previewDownload(version: string) {
  let percent = 0;
  const timer = setInterval(() => {
    percent += 20;
    if (percent >= 100) {
      clearInterval(timer);
      setState({ kind: 'ready', version });
    } else setState({ kind: 'downloading', version, percent });
  }, 600);
}

export function installUpdate() {
  if (state.kind !== 'ready') throw new Error('The new version has not finished downloading.');
  if (!app.isPackaged) throw new Error('Installing is only possible in the installed app.');
  // Silent: no installer screens; the app opens again on the new version.
  autoUpdater.quitAndInstall(true, true);
}

export function setUpdateMode(mode: unknown): UpdateStatus {
  if (mode !== 'auto' && mode !== 'notify') throw new Error('Unknown update mode.');
  updatePrefs({ updateMode: mode });
  // Switching to automatic picks up a version that was only announced.
  if (mode === 'auto' && state.kind === 'available') void autoUpdater.downloadUpdate().catch(() => undefined);
  return updateStatus();
}

export function setUsageCount(on: unknown): UpdateStatus {
  updatePrefs({ usageCount: on === true });
  return updateStatus();
}

export function dismissUpdateNotice(): UpdateStatus {
  updatePrefs({ noticeSeen: true, seenVersion: appVersion() });
  return updateStatus();
}

/** Marks the notes of the running version as read. */
export function dismissWhatsNew(): UpdateStatus {
  updatePrefs({ seenVersion: appVersion() });
  return updateStatus();
}
