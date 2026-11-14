/**
 * Mac App Store builds run inside the App Sandbox, which blocks the system traceroute and hides
 * the ARP table from the system `arp` tool. Those builds bundle native/macos/net:
 * - `meshwork-net`, a helper that traces from inside the app and prints `traceroute -n -I` text;
 * - `meshwork-arp.node`, a module that reads the ARP table inside the calling process and returns
 *   `arp -an` text. macOS shows hardware addresses only to a process that holds the
 *   topology-observation entitlement itself, so it must run in the app's main process.
 * Both print the same text as the system tools, so the existing parsers read them unchanged.
 */
import { join } from 'node:path';

/** True in a Mac App Store build. Electron sets `process.mas` there. */
export function isAppStoreBuild(): boolean {
  return process.platform === 'darwin' && (process as NodeJS.Process & { mas?: boolean }).mas === true;
}

/** Path of the bundled traceroute helper in a Mac App Store build; undefined in every other build. */
export function sandboxNetHelper(): string | undefined {
  return isAppStoreBuild() ? join(process.resourcesPath, 'bin', 'meshwork-net') : undefined;
}

interface ArpModule {
  arpTable(): string;
}

let arpModule: ArpModule | undefined;

/** Loads the neighbour-table module from `path`. */
export function loadArpModule(path: string): ArpModule {
  const module = { exports: {} as ArpModule };
  process.dlopen(module, path);
  return module.exports;
}

/**
 * The ARP table as `arp -an` text, read in this process, in a Mac App Store build; undefined in
 * every other build. Throws when the module cannot be loaded or the table cannot be read.
 */
export function sandboxArpText(): string | undefined {
  if (!isAppStoreBuild()) return undefined;
  arpModule ??= loadArpModule(join(process.resourcesPath, 'bin', 'meshwork-arp.node'));
  return arpModule.arpTable();
}
