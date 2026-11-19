import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** How a simulated agent behaves once it has answered the probe. */
type Kind =
  | 'bulk' // answers everything
  | 'single' // answers single requests, never bulk ones
  | 'single-old' // like `single`, and ends each table with a "no such name" error
  | 'single-fades' // like `single`, until it has given its first table: then nothing
  | 'single-cycle' // like `single`, but after the last row of a table it gives the first one again
  | 'silent' // answers nothing more
  | 'hiccup' // misses its first bulk request, then answers everything
  | 'refuses' // answers everything, two tables in a row with an error instead of rows
  | 'mute' // answers everything, except two tables in a row it gives no answer for at all
  | 'slow'; // answers everything, each table after a delay

const agents = new Map<string, Kind>();
const calls = new Map<string, { bulk: number; next: number; tables: Set<string> }>();
const SLOW_MS = 300;

/** The table every simulated agent that answers holds: two interface names. */
const IF_NAME = '1.3.6.1.2.1.31.1.1.1.1';
/** Two tables read one after the other, and the neighbour table read after both. */
const REFUSED = ['1.3.6.1.2.1.4.20.1.2', '1.3.6.1.2.1.4.20.1.3'];
const LLDP_REM = '1.0.8802.1.1.2.1.4.1.1';
const rowsOf = (oid: string) => (oid === IF_NAME ? [{ oid: `${oid}.1`, value: 'Gi1' }, { oid: `${oid}.2`, value: 'Gi2' }] : []);
const lastArc = (oid: string) => Number(oid.split('.').at(-1));

class RequestTimedOutError extends Error {}
class RequestFailedError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
const ErrorStatus = { NoSuchName: 2, GeneralError: 5 };

vi.mock('net-snmp', () => ({
  default: {
    Version2c: 1,
    ErrorStatus,
    RequestTimedOutError,
    RequestFailedError,
    isVarbindError: (vb: { error?: boolean }) => !!vb.error,
    createSession: (ip: string, _community: string, options: { timeout: number; retries: number }) => {
      const kind = agents.get(ip) as Kind;
      const count = calls.get(ip) ?? calls.set(ip, { bulk: 0, next: 0, tables: new Set() }).get(ip)!;
      // A request nobody answers ends after every try has timed out.
      const unanswered = (done: (error: Error) => void) => setTimeout(() => done(new RequestTimedOutError('Request timed out')), options.timeout * (options.retries + 1));
      let missed = false;
      let faded = false;
      return {
        on: () => undefined,
        close: () => undefined,
        get: (oids: string[], done: (error: Error | null, varbinds: unknown[]) => void) => {
          // A device that has stopped answering gives no answer to a plain request either.
          if ((kind === 'silent' && missed) || faded) {
            unanswered((error) => done(error, []));
            return;
          }
          setTimeout(() => done(null, oids.map((oid) => (oid === '1.3.6.1.2.1.1.5.0' ? { oid, value: `name-${ip}` } : { oid, error: true }))), 1);
        },
        subtree: (oid: string, _repetitions: number, feed: (varbinds: unknown[]) => void, done: (error?: Error) => void) => {
          count.bulk++;
          count.tables.add(oid);
          if (kind.startsWith('single') || kind === 'silent' || (kind === 'hiccup' && !missed)) {
            missed = true;
            unanswered(done);
            return;
          }
          if (kind === 'mute' && REFUSED.includes(oid)) {
            unanswered(done);
            return;
          }
          if (kind === 'refuses' && REFUSED.includes(oid)) {
            setTimeout(() => done(new RequestFailedError('General error', ErrorStatus.GeneralError)), 1);
            return;
          }
          setTimeout(() => {
            if (rowsOf(oid).length) feed(rowsOf(oid));
            done();
          }, kind === 'slow' ? SLOW_MS : 1);
        },
        getNext: ([from]: string[], done: (error: Error | null, varbinds: unknown[]) => void) => {
          count.next++;
          if (kind === 'silent' || faded) {
            unanswered((error) => done(error, []));
            return;
          }
          // The row after `from` in the table the agent holds.
          const rows = rowsOf(IF_NAME);
          const next = from?.startsWith(IF_NAME) ? rows.find((r) => from === IF_NAME || lastArc(r.oid) > lastArc(from)) : undefined;
          const atEnd = !next && !!from?.startsWith(`${IF_NAME}.`);
          if (atEnd && kind === 'single-fades') faded = true;
          setTimeout(() => {
            if (next) return done(null, [next]);
            if (atEnd && kind === 'single-cycle') return done(null, [rows[0]]);
            if (kind === 'single-old') return done(new RequestFailedError('No such name', ErrorStatus.NoSuchName), []);
            // Past the last row: a row outside every table read.
            done(null, [{ oid: '1.3.6.1.9.9.9', value: 0 }]);
          }, 1);
        },
      };
    },
  },
}));

const { readGear, readNetwork } = await import('../src/main/snmp');

