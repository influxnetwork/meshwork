import { DEVICE_TYPES, type DeviceType } from '../types';
import { OBSERVED_FIELDS, type Condition, type Conclusion, type Facts, type Rule, type RuleSet, type Verdict } from './types';

/** What the rules before the current one decided. */
interface State {
  type: DeviceType;
  os?: string;
}

type Test = (facts: Facts, state: State) => boolean;

interface CompiledRule {
  id: string;
  group?: string;
  test: Test;
  type?: Conclusion<DeviceType>;
  os?: Conclusion<string>;
}

/** A rule set checked and turned into functions, ready to evaluate many devices. */
export interface CompiledRuleSet {
  version: string;
  threshold: number;
  rules: CompiledRule[];
}

/** Longest regular expression accepted in a rule set. */
const MAX_PATTERN = 1000;
/** Deepest nesting of conditions accepted in a rule set. */
const MAX_DEPTH = 16;

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isConfidence = (x: unknown) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const KNOWN_TYPES = new Set<string>(DEVICE_TYPES);
const KNOWN_FIELDS = new Set<string>(OBSERVED_FIELDS);

/** Throws, naming the rule, when a condition is not one of the shapes the engine understands. */
function checkCondition(c: unknown, id: string, depth: number): asserts c is Condition {
  const fail = (why: string): never => {
    throw new Error(`Rule ${id}: ${why}`);
  };
  if (depth > MAX_DEPTH) fail('conditions are nested too deeply');
  if (!isObject(c)) fail('a condition must be an object');
  const keys = Object.keys(c as object);
  if (keys.length !== 1) fail(`a condition must have exactly one key, found ${keys.join(', ') || 'none'}`);
  const key = keys[0] as string;
  const value = (c as Record<string, unknown>)[key];
  switch (key) {
    case 'all':
    case 'any':
      if (!Array.isArray(value) || value.length === 0) fail(`"${key}" needs a non-empty list`);
      for (const x of value as unknown[]) checkCondition(x, id, depth + 1);
      return;
    case 'not':
      checkCondition(value, id, depth + 1);
      return;
    case 'vendor':
    case 'name':
    case 'text':
      if (typeof value !== 'string' || !value) fail(`"${key}" needs a pattern`);
      return;
    case 'port':
      if (!Array.isArray(value) || value.length === 0 || !value.every((p) => Number.isInteger(p) && p >= 0 && p <= 65535))
        fail('"port" needs a list of port numbers');
      return;
    case 'ttl': {
      if (!isObject(value) || Object.keys(value).length === 0) fail('"ttl" needs at least one bound');
      for (const [k, v] of Object.entries(value as object))
        if (!['gt', 'min', 'max'].includes(k) || typeof v !== 'number' || Number.isNaN(v)) fail(`"ttl" has an invalid bound ${k}`);
      return;
    }
    case 'gateway':
    case 'virtualMac':
    case 'osKnown':
      if (typeof value !== 'boolean') fail(`"${key}" needs true or false`);
      return;
    case 'match': {
      const m = value as Record<string, unknown>;
      if (!isObject(value) || Object.keys(m).sort().join() !== 'field,pattern') fail('"match" needs exactly a field and a pattern');
      if (typeof m.field !== 'string' || !KNOWN_FIELDS.has(m.field)) fail(`"match" has an unknown field ${String(m.field)}`);
      if (typeof m.pattern !== 'string' || !m.pattern) fail('"match" needs a pattern');
      return;
    }
    case 'typeIs':
      if (typeof value !== 'string' || !KNOWN_TYPES.has(value)) fail(`"typeIs" has an unknown device type`);
      return;
    default:
      fail(`unknown condition "${key}"`);
  }
}

function checkConclusion(c: unknown, id: string, kind: 'type' | 'os') {
  if (!isObject(c) || typeof c.is !== 'string' || !c.is || typeof c.why !== 'string' || !isConfidence(c.confidence))
    throw new Error(`Rule ${id}: "${kind}" needs is, a confidence from 0 to 1, and why`);
  if (kind === 'type' && !KNOWN_TYPES.has(c.is)) throw new Error(`Rule ${id}: unknown device type "${c.is}"`);
}

/** Checks that data read from a rule file has the shape of a rule set, and returns it typed. */
export function checkRuleSet(input: unknown): RuleSet {
  if (!isObject(input) || typeof input.version !== 'string' || !input.version || !Array.isArray(input.rules))
    throw new Error('A rule set needs a version and a list of rules');
  if (input.threshold !== undefined && !isConfidence(input.threshold)) throw new Error('The rule set threshold must be from 0 to 1');
  if (input.patterns !== undefined) {
    if (!isObject(input.patterns)) throw new Error('The rule set patterns must be an object');
    for (const [name, text] of Object.entries(input.patterns))
      if (typeof text !== 'string' || !text || text.length > MAX_PATTERN) throw new Error(`Pattern ${name} must be text of at most ${MAX_PATTERN} characters`);
  }
  for (const rule of input.rules as unknown[]) {
    if (!isObject(rule) || typeof rule.id !== 'string' || !rule.id) throw new Error('Every rule needs an id');
    const id = rule.id;
    if (rule.group !== undefined && typeof rule.group !== 'string') throw new Error(`Rule ${id}: the group must be text`);
    checkCondition(rule.when, id, 0);
    if (rule.type === undefined && rule.os === undefined) throw new Error(`Rule ${id}: it concludes neither a type nor an OS`);
    if (rule.type !== undefined) checkConclusion(rule.type, id, 'type');
    if (rule.os !== undefined) checkConclusion(rule.os, id, 'os');
  }
  return input as unknown as RuleSet;
}

