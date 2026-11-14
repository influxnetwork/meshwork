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
        const network = this.inventory.resolveNetwork(event.identity);
        this.runNetwork.set(event.runId, network.id);
        this.send({ type: 'network', runId: event.runId, network });
        return;
      }
      case 'host': {
        const networkId = this.runNetwork.get(event.runId) ?? this.fallbackNetwork(event.runId);
        const asset = this.inventory.upsert(event.host, event.runId, networkId);
        this.send({ type: 'asset', asset });
        return;
      }
      case 'done': {
        const summary = {
          ...event.summary,
          networkId: this.runNetwork.get(event.summary.runId),
          newAssets: this.inventory.countNew(event.summary.runId),
        };
        this.runNetwork.delete(summary.runId);
        // A scan that found nothing on a network with no devices does not leave an empty network behind.
        if (summary.networkId && summary.live === 0 && this.inventory.removeNetworkIfEmpty(summary.networkId)) {
          this.send({ type: 'network-removed', networkId: summary.networkId });
          summary.networkId = undefined;
        }
        this.inventory.recordRun(summary);
        this.active.delete(summary.runId);
        this.send({ type: 'done', summary });
        return;
      }
      case 'error':
        this.active.delete(event.runId);
        this.runNetwork.delete(event.runId);
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
    this.ensureChild().postMessage({ type: 'start', runId, settings, vendorDbPath: vendorDbPath() });
    return runId;
  }

  cancel(runId: string) {
    this.child?.postMessage({ type: 'cancel', runId });
  }

  dispose() {
    this.child?.kill();
  }
}
