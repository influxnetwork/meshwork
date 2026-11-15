import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DiscoveredHost, ScanEvent, ScanSummary } from '../src/shared/types';

/** Stand-in for the scanner process: records what the host posts to it and lets a test emit its events. */
class FakeChild extends EventEmitter {
  posted: { type: string; runId?: string }[] = [];
  postMessage(message: { type: string; runId?: string }) {
    this.posted.push(message);
  }
  kill() {}
}

const children: FakeChild[] = [];

vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  },
}));
vi.mock('../src/main/vendors', () => ({ vendorDbPath: () => '' }));

const { ScannerHost } = await import('../src/main/scanner-host');
const { Inventory } = await import('../src/main/inventory');

const identity = { fingerprint: 'gw:f8:d0:0e:c0:1a:aa', cidr: '192.0.2.0/24', gatewayIp: '192.0.2.1', gatewayMac: 'f8:d0:0e:c0:1a:aa', local: true };
const host = (ip: string): DiscoveredHost => ({ ip, mac: `00:11:22:33:44:${ip.split('.')[3]!.padStart(2, '0')}` }) as DiscoveredHost;
const summary = (runId: string, status: ScanSummary['status'], live: number): ScanSummary => ({
  runId,
  targets: '192.0.2.0/24',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:01:00.000Z',
  status,
  scanned: 254,
  live,
  newAssets: 0,
  openPorts: 0,
  risks: 0,
});

function setup() {
  const inventory = new Inventory(join(mkdtempSync(join(tmpdir(), 'host-')), 'inventory.db'));
  const sent: ScanEvent[] = [];
  const scanner = new ScannerHost(inventory, (event) => sent.push(event));
  const runId = scanner.start({ targets: '192.0.2.0/24' } as never);
  const child = children.at(-1)!;
  const emit = (event: ScanEvent) => child.emit('message', event);
  emit({ type: 'network-identity', runId, identity } as ScanEvent);
  const networkId = inventory.networks()[0]!.id;
  return { inventory, scanner, sent, runId, child, emit, networkId };
}

describe('scanner host', () => {
  it('saves hosts and records the run of a scan left to finish', () => {
    const { inventory, sent, runId, emit, networkId } = setup();
    emit({ type: 'host', runId, host: host('192.0.2.10') });
    emit({ type: 'done', summary: summary(runId, 'done', 1) });

    expect(inventory.list().map((a) => a.ip)).toEqual(['192.0.2.10']);
    expect(inventory.runs().map((r) => r.runId)).toEqual([runId]);
    const done = sent.find((e) => e.type === 'done') as Extract<ScanEvent, { type: 'done' }>;
    expect(done.summary).toMatchObject({ networkId, newAssets: 1 });
    expect(done.summary.discarded).toBeUndefined();
  });

  it('stops a scan whose network is deleted and drops the hosts that still arrive', () => {
    const { inventory, scanner, sent, runId, child, emit, networkId } = setup();
    emit({ type: 'host', runId, host: host('192.0.2.10') });

    inventory.removeNetwork(networkId);
    scanner.networkRemoved(networkId);
    expect(child.posted.at(-1)).toEqual({ type: 'cancel', runId });

    const before = sent.length;
    expect(() => emit({ type: 'host', runId, host: host('192.0.2.11') })).not.toThrow();
    expect(sent.length).toBe(before);
    expect(inventory.list()).toEqual([]);

    emit({ type: 'done', summary: summary(runId, 'cancelled', 2) });
    const done = sent.at(-1) as Extract<ScanEvent, { type: 'done' }>;
    expect(done.summary).toMatchObject({ runId, discarded: true, newAssets: 0 });
    expect(done.summary.networkId).toBeUndefined();
    expect(inventory.runs()).toEqual([]);
    expect(inventory.networks()).toEqual([]);
  });

  it('leaves a scan running when another network is deleted', () => {
    const { inventory, scanner, runId, child, emit } = setup();
    const other = inventory.resolveNetwork({ fingerprint: 'range:198.51.100.0/24', cidr: '198.51.100.0/24', local: false });

    inventory.removeNetwork(other.id);
    scanner.networkRemoved(other.id);
    expect(child.posted.some((m) => m.type === 'cancel')).toBe(false);

    emit({ type: 'host', runId, host: host('192.0.2.10') });
    expect(inventory.list().map((a) => a.ip)).toEqual(['192.0.2.10']);
  });

  it('stops every running scan when the inventory is cleared', () => {
    const { inventory, scanner, sent, runId, child, emit } = setup();
    emit({ type: 'host', runId, host: host('192.0.2.10') });

    inventory.clear();
    scanner.inventoryCleared();
    expect(child.posted.at(-1)).toEqual({ type: 'cancel', runId });

    expect(() => emit({ type: 'host', runId, host: host('192.0.2.11') })).not.toThrow();
    emit({ type: 'done', summary: summary(runId, 'cancelled', 2) });
    expect((sent.at(-1) as Extract<ScanEvent, { type: 'done' }>).summary.discarded).toBe(true);
    expect(inventory.list()).toEqual([]);
    expect(inventory.runs()).toEqual([]);
    expect(inventory.networks()).toEqual([]);
  });
});
