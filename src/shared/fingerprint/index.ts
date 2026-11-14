import { isVirtualMac } from '../model';
import type { DeviceType, DiscoveredHost } from '../types';
import { checkRuleSet, compileRules, evaluate, type CompiledRuleSet } from './engine';
import hostRules from './rules/host.json';
import neighbourRules from './rules/neighbour.json';
import type { Facts, RuleSet, Verdict } from './types';

/** Rules for devices found by a scan. */
export const HOST_RULES: RuleSet = /* @__PURE__ */ checkRuleSet(hostRules);
/** Rules for what a device announces about itself over LLDP or SNMP. */
export const NEIGHBOUR_RULES: RuleSet = /* @__PURE__ */ checkRuleSet(neighbourRules);

// Compiled on first use, so code that needs one rule set does not compile or ship the other.
let compiledHost: CompiledRuleSet | undefined;
let compiledNeighbour: CompiledRuleSet | undefined;

/** The facts the host rules look at, from one scanned device. */
export function hostFacts(host: DiscoveredHost, gatewayIps: string[] = []): Facts {
  return {
    vendor: host.vendor,
    ports: new Set(host.ports.map((p) => p.port)),
    names: [host.hostname, ...host.names.map((n) => n.name)].filter((n): n is string => !!n),
    ttl: host.ttl,
    gateway: gatewayIps.includes(host.ip),
    virtualMac: isVirtualMac(host.mac?.toLowerCase() ?? '', host.vendor),
    observed: host.observed,
  };
}

/** Full engine answer for a scanned device, including which rules fired. */
export function hostVerdict(host: DiscoveredHost, gatewayIps: string[] = []): Verdict {
  compiledHost ??= compileRules(HOST_RULES);
  return evaluate(compiledHost, hostFacts(host, gatewayIps));
}

/** Type, OS and the reasons for both, as stored on a device, with the rules version used. */
export interface HostClassification {
  type: DeviceType;
  typeConfidence: number;
  os?: string;
  osConfidence?: number;
  evidence: string[];
  /** Rules version that produced this classification, e.g. "rules-1". */
  fingerprint: string;
}

export function classifyHost(host: DiscoveredHost, gatewayIps: string[] = []): HostClassification {
  const v = hostVerdict(host, gatewayIps);
  return { type: v.type, typeConfidence: v.typeConfidence, os: v.os, osConfidence: v.osConfidence, evidence: v.why, fingerprint: v.version };
}

/** Full engine answer for what a device announces: its name and description. */
export function announcedVerdict(sysName?: string, sysDescr?: string): Verdict {
  compiledNeighbour ??= compileRules(NEIGHBOUR_RULES);
  return evaluate(compiledNeighbour, { ports: new Set(), names: [], gateway: false, virtualMac: false, text: `${sysName ?? ''} ${sysDescr ?? ''}` });
}

/** Device type from the name and description a device announces, or unknown. */
export function announcedType(sysName?: string, sysDescr?: string): DeviceType {
  return announcedVerdict(sysName, sysDescr).type;
}
