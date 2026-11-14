import { describe, expect, it } from 'vitest';
import { compareVersions, notesSince, RELEASE_NOTES } from '../src/shared/release-notes';

const notes = [
  { version: '1.2.0', notes: ['c'] },
  { version: '1.10.0', notes: ['d'] },
  { version: '1.1.0', notes: ['b'] },
  { version: '1.0.0', notes: ['a'] },
];

describe('compareVersions', () => {
  it('compares each part as a number', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.5.7', '0.5.8')).toBeLessThan(0);
    expect(compareVersions('2.0', '2.0.0')).toBe(0);
  });
});

describe('notesSince', () => {
  it('returns every version after the previous one, newest first', () => {
    expect(notesSince('1.0.0', '1.10.0', notes).map((n) => n.version)).toEqual(['1.10.0', '1.2.0', '1.1.0']);
  });

  it('leaves out versions newer than the running one', () => {
    expect(notesSince('1.0.0', '1.2.0', notes).map((n) => n.version)).toEqual(['1.2.0', '1.1.0']);
  });

  it('returns only the running version when the previous one is unknown', () => {
    expect(notesSince(undefined, '1.2.0', notes).map((n) => n.version)).toEqual(['1.2.0']);
  });

  it('is empty when nothing changed', () => {
    expect(notesSince('1.2.0', '1.2.0', notes)).toEqual([]);
  });

  it('has notes for the version in package.json', async () => {
    const { version } = (await import('../package.json')).default as { version: string };
    expect(RELEASE_NOTES.some((n) => n.version === version)).toBe(true);
  });
});
