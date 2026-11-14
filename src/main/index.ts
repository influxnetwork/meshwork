import { app, BrowserWindow, Menu, nativeTheme, shell, type MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';
import { Inventory } from './inventory';
import { appVersion, openAcknowledgements, openLicense, registerIpc } from './ipc';
import { scheduleVendorDbCheck, vendorDbPath } from './vendors';
import { startUpdates } from './updates';
import { VendorDb } from '../scanner/analysis';
import type { ScannerHost } from './scanner-host';

let window: BrowserWindow | undefined;
let inventory: Inventory | undefined;
let scanner: ScannerHost | undefined;

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 16, y: 15 },
    titleBarOverlay: process.platform === 'win32' ? { color: '#00000000', symbolColor: '#b4bac4', height: 44 } : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0b0d10' : '#f4f5f7',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => window?.show());
  window.on('closed', () => (window = undefined));

  // Links never open inside the app window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window?.webContents.getURL()) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
}

function sendCommand(command: string) {
  window?.webContents.send('menu:command', command);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template: MenuItemConstructorOptions[] = [
    // macOS keeps Settings in the app menu, under About; Windows and Linux keep it in File.
    ...(isMac
      ? [
          {
            label: app.getName(),
            submenu: [
              { role: 'about' as const },
              { label: 'Check for Updates…', click: () => sendCommand('updates.check') },
              { type: 'separator' as const },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => sendCommand('settings.open') },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Scan', accelerator: 'CmdOrCtrl+N', click: () => sendCommand('scan.new') },
        { label: 'Export Devices…', accelerator: 'CmdOrCtrl+E', click: () => sendCommand('inventory.export') },
        { type: 'separator' },
        ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => sendCommand('settings.open') }, { type: 'separator' as const }]),
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Discover', accelerator: 'CmdOrCtrl+1', click: () => sendCommand('view.discover') },
        { label: 'Network Inventory', accelerator: 'CmdOrCtrl+2', click: () => sendCommand('view.inventory') },
        { label: 'Map', accelerator: 'CmdOrCtrl+3', click: () => sendCommand('view.map') },
        { label: 'Diagnose', accelerator: 'CmdOrCtrl+4', click: () => sendCommand('view.diagnose') },
        { label: 'WiFi', accelerator: 'CmdOrCtrl+5', click: () => sendCommand('view.wifi') },
        { type: 'separator' },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendCommand('theme.toggle') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' as const }]),
      ],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Licence Agreement', click: () => void openLicense().catch((err: unknown) => console.error(err)) },
        { label: 'Acknowledgements', click: () => void openAcknowledgements().catch((err: unknown) => console.error(err)) },
        ...(isMac ? [] : [{ type: 'separator' as const }, { label: 'Check for Updates…', click: () => sendCommand('updates.check') }, { role: 'about' as const }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: appVersion(),
    copyright: `© ${new Date().getFullYear()} Influx Network LLC. Free software under the GNU GPL v3.`,
  });
  inventory = new Inventory(join(app.getPath('userData'), 'inventory.db'));
  scanner = registerIpc(() => window, inventory);
  buildMenu();
  createWindow();
  startUpdates(() => window);
  scheduleVendorDbCheck(() => {
    // A newer vendor list can name devices that were "Unknown".
    const db = VendorDb.fromFile(vendorDbPath());
    if (inventory?.fillVendors((mac) => db.lookup(mac))) window?.webContents.send('menu:command', 'inventory.reload');
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  scanner?.dispose();
  inventory?.close();
});