/**
 * Checks a rule set and compiles every regular expression once. Throws, naming the rule, when the
 * data is malformed, an id repeats, a pattern name is unknown or a regular expression does not
 * compile.
 */
export function compileRules(input: unknown): CompiledRuleSet {
  const set = checkRuleSet(input);
  const seen = new Set<string>();
  const rules = set.rules.map((rule) => {
    if (seen.has(rule.id)) throw new Error(`Rule ${rule.id}: the id is used twice`);
    seen.add(rule.id);
    return { id: rule.id, group: rule.group, type: rule.type, os: rule.os, test: compileCondition(rule.when, rule, set.patterns ?? {}) };
  });
  return { version: set.version, threshold: set.threshold ?? 0, rules };
}

function pattern(source: string, rule: Rule, patterns: Record<string, string>): RegExp {
  const named = source.startsWith('@');
  const key = source.slice(1);
  // Only the rule set's own entries count: names such as "@constructor" are not patterns.
  const text = named ? (Object.hasOwn(patterns, key) ? patterns[key] : undefined) : source;
  if (text === undefined) throw new Error(`Rule ${rule.id}: unknown pattern ${source}`);
  if (text.length > MAX_PATTERN) throw new Error(`Rule ${rule.id}: pattern ${named ? source : ''} is longer than ${MAX_PATTERN} characters`);
  try {
    return new RegExp(text, 'i');
  } catch (err) {
    throw new Error(`Rule ${rule.id}: invalid pattern ${source} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function compileCondition(c: Condition, rule: Rule, patterns: Record<string, string>): Test {
  const sub = (x: Condition) => compileCondition(x, rule, patterns);
  if ('all' in c) {
    const tests = c.all.map(sub);
    return (f, s) => tests.every((t) => t(f, s));
  }
  if ('any' in c) {
    const tests = c.any.map(sub);
    return (f, s) => tests.some((t) => t(f, s));
  }
  if ('not' in c) {
    const test = sub(c.not);
    return (f, s) => !test(f, s);
  }
  if ('vendor' in c) {
    const re = pattern(c.vendor, rule, patterns);
    return (f) => !!f.vendor && re.test(f.vendor);
  }
  if ('name' in c) {
    const re = pattern(c.name, rule, patterns);
    return (f) => f.names.some((n) => re.test(n));
  }
  if ('text' in c) {
    const re = pattern(c.text, rule, patterns);
    return (f) => f.text !== undefined && re.test(f.text);
  }
  if ('port' in c) {
    const ports = c.port;
    return (f) => ports.some((p) => f.ports.has(p));
  }
  if ('ttl' in c) {
    const { gt = -Infinity, min = -Infinity, max = Infinity } = c.ttl;
    return (f) => f.ttl !== undefined && f.ttl > gt && f.ttl >= min && f.ttl <= max;
  }
  if ('gateway' in c) {
    const want = c.gateway;
    return (f) => f.gateway === want;
  }
  if ('virtualMac' in c) {
    const want = c.virtualMac;
    return (f) => f.virtualMac === want;
  }
  if ('typeIs' in c) {
    const want = c.typeIs;
    return (_f, s) => s.type === want;
  }
  if ('match' in c) {
    const { field } = c.match;
    const re = pattern(c.match.pattern, rule, patterns);
    return (f) => f.observed?.[field]?.some((v) => re.test(v)) ?? false;
  }
  if ('osKnown' in c) {
    const want = c.osKnown;
    return (_f, s) => (s.os !== undefined) === want;
  }
  throw new Error(`Rule ${rule.id}: unknown condition ${JSON.stringify(c)}`);
}

const fill = (why: string, facts: Facts) => why.replaceAll('{ttl}', String(facts.ttl));

/**
 * Runs the rules in order. Each rule that fires may propose a type and an OS; a proposal replaces
 * the current one only with a strictly higher confidence, so on a tie the earlier rule wins.
 * Reasons are kept per candidate and only those behind the final type and OS are reported.
 */
export function evaluate(set: CompiledRuleSet, facts: Facts): Verdict {
  const typeWhy = new Map<DeviceType, string[]>();
  const osWhy = new Map<string, string[]>();
  const firedGroups = new Set<string>();
  const matched: string[] = [];
  let type: DeviceType = 'unknown';
  let typeConfidence = 0;
  let os: string | undefined;
  let osConfidence: number | undefined;

  for (const rule of set.rules) {
    if (rule.group && firedGroups.has(rule.group)) continue;
    if (!rule.test(facts, { type, os })) continue;
    if (rule.group) firedGroups.add(rule.group);
    matched.push(rule.id);
    if (rule.type) {
      if (rule.type.confidence > typeConfidence) {
        type = rule.type.is;
        typeConfidence = rule.type.confidence;
      }
      typeWhy.set(rule.type.is, [...(typeWhy.get(rule.type.is) ?? []), fill(rule.type.why, facts)]);
    }
    if (rule.os) {
      if (rule.os.confidence > (osConfidence ?? 0)) {
        os = rule.os.is;
        osConfidence = rule.os.confidence;
      }
      osWhy.set(rule.os.is, [...(osWhy.get(rule.os.is) ?? []), fill(rule.os.why, facts)]);
    }
  }

  if (typeConfidence < set.threshold) {
    type = 'unknown';
    typeConfidence = 0;
  }
  const why = [...(type === 'unknown' ? [] : (typeWhy.get(type) ?? [])), ...(os ? (osWhy.get(os) ?? []) : [])];
  return { type, typeConfidence, os, osConfidence, why: [...new Set(why)], matched, version: set.version };
}
