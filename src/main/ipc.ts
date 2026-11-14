/**
 * IPC handlers behind window.api. Every input from the renderer is validated here before use.
 */
import { checkNow, dismissUpdateNotice, dismissWhatsNew, downloadUpdate, installUpdate, setUpdateMode, setUsageCount, updateStatus } from './updates';
import { app, clipboard, dialog, ipcMain, safeStorage, shell, type BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppInfo, GearSnapshot, PortTraffic, ScanEvent, ScanSettings, SnmpSettings } from '@shared/types';
import { describeTargets, isIpv4, localTargets } from '../scanner/targets';
import { parsePortList } from '../scanner/ports';
import { assetsToCsv, sortByIp, type Inventory } from './inventory';
import { cancelTrace, checkDns, checkGateway, checkInternet, checkLocal, checkPorts, checkService, dnsLookup, localLink, pathMtu, pingFour, pingOnce, publicAddress, startTrace } from './diagnose';
import { isTraceTarget, parseServiceTarget, type DnsRecordType } from '@shared/diagnose';
import { findDhcpServers } from './dhcp';
import { guessServerMac, locateByLldp, locateMac, networkVlans, unknownEdgeMacs, type PortLocation } from '@shared/rogue';
import type { DhcpCheckResult, DhcpOfferResult, LocalLink } from '@shared/diagnose';
import { uniqueGear } from '@shared/gear';
import { inSubnet, subnetOf } from '../scanner/engine';
import { Semaphore, readArpTable } from '../scanner/probes';
import { ScannerHost } from './scanner-host';
import { requestLocalNetworkAccess } from './local-network';
import { setVendorAutoCheck, updateVendorDb, vendorDbPath, vendorDbStatus } from './vendors';
import { VendorDb } from '../scanner/analysis';
import { wifiAuthorize, wifiOpenLocationSettings, wifiScan } from './wifi';
import { readCounters, readNetwork } from './snmp';
import { advanceTraffic, missedTraffic, type DeviceTraffic } from './snmp-parse';
import { printPdf } from './report';

/** Most devices whose traffic counters are read at the same time. */
const TRAFFIC_READS_AT_ONCE = 16;
/** Longest the DHCP test waits for the switches when looking for the servers' ports. */
const LOCATE_TIMEOUT_MS = 30_000;

let version: string | undefined;

/** Decodes a PNG (base64) or SVG (URL-encoded) data URL produced by the map export. */
function decodeImage(dataUrl: unknown): { ext: 'png' | 'svg'; data: Buffer | string } | undefined {
  if (typeof dataUrl !== 'string' || dataUrl.length > 80 * 1024 * 1024) return undefined;
  const png = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (png) return { ext: 'png', data: Buffer.from(png[1] as string, 'base64') };
  const svg = /^data:image\/svg\+xml;charset=utf-8,(.*)$/s.exec(dataUrl);
  if (svg) return { ext: 'svg', data: decodeURIComponent(svg[1] as string) };
  return undefined;
}

/** The app's version. Unpackaged runs start from the build folder, where Electron reports its own version. */
export function appVersion(): string {
  if (version) return version;
  version = app.getVersion();
  if (!app.isPackaged) {
    try {
      const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { version?: string };
      if (pkg.version) version = pkg.version;
    } catch {
      // keep Electron's value
    }
  }
  return version;
}

/** Opens the bundled list of third-party licences in the system's text viewer. */
export async function openAcknowledgements(): Promise<void> {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'licenses', 'THIRD_PARTY_LICENSES.txt')
    : join(import.meta.dirname, '..', '..', 'resources', 'licenses', 'THIRD_PARTY_LICENSES.txt');
  const error = await shell.openPath(file);
  if (error) throw new Error(`Could not open the licences: ${error}`);
}

/** Opens the licence terms of Meshwork itself in the system's text viewer. */
export async function openLicense(): Promise<void> {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'licenses', 'LICENSE.txt')
    : join(import.meta.dirname, '..', '..', 'resources', 'licenses', 'LICENSE.txt');
  const error = await shell.openPath(file);
  if (error) throw new Error(`Could not open the licence: ${error}`);
}

function assertIp(ip: unknown): string {
  if (typeof ip !== 'string' || !isIpv4(ip)) throw new Error('Invalid IPv4 address');
  return ip;
}

