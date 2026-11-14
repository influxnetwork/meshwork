/** Evidence collected by the identify phase, as the engine sees it. */
import { describe, expect, it } from 'vitest';
import { compileRules, evaluate } from '../src/shared/fingerprint/engine';
import { hostFacts } from '../src/shared/fingerprint';
import { OBSERVED_FIELDS, type Facts, type RuleSet } from '../src/shared/fingerprint/types';
import type { DiscoveredHost } from '../src/shared/types';

const facts = (observed: Facts['observed']): Facts => ({ ports: new Set(), names: [], gateway: false, virtualMac: false, observed });
const set = (field: string, pattern: string): RuleSet => ({
  version: 't-1',
  rules: [{ id: 'm', when: { match: { field, pattern } } as never, type: { is: 'camera', confidence: 0.9, why: 'x' } }],
});

describe('observed evidence in rules', () => {
  it('matches a pattern against any value of the named field, ignoring case', () => {
    const rules = compileRules(set('http.title', 'routeros'));
    expect(evaluate(rules, facts({ 'http.title': ['Login', 'RouterOS router configuration page'] })).type).toBe('camera');
    expect(evaluate(rules, facts({ 'http.title': ['Login'] })).type).toBe('unknown');
    expect(evaluate(rules, facts({ 'http.server': ['RouterOS'] })).type).toBe('unknown');
    expect(evaluate(rules, facts(undefined)).type).toBe('unknown');
  });

  it('works for every observed field', () => {
    for (const field of OBSERVED_FIELDS) {
      const rules = compileRules(set(field, '^hit$'));
      expect(evaluate(rules, facts({ [field]: ['hit'] })).type, field).toBe('camera');
    }
  });

  it('refuses unknown fields, missing patterns and extra keys, naming the rule', () => {
    expect(() => compileRules(set('http.cookie', 'x'))).toThrow(/m/);
    expect(() => compileRules(set('http.title', ''))).toThrow(/m/);
    const extra = { version: 't-1', rules: [{ id: 'e', when: { match: { field: 'ssh', pattern: 'x', flags: 'g' } }, type: { is: 'iot', confidence: 0.5, why: 'x' } }] };
    expect(() => compileRules(extra)).toThrow(/e/);
  });

  it('passes the evidence stored on a device to the rules', () => {
    const host: DiscoveredHost = {
      ip: '192.0.2.5',
      names: [],
      aliveVia: ['icmp'],
      ports: [],
      type: 'unknown',
      typeConfidence: 0,
      evidence: [],
      risks: [],
      observed: { services: ['_ipp._tcp'], ssh: ['SSH-2.0-dropbear_2022.83'] },
    };
    expect(hostFacts(host).observed).toEqual({ services: ['_ipp._tcp'], ssh: ['SSH-2.0-dropbear_2022.83'] });
  });
});
