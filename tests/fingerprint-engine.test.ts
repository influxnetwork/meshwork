import { describe, expect, it } from 'vitest';
import { compileRules, evaluate } from '../src/shared/fingerprint/engine';
import type { Facts, RuleSet } from '../src/shared/fingerprint/types';

const facts = (partial: Partial<Facts> = {}): Facts => ({ ports: new Set(), names: [], gateway: false, virtualMac: false, ...partial });
const run = (set: RuleSet, f: Partial<Facts> = {}) => evaluate(compileRules(set), facts(f));

describe('fingerprint engine', () => {
  it('picks the most confident type, and keeps the first one on a tie', () => {
    const set: RuleSet = {
      version: 't-1',
      rules: [
        { id: 'a', when: { port: [80] }, type: { is: 'switch', confidence: 0.6, why: 'a' } },
        { id: 'b', when: { port: [80] }, type: { is: 'router', confidence: 0.8, why: 'b' } },
        { id: 'c', when: { port: [80] }, type: { is: 'ap', confidence: 0.8, why: 'c' } },
      ],
    };
    const v = run(set, { ports: new Set([80]) });
    expect(v.type).toBe('router');
    expect(v.typeConfidence).toBe(0.8);
    expect(v.why).toEqual(['b']);
  });

  it('fires only the first matching rule of a group', () => {
    const set: RuleSet = {
      version: 't-1',
      rules: [
        { id: 'x1', group: 'x', when: { port: [9100] }, type: { is: 'printer', confidence: 0.5, why: 'first' } },
        { id: 'x2', group: 'x', when: { port: [9100] }, type: { is: 'printer', confidence: 0.9, why: 'second' } },
      ],
    };
    const v = run(set, { ports: new Set([9100]) });
    expect(v.matched).toEqual(['x1']);
    expect(v.typeConfidence).toBe(0.5);
  });

  it('combines all, any and not, and matches ports, TTL ranges, flags and patterns', () => {
    const set: RuleSet = {
      version: 't-1',
      patterns: { maker: 'acme|globex' },
      rules: [
        {
          id: 'combo',
          when: {
            all: [
              { vendor: '@maker' },
              { any: [{ port: [22] }, { name: 'core' }] },
              { not: { gateway: true } },
              { ttl: { min: 65, max: 128 } },
              { virtualMac: false },
              { text: 'firmware 2' },
            ],
          },
          type: { is: 'server', confidence: 0.7, why: 'combo' },
        },
      ],
    };
    const ok = { vendor: 'ACME Corp', names: ['SW-CORE-1'], ttl: 128, text: 'Firmware 2.1' };
    expect(run(set, ok).type).toBe('server');
    expect(run(set, { ...ok, ttl: 64 }).type).toBe('unknown');
    expect(run(set, { ...ok, gateway: true }).type).toBe('unknown');
    expect(run(set, { ...ok, names: [] }).type).toBe('unknown');
    expect(run(set, { ...ok, names: [], ports: new Set([22]) }).type).toBe('server');
    expect(run(set, { ...ok, vendor: undefined }).type).toBe('unknown');
    expect(run(set, { ...ok, ttl: undefined }).type).toBe('unknown');
  });

  it('lets a rule depend on what earlier rules decided', () => {
    const set: RuleSet = {
      version: 't-1',
      rules: [
        { id: 'web', when: { port: [80] }, type: { is: 'server', confidence: 0.5, why: 'web' } },
        { id: 'fallback', when: { typeIs: 'unknown' }, type: { is: 'computer', confidence: 0.9, why: 'fallback' } },
        { id: 'os', when: { all: [{ typeIs: 'server' }, { osKnown: false }] }, os: { is: 'Linux', confidence: 0.5, why: 'os' } },
        { id: 'os-again', when: { osKnown: false }, os: { is: 'Windows', confidence: 0.9, why: 'never' } },
      ],
    };
    const v = run(set, { ports: new Set([80]) });
    expect(v.type).toBe('server');
    expect(v.os).toBe('Linux');
    expect(v.matched).toEqual(['web', 'os']);
    expect(run(set).type).toBe('computer');
  });

  it('explains only the winning type and OS, without repeats, and fills in the TTL', () => {
    const set: RuleSet = {
      version: 't-1',
      rules: [
        { id: 'p', when: { port: [9100] }, type: { is: 'printer', confidence: 0.9, why: 'printing' } },
        { id: 'p2', when: { port: [9100] }, type: { is: 'printer', confidence: 0.7, why: 'printing' } },
        { id: 'c', when: { port: [9100] }, type: { is: 'camera', confidence: 0.5, why: 'camera' } },
        { id: 't', when: { ttl: { min: 1 } }, os: { is: 'Linux', confidence: 0.3, why: 'TTL {ttl}' } },
      ],
    };
    const v = run(set, { ports: new Set([9100]), ttl: 64 });
    expect(v.why).toEqual(['printing', 'TTL 64']);
    expect(v.version).toBe('t-1');
  });

  it('reports Unknown when the best guess is under the rule set threshold', () => {
    const set: RuleSet = {
      version: 't-1',
      threshold: 0.5,
      rules: [{ id: 'weak', when: { port: [80] }, type: { is: 'iot', confidence: 0.3, why: 'weak' } }],
    };
    const v = run(set, { ports: new Set([80]) });
    expect(v.type).toBe('unknown');
    expect(v.typeConfidence).toBe(0);
    expect(v.why).toEqual([]);
  });

  it('refuses a rule set with an unknown pattern name, a broken pattern or a repeated id, naming the rule', () => {
    const missing: RuleSet = { version: 't-1', rules: [{ id: 'r1', when: { vendor: '@nope' }, type: { is: 'iot', confidence: 0.5, why: 'x' } }] };
    expect(() => compileRules(missing)).toThrow(/r1/);
    const broken: RuleSet = { version: 't-1', rules: [{ id: 'r2', when: { name: '(' }, type: { is: 'iot', confidence: 0.5, why: 'x' } }] };
    expect(() => compileRules(broken)).toThrow(/r2/);
    const twice: RuleSet = {
      version: 't-1',
      rules: [
        { id: 'r3', when: { port: [1] }, type: { is: 'iot', confidence: 0.5, why: 'x' } },
        { id: 'r3', when: { port: [2] }, type: { is: 'iot', confidence: 0.5, why: 'x' } },
      ],
    };
    expect(() => compileRules(twice)).toThrow(/r3/);
  });

  it('treats only the rule set\'s own entries as pattern names', () => {
    const set: RuleSet = { version: 't-1', rules: [{ id: 'proto', when: { vendor: '@constructor' }, type: { is: 'iot', confidence: 0.5, why: 'x' } }] };
    expect(() => compileRules(set)).toThrow(/proto/);
  });

  it('honours an exclusive lower TTL bound', () => {
    const set: RuleSet = { version: 't-1', rules: [{ id: 'w', when: { ttl: { gt: 64, max: 128 } }, os: { is: 'Windows', confidence: 0.9, why: 'x' } }] };
    expect(run(set, { ttl: 64 }).os).toBeUndefined();
    expect(run(set, { ttl: 64.5 }).os).toBe('Windows');
    expect(run(set, { ttl: 128 }).os).toBe('Windows');
  });

  it('keeps the OS when the type falls under the threshold', () => {
    const set: RuleSet = {
      version: 't-1',
      threshold: 0.5,
      rules: [{ id: 'weak', when: { port: [22] }, type: { is: 'server', confidence: 0.3, why: 'weak' }, os: { is: 'Linux', confidence: 0.4, why: 'ssh' } }],
    };
    const v = run(set, { ports: new Set([22]) });
    expect(v.type).toBe('unknown');
    expect(v.os).toBe('Linux');
    expect(v.why).toEqual(['ssh']);
  });

  it('rejects malformed rule data, naming the rule', () => {
    const rule = (extra: object) => ({ version: 't-1', rules: [{ id: 'bad', when: { port: [80] }, type: { is: 'iot', confidence: 0.5, why: 'x' }, ...extra }] });
    const bad: [string, unknown][] = [
      ['no rules', { version: 't-1' }],
      ['no version', { rules: [] }],
      ['threshold over 1', { version: 't-1', threshold: 2, rules: [] }],
      ['unknown type', rule({ type: { is: 'rotuer', confidence: 0.5, why: 'x' } })],
      ['confidence over 1', rule({ type: { is: 'iot', confidence: 1.5, why: 'x' } })],
      ['confidence not a number', rule({ type: { is: 'iot', confidence: '0.5', why: 'x' } })],
      ['no conclusion', rule({ type: undefined })],
      ['two keys in a condition', rule({ when: { port: [80], gateway: true } })],
      ['empty all', rule({ when: { all: [] } })],
      ['ports as text', rule({ when: { port: ['80'] } })],
      ['port out of range', rule({ when: { port: [70000] } })],
      ['empty ttl', rule({ when: { ttl: {} } })],
      ['ttl with an unknown bound', rule({ when: { ttl: { above: 3 } } })],
      ['null condition', rule({ when: null })],
      ['unknown condition', rule({ when: { colour: 'red' } })],
      ['unknown typeIs', rule({ when: { typeIs: 'spaceship' } })],
      ['group not text', rule({ group: 3 })],
      ['pattern too long', rule({ when: { name: 'a'.repeat(1001) } })],
    ];
    for (const [label, data] of bad) expect(() => compileRules(data), label).toThrow();
    expect(() => compileRules(rule({ type: { is: 'rotuer', confidence: 0.5, why: 'x' } }))).toThrow(/bad/);
    let deep: unknown = { port: [80] };
    for (let i = 0; i < 20; i++) deep = { not: deep };
    expect(() => compileRules(rule({ when: deep }))).toThrow(/deep/);
  });
});
