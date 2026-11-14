import type { DeviceType } from '../types';

/**
 * Kinds of evidence the identify phase collects, each a list of texts. Names are "source.part":
 * services announced over mDNS, the UPnP description, ONVIF discovery replies, the web page,
 * the TLS certificate and the SSH greeting.
 */
export const OBSERVED_FIELDS = [
  'services',
  'upnp.deviceType',
  'upnp.manufacturer',
  'upnp.model',
  'upnp.friendlyName',
  'onvif',
  'http.title',
  'http.server',
  'tls.subject',
  'tls.issuer',
  'ssh',
] as const;

export type ObservedField = (typeof OBSERVED_FIELDS)[number];

/** Collected evidence by kind; a kind left out was not collected or found nothing. */
export type Observed = Partial<Record<ObservedField, string[]>>;

/**
 * What is known about one device, gathered from the scan and from what it announces. Each field
 * is one kind of evidence; a field left out means that evidence was not collected.
 */
export interface Facts {
  /** Organisation that owns the MAC prefix. */
  vendor?: string;
  /** Open TCP ports. */
  ports: ReadonlySet<number>;
  /** Host name and every name found over mDNS, NetBIOS or DNS. */
  names: string[];
  /** TTL of the ping reply. */
  ttl?: number;
  /** True when the device is a default gateway of the scanning computer. */
  gateway: boolean;
  /** True when the MAC belongs to a virtual machine network card. */
  virtualMac: boolean;
  /** Name and description a device announces about itself (LLDP, SNMP). */
  text?: string;
  /** Evidence from the identify phase. */
  observed?: Observed;
}

/**
 * A test on the facts, or on what earlier rules decided. Text tests are case-insensitive regular
 * expressions; "@name" refers to an entry of the rule set's `patterns`.
 */
export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { vendor: string }
  | { name: string }
  | { text: string }
  /** At least one of these ports is open. */
  | { port: number[] }
  /** TTL within the bounds (`gt` exclusive, `min` and `max` inclusive); false when there is no TTL. */
  | { ttl: { gt?: number; min?: number; max?: number } }
  | { gateway: boolean }
  | { virtualMac: boolean }
  /** The type chosen by the rules before this one. */
  | { typeIs: DeviceType }
  /** Whether the rules before this one chose an OS. */
  | { osKnown: boolean }
  /** One value of a kind of collected evidence matches the pattern. */
  | { match: { field: ObservedField; pattern: string } };

/** What a rule concludes when it fires. `why` may contain "{ttl}". */
export interface Conclusion<T> {
  is: T;
  /** 0..1 */
  confidence: number;
  why: string;
}

export interface Rule {
  /** Stable identifier, unique in the rule set; each one has its own test. */
  id: string;
  /** Rules of the same group are alternatives: only the first one that matches fires. */
  group?: string;
  when: Condition;
  type?: Conclusion<DeviceType>;
  os?: Conclusion<string>;
}

/** Rules in the order they are tried, from the most specific to the most generic. */
export interface RuleSet {
  /** Recorded on every result, e.g. "rules-1". Bumped whenever a change alters results. */
  version: string;
  /** Under this confidence the type is reported as unknown; the OS is kept. Defaults to 0. */
  threshold?: number;
  /** Named regular expressions that conditions refer to as "@name". */
  patterns?: Record<string, string>;
  rules: Rule[];
}

/** The engine's answer for one device. */
export interface Verdict {
  type: DeviceType;
  typeConfidence: number;
  os?: string;
  osConfidence?: number;
  /** Reasons behind the chosen type, then behind the chosen OS. */
  why: string[];
  /** Ids of the rules that fired, in order. */
  matched: string[];
  version: string;
}