function assertSshUser(user: unknown): string {
  if (typeof user !== 'string' || !/^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/.test(user)) throw new Error('Invalid SSH user name');
  return user;
}

function validateSettings(input: unknown): ScanSettings {
  const s = input as Partial<ScanSettings>;
  if (!s || typeof s.targets !== 'string' || s.targets.length > 10_000) throw new Error('Invalid targets');
  if (!['top', 'all', 'custom', 'none'].includes(String(s.portProfile))) throw new Error('Invalid port profile');
  if (!['cautious', 'balanced', 'aggressive'].includes(String(s.timing))) throw new Error('Invalid timing');
  const customPorts = typeof s.customPorts === 'string' ? s.customPorts : '';
  if (s.portProfile === 'custom') parsePortList(customPorts);
  const parsed = describeTargets(s.targets);
  if (parsed.errors.length) throw new Error(parsed.errors[0]);
  if (!parsed.count) throw new Error('Add at least one IP address, range or CIDR block.');
  if (parsed.tooLarge) throw new Error('That range is too large for one scan.');
  return {
    targets: s.targets,
    portProfile: s.portProfile as ScanSettings['portProfile'],
    customPorts,
    timing: s.timing as ScanSettings['timing'],
    resolveNames: s.resolveNames !== false,
  };
}

function systemRoot(): string {
  return process.env.SystemRoot ?? 'C:\\Windows';
}

/** Starts a program that outlives this call. Resolves once it has started, rejects if it cannot be started. */
function launchDetached(cmd: string, args: string[], verbatim = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      shell: false,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: verbatim,
    });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', () => reject(new Error(`Could not start ${cmd.split(/[\\/]/).pop()}.`)));
  });
}


