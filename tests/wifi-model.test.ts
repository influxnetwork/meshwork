import { describe, expect, it } from 'vitest';
import type { WifiNetwork } from '@shared/types';
import { ago, formatSignal, matchesSecurity, mergeScan, modeLabel, readOptions, signalPercent, DEFAULT_WIFI_OPTIONS } from '../src/renderer/src/wifi-model';

const ap = (bssid: string | undefined, rssi: number, extra: Partial<WifiNetwork> = {}): WifiNetwork => ({
  ssid: 'Lab',
  bssid,
  rssi,
  security: ['WPA2'],
  phy: ['ax', 'ac', 'n', 'a'],
  channel: { number: 36, band: '5', width: 80 },
  ...extra,
});

const MIN = 60_000;

describe('wifi scan merging', () => {
  it('keeps a missing access point until the retention runs out', () => {
    let seen = mergeScan([], [ap('aa:00:00:00:00:01', -50), ap('aa:00:00:00:00:02', -70)], 0, 5 * MIN, 10 * MIN);
    seen = mergeScan(seen, [ap('aa:00:00:00:00:01', -52)], 1 * MIN, 5 * MIN, 10 * MIN);
    expect(seen.map((n) => n.key).sort()).toEqual(['aa:00:00:00:00:01', 'aa:00:00:00:00:02']);
    const gone = seen.find((n) => n.key === 'aa:00:00:00:00:02');
    expect(gone?.lastSeen).toBe(0);
    seen = mergeScan(seen, [ap('aa:00:00:00:00:01', -52)], 6 * MIN, 5 * MIN, 10 * MIN);
    expect(seen.map((n) => n.key)).toEqual(['aa:00:00:00:00:01']);
  });

  it('lists only the last scan when retention is off', () => {
    let seen = mergeScan([], [ap('aa:00:00:00:00:01', -50), ap('aa:00:00:00:00:02', -70)], 0, 0, 10 * MIN);
    seen = mergeScan(seen, [ap('aa:00:00:00:00:01', -50)], 5000, 0, 10 * MIN);
    expect(seen).toHaveLength(1);
  });

  it('records signal samples and keeps the first sighting', () => {
    let seen = mergeScan([], [ap('aa:00:00:00:00:01', -50)], 0, MIN, 10 * MIN);
    seen = mergeScan(seen, [ap('aa:00:00:00:00:01', -60)], 5000, MIN, 10 * MIN);
    expect(seen[0]?.firstSeen).toBe(0);
    expect(seen[0]?.rssi).toBe(-60);
    expect(seen[0]?.samples.map((s) => s.rssi)).toEqual([-50, -60]);
    seen = mergeScan(seen, [ap('aa:00:00:00:00:01', -55)], 11 * MIN, MIN, 10 * MIN);
    expect(seen[0]?.samples.map((s) => s.rssi)).toEqual([-55]);
  });

  it('does not carry over networks without an address', () => {
    let seen = mergeScan([], [ap(undefined, -50)], 0, 5 * MIN, 10 * MIN);
    seen = mergeScan(seen, [], 5000, 5 * MIN, 10 * MIN);
    expect(seen).toHaveLength(0);
  });

  it('merges duplicate reports of one access point', () => {
    const seen = mergeScan([], [ap('aa:00:00:00:00:01', -50), ap('aa:00:00:00:00:01', -51)], 0, MIN, 10 * MIN);
    expect(seen).toHaveLength(1);
  });
});

describe('wifi display', () => {
  it('maps dBm onto the percent scale and clamps it', () => {
    const o = { fullDbm: -30, emptyDbm: -90 };
    expect(signalPercent(-30, o)).toBe(100);
    expect(signalPercent(-20, o)).toBe(100);
    expect(signalPercent(-60, o)).toBe(50);
    expect(signalPercent(-95, o)).toBe(0);
    expect(formatSignal(-60, { ...DEFAULT_WIFI_OPTIONS, unit: 'percent' })).toBe('50%');
    expect(formatSignal(-60, DEFAULT_WIFI_OPTIONS)).toBe('-60 dBm');
  });

  it('falls back to defaults for invalid stored options', () => {
    expect(readOptions(null)).toEqual(DEFAULT_WIFI_OPTIONS);
    expect(readOptions('not json')).toEqual(DEFAULT_WIFI_OPTIONS);
    const o = readOptions(JSON.stringify({ keepMinutes: 7, unit: 'bars', fullDbm: -90, emptyDbm: -30 }));
    expect(o).toEqual(DEFAULT_WIFI_OPTIONS);
    expect(readOptions(JSON.stringify({ unit: 'percent', fullDbm: -20, emptyDbm: -85 }))).toMatchObject({ unit: 'percent', fullDbm: -20, emptyDbm: -85 });
  });

  it('labels modes oldest first and filters by security', () => {
    expect(modeLabel(['ax', 'ac', 'n', 'a'])).toBe('a/n/ac/ax');
    expect(modeLabel([])).toBe('—');
    expect(matchesSecurity(ap('x', -50, { security: ['Open'] }), 'open')).toBe(true);
    expect(matchesSecurity(ap('x', -50, { security: ['Open'] }), 'secure')).toBe(false);
    expect(matchesSecurity(ap('x', -50), 'secure')).toBe(true);
    expect(matchesSecurity(ap('x', -50, { security: [] }), 'secure')).toBe(false);
  });

  it('describes how long ago a network was seen', () => {
    expect(ago(0, 5000)).toBe('now');
    expect(ago(0, 40_000)).toBe('40 s ago');
    expect(ago(0, 3 * MIN + 5000)).toBe('3 min ago');
  });
});
