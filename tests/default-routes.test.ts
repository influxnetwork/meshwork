import { describe, expect, it } from 'vitest';
import { followDefaultRoutes } from '@shared/default-routes';
import { gear } from './topologies/scenarios';

describe('where each managed device sends traffic for other networks', () => {
  it('uses the interface the device publishes for its default route', () => {
    const r = gear('192.168.1.1', 'R1', { ports: { wan: '203.0.113.2/30', lan: '192.168.1.1/24' }, routes: true, route: { nextHop: '203.0.113.1', port: 'wan' } });
    expect(followDefaultRoutes([r]).get('192.168.1.1')).toEqual({ nextHop: '203.0.113.1', ifIndex: 1 });
  });

  it('finds the interface from the next hop when the device does not publish it', () => {
    const r = gear('10.0.99.1', 'R1', { ports: { 'Et0/0': '203.0.113.2/30', 'Et0/1': '10.0.0.130/24', 'Et0/3.99': '10.0.99.1/24' }, routes: true, route: { nextHop: '10.0.0.1' } });
    expect(followDefaultRoutes([r]).get('10.0.99.1')).toEqual({ nextHop: '10.0.0.1', ifIndex: 2 });
  });

  it('names the managed device that owns the next hop, on any of its addresses', () => {
    const hub = gear('10.1.0.1', 'HUB', { ports: { wan: '203.0.113.2/30', lan: '10.1.0.1/24', Tunnel0: '10.9.0.1/24' }, routes: true, route: { nextHop: '203.0.113.1' } });
    const spoke = gear('10.2.0.1', 'SPOKE', { ports: { lan: '10.2.0.1/24', Tunnel0: '10.9.0.2/24' }, routes: true, route: { nextHop: '10.9.0.1' } });
    const out = followDefaultRoutes([hub, spoke]);
    expect(out.get('10.2.0.1')).toEqual({ nextHop: '10.9.0.1', ifIndex: 2, via: '10.1.0.1' });
    expect(out.get('10.1.0.1')?.via).toBeUndefined();
  });

  it('has no entry for a device without a default route, or one pointing at itself or nowhere', () => {
    const none = gear('10.0.0.1', 'R1', { ports: { lan: '10.0.0.1/24' }, routes: true });
    const self = gear('10.0.1.1', 'R2', { ports: { lan: '10.0.1.1/24' }, routes: true, route: { nextHop: '10.0.1.1' } });
    const zero = gear('10.0.2.1', 'R3', { ports: { lan: '10.0.2.1/24' }, routes: true, route: { nextHop: '0.0.0.0' } });
    expect(followDefaultRoutes([none, self, zero]).size).toBe(0);
  });

  it('leaves the interface unknown when no network of the device holds the next hop', () => {
    const r = gear('10.0.0.1', 'R1', { ports: { lan: '10.0.0.1/24' }, routes: true, route: { nextHop: '10.9.9.9' } });
    expect(followDefaultRoutes([r]).get('10.0.0.1')).toEqual({ nextHop: '10.9.9.9' });
  });
});
