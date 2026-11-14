import { describe, expect, it } from 'vitest';
import { buildDiscover, parseOffer } from '../src/main/dhcp';

const mac = Buffer.from([0x02, 1, 2, 3, 4, 5]);
const xid = Buffer.from([9, 8, 7, 6]);

/** A minimal DHCPOFFER as a server would send it. */
function offer(opts: number[], tx = xid): Buffer {
  const b = Buffer.alloc(240 + opts.length);
  b[0] = 2;
  tx.copy(b, 4);
  Buffer.from([192, 168, 1, 50]).copy(b, 16);
  b.writeUInt32BE(0x63825363, 236);
  Buffer.from(opts).copy(b, 240);
  return b;
}

describe('DHCP packets', () => {
  it('builds a broadcast DISCOVER for the given MAC and transaction', () => {
    const p = buildDiscover(mac, xid);
    expect(p[0]).toBe(1);
    expect(p.subarray(4, 8)).toEqual(xid);
    expect(p.readUInt16BE(10)).toBe(0x8000);
    expect(p.subarray(28, 34)).toEqual(mac);
    expect(p.subarray(240, 243)).toEqual(Buffer.from([53, 1, 1]));
  });

  it('marks a relayed DISCOVER with the relay address and no broadcast flag', () => {
    const p = buildDiscover(mac, xid, '10.20.0.150');
    expect(p[3]).toBe(1);
    expect([...p.subarray(24, 28)]).toEqual([10, 20, 0, 150]);
    expect(p.readUInt16BE(10)).toBe(0);
  });

  it('reads server, router, DNS and lease from an OFFER', () => {
    const msg = offer([53, 1, 2, 54, 4, 192, 168, 1, 1, 3, 4, 192, 168, 1, 1, 6, 8, 8, 8, 8, 8, 1, 1, 1, 1, 51, 4, 0, 1, 81, 128, 255]);
    expect(parseOffer(msg, xid, '192.168.1.1')).toEqual({
      server: '192.168.1.1',
      from: '192.168.1.1',
      offered: '192.168.1.50',
      router: '192.168.1.1',
      dns: ['8.8.8.8', '1.1.1.1'],
      leaseSeconds: 86400,
    });
  });

  it('ignores other transactions, other message types and truncated options', () => {
    expect(parseOffer(offer([53, 1, 2, 255], Buffer.from([1, 1, 1, 1])), xid, 'x')).toBeUndefined();
    expect(parseOffer(offer([53, 1, 5, 255]), xid, 'x')).toBeUndefined();
    expect(parseOffer(offer([53, 1, 2, 54, 4, 192]), xid, '10.0.0.9')).toMatchObject({ server: '10.0.0.9' });
  });
});
