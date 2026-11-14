/**
 * Utility-process entry point for network scans.
 * Receives start/cancel messages from the main process and posts ScanEvents back.
 */
import type { ScanEvent, ScanSettings } from '@shared/types';
import { runScan } from './engine';
import { VendorDb } from './analysis';
import { readArpTable, readNeighbors6, type Neighbor6 } from './probes';

type Inbound =
  | { type: 'start'; runId: string; settings: ScanSettings; vendorDbPath: string }
  | { type: 'cancel'; runId: string }
  | { type: 'arp-reply'; requestId: number; entries: [string, string][] }
  | { type: 'ndp-reply'; requestId: number; entries: Neighbor6[] };

const port = process.parentPort;
const running = new Map<string, AbortController>();
let vendors: { path: string; db: VendorDb } | undefined;

function emit(event: ScanEvent) {
  port.postMessage(event);
}

const arpRequests = new Map<number, (entries: Map<string, string>) => void>();
let nextArpRequest = 1;

/**
 * Asks the main process for the ARP table. On macOS only the app's main process holds the
 * Local Network permission that reveals MAC addresses; helper processes get an empty table.
 * Falls back to reading the table here if the main process does not answer in time.
 */
function readArpViaMain(): Promise<Map<string, string>> {
  const requestId = nextArpRequest++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      arpRequests.delete(requestId);
      void readArpTable().then(resolve);
    }, 8000);
    arpRequests.set(requestId, (entries) => {
      clearTimeout(timer);
      arpRequests.delete(requestId);
      resolve(entries);
    });
    port.postMessage({ type: 'arp-request', requestId });
  });
}

const ndpRequests = new Map<number, (entries: Neighbor6[]) => void>();

/** Asks the main process for the IPv6 neighbour table, for the same reason as the ARP table. */
function readNeighbors6ViaMain(): Promise<Neighbor6[]> {
  const requestId = nextArpRequest++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ndpRequests.delete(requestId);
      void readNeighbors6().then(resolve);
    }, 8000);
    ndpRequests.set(requestId, (entries) => {
      clearTimeout(timer);
      ndpRequests.delete(requestId);
      resolve(entries);
    });
    port.postMessage({ type: 'ndp-request', requestId });
  });
}

function vendorDb(path: string): VendorDb {
  if (!vendors || vendors.path !== path) vendors = { path, db: VendorDb.fromFile(path) };
  return vendors.db;
}

port.on('message', ({ data }: { data: Inbound }) => {
  if (data.type === 'ndp-reply') {
    ndpRequests.get(data.requestId)?.(data.entries);
    return;
  }
  if (data.type === 'arp-reply') {
    arpRequests.get(data.requestId)?.(new Map(data.entries));
    return;
  }
  if (data.type === 'cancel') {
    running.get(data.runId)?.abort();
    return;
  }
  if (data.type === 'start') {
    const controller = new AbortController();
    running.set(data.runId, controller);
    runScan({
      runId: data.runId,
      settings: data.settings,
      vendors: vendorDb(data.vendorDbPath),
      signal: controller.signal,
      emit,
      readArp: readArpViaMain,
      readNeighbors6: readNeighbors6ViaMain,
    })
      .catch((err: Error) => emit({ type: 'error', runId: data.runId, message: err.message }))
      .finally(() => running.delete(data.runId));
  }
});
