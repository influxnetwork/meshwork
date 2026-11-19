/**
 * Owns the scanner utility process: starts scans, persists discovered hosts to the
 * inventory and forwards events to the renderer.
 */
import { utilityProcess, type UtilityProcess } from 'electron';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ScanEvent, ScanSettings } from '@shared/types';
import type { Inventory } from './inventory';
import { vendorDbPath } from './vendors';
import { readArpTable, readNeighbors6 } from '../scanner/probes';

type WorkerMessage = ScanEvent | { type: 'arp-request'; requestId: number } | { type: 'ndp-request'; requestId: number };

export class ScannerHost {
  private child?: UtilityProcess;
  private active = new Set<string>();
  /** Inventory network of each running scan, set by the scanner's network-identity event. */
  private runNetwork = new Map<string, string>();
  /** Runs whose devices go into a chosen network: run id → network id. */
  private runInto = new Map<string, string>();
  /** Ranges of each scan run into a chosen network, remembered for the network when the scan finishes. */
  private runRanges = new Map<string, string>();
  /** Runs whose results are thrown away because their network, or the whole inventory, was deleted mid-scan. */
  private discarded = new Set<string>();

  constructor(
    private readonly inventory: Inventory,
    private readonly send: (event: ScanEvent) => void,
  ) {}

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(join(import.meta.dirname, 'scanner.js'), [], {
      serviceName: 'Network scanner',
      // System name lookups run on libuv's thread pool; the default of 4 serialises a whole subnet.
      env: { ...process.env, UV_THREADPOOL_SIZE: '32' },
    });
    child.on('message', (message: WorkerMessage) => {
      if (message.type === 'arp-request') {
        void this.replyArp(child, message.requestId);
        return;
      }
      if (message.type === 'ndp-request') {
        void readNeighbors6()
          .catch(() => [])
          .then((entries) => child.postMessage({ type: 'ndp-reply', requestId: message.requestId, entries }));
        return;
      }
      this.handle(message);
    });
    child.on('exit', () => {
      for (const runId of this.active) this.send({ type: 'error', runId, message: 'The scanner stopped unexpectedly.' });
      this.active.clear();
      this.runNetwork.clear();
      this.runInto.clear();
      this.runRanges.clear();
      this.discarded.clear();
      this.child = undefined;
    });
    this.child = child;
    return child;
  }

  /** Reads the ARP table here, in the process that holds the Local Network permission. */
  private async replyArp(child: UtilityProcess, requestId: number) {
    let entries: [string, string][] = [];
    try {
      entries = [...(await readArpTable())];
    } catch {
      // an empty table only means no MAC addresses for this scan
    }
    child.postMessage({ type: 'arp-reply', requestId, entries });
  }

  private handle(event: ScanEvent) {
    switch (event.type) {
      case 'network-identity': {
        if (this.discarded.has(event.runId)) return;
        // A scan run into a network adds its ranges to it instead of being matched by them.
        const into = this.runInto.get(event.runId);
        this.runInto.delete(event.runId);
        if (into) this.runRanges.set(event.runId, event.identity.cidr);
        const network = (into ? this.inventory.extendNetwork(into, event.identity.cidr) : undefined) ?? this.inventory.resolveNetwork(event.identity);
        this.runNetwork.set(event.runId, network.id);
        this.send({ type: 'network', runId: event.runId, network });
        return;
      }
      case 'host': {
        // Hosts still arriving from a discarded run have no network to be saved to.
        if (this.discarded.has(event.runId)) return;
        const networkId = this.runNetwork.get(event.runId) ?? this.fallbackNetwork(event.runId);
        const asset = this.inventory.upsert(event.host, event.runId, networkId);
        this.send({ type: 'asset', asset });
        return;
      }
      case 'done': {
        if (this.discarded.delete(event.summary.runId)) {
          // Nothing of a discarded run is kept: no devices, no network and no history entry.
          const runId = event.summary.runId;
          this.runNetwork.delete(runId);
          this.runInto.delete(runId);
          this.runRanges.delete(runId);
          this.active.delete(runId);
          this.send({ type: 'done', summary: { ...event.summary, networkId: undefined, newAssets: 0, discarded: true } });
          return;
        }
        const summary = {
          ...event.summary,
          networkId: this.runNetwork.get(event.summary.runId),
          newAssets: this.inventory.countNew(event.summary.runId),
        };
        this.runNetwork.delete(summary.runId);
        this.runInto.delete(summary.runId);
        // A scan that found nothing on a network with no devices does not leave an empty network behind.
        if (summary.networkId && summary.live === 0 && this.inventory.removeNetworkIfEmpty(summary.networkId)) {
          this.send({ type: 'network-removed', networkId: summary.networkId });
          summary.networkId = undefined;
        }
        // A scan run into a network that reached its end covered its ranges, whoever answered: the
        // network remembers them. One that was cancelled did not cover them.
        const ranges = this.runRanges.get(summary.runId);
        this.runRanges.delete(summary.runId);
        const covered = ranges && summary.networkId && summary.status === 'done' ? this.inventory.rememberScanned(summary.networkId, ranges) : undefined;
        if (covered) this.send({ type: 'network', runId: summary.runId, network: covered });
        this.inventory.recordRun(summary);
        this.active.delete(summary.runId);
        this.send({ type: 'done', summary });
        return;
      }
      case 'error':
        this.discarded.delete(event.runId);
        this.active.delete(event.runId);
        this.runNetwork.delete(event.runId);
        this.runInto.delete(event.runId);
        this.runRanges.delete(event.runId);
        this.send(event);
        return;
      default:
        this.send(event);
    }
  }

  /** Network for hosts that arrive without an identity event (not expected; keeps data from being lost). */
  private fallbackNetwork(runId: string): string {
    const network = this.inventory.resolveNetwork({ fingerprint: 'range:Unsorted', cidr: 'Unsorted', local: false });
    this.runNetwork.set(runId, network.id);
    this.send({ type: 'network', runId, network });
    return network.id;
  }

  start(settings: ScanSettings): string {
    const runId = randomUUID();
    this.active.add(runId);
    if (settings.intoNetwork) this.runInto.set(runId, settings.intoNetwork);
    this.ensureChild().postMessage({ type: 'start', runId, settings, vendorDbPath: vendorDbPath() });
    return runId;
  }

  cancel(runId: string) {
    this.child?.postMessage({ type: 'cancel', runId });
  }

  /**
   * Called after a network was deleted from the inventory. Scans running on that network are
   * stopped and their remaining results dropped, since there is no network left to save them to.
   */
  networkRemoved(networkId: string) {
    for (const [runId, id] of this.runNetwork) if (id === networkId) this.discard(runId);
  }

  /** Called after the whole inventory was cleared: every running scan is stopped and its results dropped. */
  inventoryCleared() {
    for (const runId of [...this.active]) this.discard(runId);
  }

  private discard(runId: string) {
    if (!this.active.has(runId)) return;
    this.discarded.add(runId);
    this.runNetwork.delete(runId);
    this.runInto.delete(runId);
    this.runRanges.delete(runId);
    this.cancel(runId);
  }

  dispose() {
    this.child?.kill();
  }
}