export function registerIpc(getWindow: () => BrowserWindow | undefined, inventory: Inventory): ScannerHost {
  const send = (event: ScanEvent) => getWindow()?.webContents.send('scan:event', event);
  const scanner = new ScannerHost(inventory, send);

  ipcMain.handle('app:info', async (): Promise<AppInfo> => {
    // Without GPU compositing (remote desktop sessions, many virtual machines) every effect is drawn by the
    // CPU. The status is read once the GPU process has reported, and only an explicit "disabled" or
    // "unavailable" counts, so a normal computer never loses its effects by mistake.
    await app.getGPUInfo('basic').catch(() => undefined);
    const compositing = String((app.getGPUFeatureStatus() as unknown as Record<string, string>).gpu_compositing ?? '');
    return { platform: process.platform, version: appVersion(), lowGraphics: /^(disabled|unavailable)/.test(compositing) };
  });
  ipcMain.handle('app:openAcknowledgements', () => openAcknowledgements());
  ipcMain.handle('app:openLicense', () => openLicense());

  ipcMain.handle('updates:status', () => updateStatus());
  ipcMain.handle('updates:check', () => checkNow());
  ipcMain.handle('updates:download', () => downloadUpdate());
  ipcMain.handle('updates:install', () => installUpdate());
  ipcMain.handle('updates:setMode', (_e, mode: unknown) => setUpdateMode(mode));
  ipcMain.handle('updates:setUsageCount', (_e, on: unknown) => setUsageCount(on));
  ipcMain.handle('updates:dismissNotice', () => dismissUpdateNotice());
  ipcMain.handle('updates:dismissWhatsNew', () => dismissWhatsNew());
  ipcMain.handle('app:openLocalNetworkSettings', async () => {
    if (process.platform !== 'darwin') return;
    // Registers the app with macOS first so it is listed on the settings page.
    await requestLocalNetworkAccess();
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork');
  });

  ipcMain.handle('app:copyText', (_e, text: unknown) => {
    if (typeof text !== 'string' || text.length > 10_000) throw new Error('Nothing to copy');
    clipboard.writeText(text);
  });

  ipcMain.handle('scan:localTargets', () => localTargets());
  ipcMain.handle('scan:parseTargets', (_e, text: unknown) => describeTargets(String(text ?? '').slice(0, 10_000)));
  ipcMain.handle('scan:start', async (_e, settings: unknown) => {
    const valid = validateSettings(settings);
    await requestLocalNetworkAccess();
    return { runId: scanner.start(valid) };
  });
  ipcMain.handle('scan:cancel', (_e, runId: unknown) => scanner.cancel(String(runId)));

  ipcMain.handle('inventory:list', () => inventory.list());
  ipcMain.handle('inventory:remove', (_e, id: unknown) => inventory.remove(String(id)));
  ipcMain.handle('inventory:clear', () => inventory.clear());
  ipcMain.handle('inventory:runs', () => inventory.runs());
  ipcMain.handle('inventory:networks', () => inventory.networks());
  ipcMain.handle('inventory:renameNetwork', (_e, id: unknown, name: unknown) => {
    const clean = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (!clean || clean.length > 80) throw new Error('Network names must be 1 to 80 characters.');
    return inventory.renameNetwork(String(id), clean);
  });
  ipcMain.handle('inventory:removeNetwork', (_e, id: unknown) => inventory.removeNetwork(String(id)));
  ipcMain.handle('inventory:removeRun', (_e, id: unknown) => inventory.removeRun(String(id)));
  ipcMain.handle('inventory:exportCsv', async (_e, ids: unknown) => {
    // Ids arrive in the order shown on screen; a full export with no ids is ordered by IP.
    const selected = Array.isArray(ids) && ids.length ? inventory.get(ids.map(String)) : sortByIp(inventory.list());
    const win = getWindow();
    const options = {
      title: 'Export devices',
      defaultPath: `devices-${new Date().toISOString().slice(0, 10)}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return null;
    const names = Object.fromEntries(inventory.networks().map((n) => [n.id, n.name]));
    writeFileSync(filePath, '﻿' + assetsToCsv(selected, names));
    return filePath;
  });

  ipcMain.handle('wifi:scan', () => wifiScan());
  ipcMain.handle('wifi:authorize', () => wifiAuthorize());
  ipcMain.handle('wifi:openLocationSettings', () => wifiOpenLocationSettings());

  // ---- SNMP: communities are encrypted with the OS key store and never sent to the renderer.
  const snmpSettings = (networkId: string): SnmpSettings => {
    const stored = inventory.snmpSecret(networkId);
    return stored ? { configured: true, version: 'v2c', updatedAt: stored.updatedAt } : { configured: false };
  };
  const community = (networkId: string): string => {
    const stored = inventory.snmpSecret(networkId);
    if (!stored) throw new Error('Set up SNMP for this network first.');
    return safeStorage.decryptString(Buffer.from(stored.secret, 'base64'));
  };
  /** Traffic state per network, then per device address, to turn the next counter reading into rates. */
  const counters = new Map<string, Map<string, DeviceTraffic>>();

  ipcMain.handle('snmp:settings', (_e, networkId: unknown) => snmpSettings(String(networkId)));
  ipcMain.handle('snmp:save', (_e, networkId: unknown, value: unknown) => {
    const id = String(networkId);
    const secret = typeof value === 'string' ? value.trim() : '';
    if (!secret || secret.length > 64 || !/^[\x21-\x7e]+$/.test(secret)) {
      throw new Error('The community must be 1 to 64 visible characters without spaces.');
    }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('The system key store is not available to protect the community.');
    inventory.setSnmpSecret(id, 'v2c', safeStorage.encryptString(secret).toString('base64'));
    return snmpSettings(id);
  });
  ipcMain.handle('snmp:clear', (_e, networkId: unknown) => {
    inventory.clearSnmpSecret(String(networkId));
    return snmpSettings(String(networkId));
  });
  ipcMain.handle('snmp:snapshot', (_e, networkId: unknown) => inventory.gearSnapshot(String(networkId)));
  /**
   * Reads a network's managed devices, stores the reading and fills MAC addresses into the
   * inventory. `only` limits the reading to those addresses (the gear found last time).
   */
  const readSnmp = async (id: string, only?: string[]): Promise<GearSnapshot> => {
    const secret = community(id);
    const network = inventory.networks().find((n) => n.id === id);
    const ips = new Set(only ?? inventory.list().filter((a) => a.networkId === id).map((a) => a.ip));
    if (!only && network?.gatewayIp) ips.add(network.gatewayIp);
    const devices = uniqueGear(await readNetwork([...ips], secret));
    // Learned addresses carry their manufacturer, so devices missing from the inventory still have a name.
    const vendors = VendorDb.fromFile(vendorDbPath());
    for (const d of devices) {
      for (const f of d.fdb) {
        const v = vendors.lookup(f.mac);
        if (v) f.vendor = v;
      }
    }
    // Routers and switches know the MAC address behind each IP (their ARP tables), which a scan of a
    // remote network cannot see: fill those into the inventory, with the vendor.
    const arp = new Map<string, string>();
    for (const d of devices) for (const e of d.arp) if (!arp.has(e.ip)) arp.set(e.ip, e.mac);
    const macsFilled = inventory.fillMacs(
      id,
      [...arp].map(([ip, mac]) => ({ ip, mac, vendor: vendors.lookup(mac) })),
    );
    const snapshot: GearSnapshot = { networkId: id, collectedAt: new Date().toISOString(), probed: ips.size, devices, macsFilled };
    if (only) {
      // A partial reading keeps the stored entries of devices that did not answer this time, and an
      // empty one keeps the stored reading whole: the map still needs it.
      const answered = new Set(devices.map((d) => d.ip));
      const kept = inventory.gearSnapshot(id)?.devices.filter((d) => !answered.has(d.ip)) ?? [];
      if (devices.length) inventory.saveGearSnapshot({ ...snapshot, devices: uniqueGear([...devices, ...kept]), probed: answered.size + kept.length });
    } else {
      inventory.saveGearSnapshot(snapshot);
    }
    counters.delete(id);
    return snapshot;
  };
  ipcMain.handle('snmp:read', (_e, networkId: unknown): Promise<GearSnapshot> => readSnmp(String(networkId)));
  ipcMain.handle('snmp:traffic', async (_e, networkId: unknown): Promise<PortTraffic[]> => {
    const id = String(networkId);
    const snapshot = inventory.gearSnapshot(id);
    if (!snapshot?.devices.length) return [];
    const secret = community(id);
    const before = counters.get(id) ?? new Map<string, DeviceTraffic>();
    const states = new Map<string, DeviceTraffic>();
    // Devices are read side by side, a few at a time; each reading carries its own time, so slow
    // answers do not skew rates.
    const slots = new Semaphore(TRAFFIC_READS_AT_ONCE);
    await Promise.all(
      snapshot.devices.map((d) =>
        slots.run(async () => {
          const prev = before.get(d.ip);
          try {
            const values = await readCounters(d.ip, secret, d.interfaces.filter((i) => i.up).map((i) => i.ifIndex));
            states.set(d.ip, advanceTraffic(prev, { at: Date.now(), values }));
          } catch {
            // A device that missed this sample shows no traffic until it answers again.
            const missed = missedTraffic(prev);
            if (missed) states.set(d.ip, missed);
          }
        }),
      ),
    );
    counters.set(id, states);
    const out: PortTraffic[] = [];
    for (const [ip, state] of states) for (const [ifIndex, r] of state.rates) out.push({ ip, ifIndex, ...r });
    return out;
  });

  ipcMain.handle('map:saveImage', async (_e, dataUrl: unknown, suggestedName: unknown) => {
    const image = decodeImage(dataUrl);
    if (!image) throw new Error('The map image could not be read.');
    const name = typeof suggestedName === 'string' && /^[\w.-]{1,120}$/.test(suggestedName) ? suggestedName : `network-map.${image.ext}`;
    const win = getWindow();
    const options = {
      title: 'Export map',
      defaultPath: name.endsWith(`.${image.ext}`) ? name : `${name}.${image.ext}`,
      filters: [{ name: image.ext.toUpperCase(), extensions: [image.ext] }],
    };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return null;
    writeFileSync(filePath, image.data);
    return filePath;
  });

  ipcMain.handle('report:pdf', async (_e, html: unknown, suggestedName: unknown, mode: unknown) => {
    if (typeof html !== 'string' || !html.startsWith('<!doctype html>') || html.length > 120_000_000) throw new Error('The report could not be made.');
    const base = typeof suggestedName === 'string' && /^[\w.-]{1,120}$/.test(suggestedName) ? suggestedName.replace(/\.pdf$/i, '') : 'site-visit-report';
    const pdf = await printPdf(html);
    if (mode === 'preview') {
      // A preview opens in the system's PDF viewer from a temporary file.
      const path = join(app.getPath('temp'), `${base}-preview-${Date.now()}.pdf`);
      writeFileSync(path, pdf);
      const err = await shell.openPath(path);
      if (err) throw new Error(err);
      return path;
    }
    const win = getWindow();
    const options = { title: 'Save report', defaultPath: `${base}.pdf`, filters: [{ name: 'PDF', extensions: ['pdf'] }] };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return null;
    writeFileSync(filePath, pdf);
    return filePath;
  });
  ipcMain.handle('report:show', (_e, path: unknown) => {
    if (typeof path === 'string' && path.toLowerCase().endsWith('.pdf')) shell.showItemInFolder(path);
  });
  ipcMain.handle('map:saveCsv', async (_e, csv: unknown, suggestedName: unknown) => {
    if (typeof csv !== 'string' || csv.length > 20_000_000) throw new Error('The list could not be exported.');
    const base = typeof suggestedName === 'string' && /^[\w.-]{1,120}$/.test(suggestedName) ? suggestedName : 'connections';
    const win = getWindow();
    const options = {
      title: 'Export connections',
      defaultPath: base.endsWith('.csv') ? base : `${base}.csv`,
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    };
    const { canceled, filePath } = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (canceled || !filePath) return null;
    // A byte-order mark lets spreadsheets open the file as UTF-8.
    writeFileSync(filePath, '\ufeff' + csv);
    return filePath;
  });

  ipcMain.handle('vendors:status', () => vendorDbStatus());
  ipcMain.handle('vendors:setAutoCheck', (_e, every: unknown) => setVendorAutoCheck(every));
  ipcMain.handle('vendors:update', async () => {
    const result = await updateVendorDb();
    if (!result.updated) return result;
    // Devices that were "Unknown" may now have a vendor.
    const db = VendorDb.fromFile(vendorDbPath());
    const named = inventory.fillVendors((mac) => db.lookup(mac));
    return named ? { ...result, message: `${result.message} ${named} devices in the inventory now show their vendor.`, inventoryChanged: true } : result;
  });

  ipcMain.handle('actions:ssh', async (_e, ip: unknown, user: unknown) => {
    const target = `${assertSshUser(user)}@${assertIp(ip)}`;
    if (process.platform !== 'win32') return shell.openExternal(`ssh://${target}`);
    // Windows has no ssh:// handler: open the built-in OpenSSH client in Windows Terminal, or in a console window.
    try {
      await launchDetached('wt.exe', ['new-tab', '--title', target, 'ssh', target]);
    } catch {
      // `target` is validated to letters, digits, dots, dashes, underscores and one @, so it is safe verbatim.
      await launchDetached(join(systemRoot(), 'System32', 'cmd.exe'), ['/c', `start "SSH" ssh ${target}`], true);
    }
  });
  ipcMain.handle('actions:web', (_e, ip: unknown, secure: unknown) =>
    shell.openExternal(`${secure ? 'https' : 'http'}://${assertIp(ip)}/`),
  );
  ipcMain.handle('actions:remoteDesktop', (_e, ip: unknown) =>
    process.platform === 'win32'
      ? // Windows has no rdp:// handler; the Remote Desktop client takes the host directly.
        launchDetached(join(systemRoot(), 'System32', 'mstsc.exe'), [`/v:${assertIp(ip)}`])
      : shell.openExternal(`rdp://full%20address=s:${assertIp(ip)}`),
  );
  ipcMain.handle('actions:ping', (_e, ip: unknown) => pingFour(assertIp(ip)));

  ipcMain.handle('diagnose:local', async () => {
    const link = await localLink();
    return { link, step: checkLocal(link) };
  });
  ipcMain.handle('diagnose:gateway', (_e, ip: unknown) => checkGateway(assertIp(ip)));
  ipcMain.handle('diagnose:dns', (_e, servers: unknown) => {
    const list = Array.isArray(servers) ? servers.filter((x): x is string => typeof x === 'string' && /^[0-9a-fA-F.:]{2,45}$/.test(x)).slice(0, 3) : [];
    return checkDns(list);
  });
  ipcMain.handle('diagnose:internet', () => checkInternet());
  ipcMain.handle('diagnose:publicAddress', () => publicAddress());
  ipcMain.handle('diagnose:service', (_e, text: unknown) => {
    const target = typeof text === 'string' ? parseServiceTarget(text) : undefined;
    if (!target) throw new Error('Enter a host name, an IP address, host:port or a web address.');
    return checkService(target);
  });
  ipcMain.handle('diagnose:trace', (_e, id: unknown, target: unknown) => {
    const t = typeof target === 'string' ? target.trim() : '';
    if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) throw new Error('Invalid trace id');
    if (!isTraceTarget(t)) throw new Error('Enter an IPv4 address or a host name.');
    startTrace(id, t, (event) => getWindow()?.webContents.send('diagnose:traceEvent', event));
  });
  ipcMain.handle('diagnose:pingOnce', (_e, target: unknown) => {
    const t = typeof target === 'string' ? target.trim() : '';
    if (!isTraceTarget(t)) throw new Error('Enter an IPv4 address or a host name.');
    return pingOnce(t);
  });
  ipcMain.handle('diagnose:ports', (_e, host: unknown, ports: unknown) => {
    const h = typeof host === 'string' ? host.trim() : '';
    if (!isTraceTarget(h)) throw new Error('Enter an IPv4 address or a host name.');
    if (typeof ports !== 'string' || ports.length > 2000) throw new Error('Enter ports such as 22, 80, 443 or 5060-5070.');
    return checkPorts(h, ports);
  });
  ipcMain.handle('diagnose:dnsLookup', (_e, name: unknown, type: unknown) => {
    const n = typeof name === 'string' ? name.trim().replace(/\.$/, '') : '';
    if (!isTraceTarget(n)) throw new Error('Enter a host name or an IPv4 address.');
    const t = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'PTR'].includes(String(type)) ? (type as DnsRecordType) : 'A';
    return dnsLookup(n, t);
  });
  ipcMain.handle('diagnose:mtu', (_e, target: unknown) => {
    const t = typeof target === 'string' ? target.trim() : '';
    if (!isTraceTarget(t)) throw new Error('Enter an IPv4 address or a host name.');
    return pathMtu(t);
  });
  ipcMain.handle('diagnose:dhcp', async () => {
    const link = await localLink();
    const result = await findDhcpServers(link.address);
    const db = VendorDb.fromFile(vendorDbPath());
    const subnet = link.address && link.prefix !== undefined ? subnetOf(link.address, link.prefix) : undefined;
    const offers: DhcpOfferResult[] = result.offers.map((o) => ({
      ...o,
      vendor: o.mac ? db.lookup(o.mac) : undefined,
      otherSubnet: subnet ? !inSubnet(o.server, subnet) : undefined,
    }));
    // More than one server: look for each one on the managed switches, when SNMP is set up.
    let locate: DhcpCheckResult['locate'];
    if (offers.length > 1) {
      locate = await locateServers(offers, link).catch((err: unknown) => ({ status: 'failed' as const, error: err instanceof Error ? err.message : String(err) }));
    }
    return { ...result, offers, locate };
  });

  /** Finds which switch port each offering server is on, from a fresh reading of the network's managed switches. */
  const locateServers = async (offers: DhcpOfferResult[], link: LocalLink): Promise<NonNullable<DhcpCheckResult['locate']>> => {
    // The inventory network this computer is on; one with SNMP set up wins when several match.
    const here = inventory
      .networks()
      .filter((n) => (link.gateway && n.gatewayIp === link.gateway) || (link.address && inSubnet(link.address, n.cidr)));
    if (!here.length) return { status: 'no-scan' };
    const network = here.find((n) => inventory.snmpSecret(n.id));
    if (!network) return { status: 'no-snmp', networkId: here[0]?.id };
    const stored = inventory.gearSnapshot(network.id);
    // An empty earlier reading says nothing about which addresses are new.
    const before = stored?.devices.length ? stored : undefined;
    const known = before?.devices.map((d) => d.ip);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the switches took too long to answer')), LOCATE_TIMEOUT_MS);
    });
    const now = await Promise.race([readSnmp(network.id, known?.length ? known : undefined), timeout]).finally(() => clearTimeout(timer));
    if (!now.devices.length) return { status: 'no-answer', networkId: network.id };
    // Routers and firewalls with built-in ports often answer without saying which device is on which port.
    if (!now.devices.some((d) => d.fdb.length || d.neighbors.length)) return { status: 'no-table', networkId: network.id, gear: now.devices.map((d) => d.sysName ?? d.ip) };

    const all = inventory.list();
    const assets = all.filter((a) => a.networkId === network.id);
    const knownMacs = new Set<string>(assets.flatMap((a) => (a.mac ? [a.mac] : [])));
    if (link.mac) knownMacs.add(link.mac);
    // Switches and routers know the MAC behind addresses they talk to; so does this computer.
    const arp = new Map<string, string>();
    for (const d of now.devices) for (const e of d.arp) if (!arp.has(e.ip)) arp.set(e.ip, e.mac);
    const localArp = await readArpTable().catch(() => new Map<string, string>());
    const macFor = (ip: string) => arp.get(ip) ?? localArp.get(ip);
    // The gateway: the network's, else this computer's.
    const gatewayIp = network.gatewayIp ?? link.gateway;
    const gatewayMac = network.gatewayMac ?? (gatewayIp ? macFor(gatewayIp) ?? offers.find((o) => o.server === gatewayIp)?.mac : undefined);
    if (gatewayMac) knownMacs.add(gatewayMac);
    const isGateway = (o: DhcpOfferResult) => o.server === gatewayIp || (!!gatewayMac && o.mac?.toLowerCase() === gatewayMac.toLowerCase());

    const learnedNow = new Set(now.devices.flatMap((d) => d.fdb.map((f) => f.mac.toLowerCase())));
    const vendors = VendorDb.fromFile(vendorDbPath());
    const recorded = new Map<DhcpOfferResult, string>();
    const announced = new Map<DhcpOfferResult, { where: PortLocation; nodeId: string }>();
    for (const o of offers) {
      o.mac ??= macFor(o.server);
      // A server that announced itself over LLDP to a switch port needs no guessing.
      const lldp = isGateway(o) ? undefined : locateByLldp(now.devices, o.server, o.mac);
      if (lldp) {
        o.mac ??= lldp.mac;
        announced.set(o, { where: lldp.where, nodeId: lldp.nodeId });
      }
      if (!o.mac) {
        // An earlier scan of the server's own network may have its MAC; trusted only if the switches see it now.
        const mac = all.find((a) => a.ip === o.server && a.mac && learnedNow.has(a.mac.toLowerCase()))?.mac;
        if (mac) recorded.set(o, mac);
      }
      const mac = o.mac ?? recorded.get(o);
      if (mac && !o.vendor) o.vendor = vendors.lookup(mac);
      if (mac) knownMacs.add(mac);
    }
    const unknown = unknownEdgeMacs(now.devices, knownMacs, before?.devices, gatewayMac);
    const members = assets.flatMap((a) => (a.mac ? [a.mac] : []));
    const hints = { vlans: networkVlans(now.devices, link.mac, gatewayMac, members), before: before?.devices };
    // The guess fits only one server: with several unknown servers there is no telling them apart.
    const unseen = offers.filter((o) => !o.mac && !recorded.has(o) && !announced.has(o) && !isGateway(o)).length;
    for (const o of offers) {
      if (isGateway(o)) continue;
      const lldp = announced.get(o);
      if (lldp) {
        o.location = { networkId: network.id, mac: o.mac, confidence: 'announced', where: lldp.where, nodeId: lldp.nodeId };
        continue;
      }
      const found = o.mac ?? recorded.get(o);
      if (found) {
        o.location = {
          networkId: network.id,
          mac: found,
          confidence: o.mac ? 'exact' : 'recorded',
          where: locateMac(now.devices, found, gatewayMac, hints),
        };
        continue;
      }
      const mac = unseen === 1 ? guessServerMac(unknown) : undefined;
      if (mac && !o.vendor) o.vendor = vendors.lookup(mac);
      o.location = mac
        ? { networkId: network.id, mac, confidence: 'likely', where: locateMac(now.devices, mac, gatewayMac, hints) }
        : { networkId: network.id, unknownCount: unknown.fresh.length + unknown.rest.length };
    }
    return { status: 'done', networkId: network.id, switches: now.devices.length, macsFilled: now.macsFilled };
  };
  ipcMain.handle('diagnose:cancelTrace', (_e, id: unknown) => cancelTrace(String(id)));

  return scanner;
}