/** Runs a read on the simulated clock and tells how long it took there. */
async function timed<T>(read: () => Promise<T>): Promise<{ result: T; seconds: number }> {
  const started = Date.now();
  const pending = read();
  await vi.runAllTimersAsync();
  return { result: await pending, seconds: (Date.now() - started) / 1000 };
}

beforeEach(() => {
  vi.useFakeTimers();
  agents.clear();
  calls.clear();
});
afterEach(() => vi.useRealTimers());

describe('reading devices that answer SNMP badly', () => {
  it('reads one row at a time from a device that answers single requests but not bulk ones', async () => {
    agents.set('192.0.2.10', 'single');
    const { result, seconds } = await timed(() => readGear('192.0.2.10', 'public'));
    expect(result.sysName).toBe('name-192.0.2.10');
    expect(result.interfaces.map((i) => i.name)).toEqual(['Gi1', 'Gi2']);
    // Only the first table was asked for in bulk, twice; the rest of the read lost no time waiting.
    expect(calls.get('192.0.2.10')?.bulk).toBe(2);
    expect(seconds).toBeLessThan(20);
  });

  it('takes a "no such name" error as the end of a table when reading one row at a time', async () => {
    agents.set('192.0.2.13', 'single-old');
    const { result, seconds } = await timed(() => readGear('192.0.2.13', 'public'));
    expect(result.interfaces.map((i) => i.name)).toEqual(['Gi1', 'Gi2']);
    expect(calls.get('192.0.2.13')?.bulk).toBe(2);
    expect(seconds).toBeLessThan(20);
  });

  it('leaves a device that stops answering after two tables instead of waiting for every table', async () => {
    agents.set('192.0.2.11', 'silent');
    const { result, seconds } = await timed(() => readGear('192.0.2.11', 'public'));
    expect(result.sysName).toBe('name-192.0.2.11');
    expect(result.interfaces).toEqual([]);
    expect(calls.get('192.0.2.11')?.bulk).toBeLessThanOrEqual(4);
    expect(seconds).toBeLessThan(45);
  });

  it('leaves a device read one row at a time that stops answering, after two tables', async () => {
    agents.set('192.0.2.14', 'single-fades');
    const { result, seconds } = await timed(() => readGear('192.0.2.14', 'public'));
    expect(result.interfaces.map((i) => i.name)).toEqual(['Gi1', 'Gi2']);
    expect(seconds).toBeLessThan(60);
  });

  it('stops a table whose rows come back around instead of asking for them again and again', async () => {
    agents.set('192.0.2.15', 'single-cycle');
    const { result } = await timed(() => readGear('192.0.2.15', 'public'));
    expect(result.interfaces.map((i) => i.name)).toEqual(['Gi1', 'Gi2']);
    expect(calls.get('192.0.2.15')?.next).toBeLessThan(200);
  });

  it('keeps reading in bulk a device that missed one request', async () => {
    agents.set('192.0.2.12', 'hiccup');
    const { result } = await timed(() => readGear('192.0.2.12', 'public'));
    expect(result.interfaces.map((i) => i.name)).toEqual(['Gi1', 'Gi2']);
    expect(calls.get('192.0.2.12')?.bulk).toBeGreaterThan(20);
  });

  it('keeps reading a device that answers two tables in a row with an error', async () => {
    agents.set('192.0.2.16', 'refuses');
    await timed(() => readGear('192.0.2.16', 'public'));
    const asked = calls.get('192.0.2.16')?.tables ?? new Set();
    expect(REFUSED.every((oid) => asked.has(oid))).toBe(true);
    expect(asked.has(LLDP_REM)).toBe(true);
  });

  it('goes on reading a device that gives no answer for two tables in a row but still answers a plain request', async () => {
    agents.set('192.0.2.17', 'mute');
    const { result, seconds } = await timed(() => readGear('192.0.2.17', 'public'));
    const asked = calls.get('192.0.2.17')?.tables ?? new Set();
    expect(result.interfaces.map((i) => i.name)).toEqual(['Gi1', 'Gi2']);
    expect(asked.has(LLDP_REM)).toBe(true);
    expect(seconds).toBeLessThan(60);
  });

  it('reads several devices at once, so a slow one does not hold back the others', async () => {
    const ips = ['192.0.2.21', '192.0.2.22', '192.0.2.23', '192.0.2.24'];
    for (const ip of ips) agents.set(ip, 'slow');
    const one = await timed(() => readGear(ips[0] as string, 'public'));
    const all = await timed(() => readNetwork(ips, 'public'));
    expect(all.result.map((d) => d.ip).sort()).toEqual(ips);
    expect(all.seconds).toBeLessThan(one.seconds * 2);
  });

  it('gives the devices in the order they were asked for, whatever order they answered in', async () => {
    const ips = ['192.0.2.33', '192.0.2.31', '192.0.2.32'];
    agents.set('192.0.2.31', 'slow').set('192.0.2.32', 'bulk').set('192.0.2.33', 'single');
    const { result } = await timed(() => readNetwork(ips, 'public'));
    expect(result.map((d) => d.ip)).toEqual(ips);
  });
});
