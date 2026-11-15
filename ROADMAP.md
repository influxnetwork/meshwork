# Roadmap

This is the order we plan to work in. It lists versions, not dates. Each item ships only when it
works on real equipment, not only in unit tests. Items can move when reports from users show
something more urgent.

Meshwork is a tool for on-site work: it reads a network, explains it and documents it. That
decides what goes on this list and what stays off it.

## Next: 0.5.22

- **Wi-Fi extenders that translate MAC addresses.** Some extenders rewrite the MAC address of
  every client behind them, so switches learn addresses that match no real device. Meshwork will
  recognise that pattern from its structure, not from a vendor list. It will place the extender
  under its access point and its clients under the extender. The pattern has been seen on one
  extender model so far; reports from other models are welcome. Extenders that hash or
  randomise client addresses cannot be undone, so their clients stay drawn as assumed.
- **Signed Windows installers**, so Windows no longer warns on first run.
- **Mac App Store edition** (sandboxed, universal binary) alongside the direct download; it is
  in review.

## 0.6: reading more equipment

- **SNMPv3**: all three security levels (noAuthNoPriv, authNoPriv, authPriv); authentication
  with MD5, SHA-1, SHA-224, SHA-256, SHA-384 and SHA-512; privacy with DES, AES-128 and both
  AES-256 key-extension variants. Engine ID discovery, and clear messages for each v3 error
  (unknown user, wrong digest, decryption failure, time window). v2c stays available.
- **Public build pipeline**: every pull request builds and runs the test suite on macOS and
  Windows.

## 0.7: the logical layer on the map

- **VRFs**: interfaces and routes grouped by VRF, read from the standard L3VPN MIB where the
  device exposes it.
- **Tunnels as logical links**: GRE, IPsec tunnel interfaces, WireGuard and VXLAN interfaces
  drawn between their two ends when both ends are known to Meshwork. A tunnel to an unknown peer
  is shown as leaving the network.
- **Link aggregation**: LACP and static port-channel members drawn as one bundle with the
  member ports listed.

## 0.8: identification the community can extend

- **Documented fingerprint rule format**, with a way to contribute a rule together with the
  **Copy details** evidence that justifies it. Each rule carries its own test.
- **Reference topologies**: a regression suite of reference networks (loops and rings,
  VLAN trunks, router-on-a-stick, redundant gateways, remote networks over VPN, rogue DHCP).
  Each has its expected map, and every release must draw them unchanged.

## Being considered

These are worth doing but are not committed to a version yet:

- Light map editing: notes, manual devices and manual links for gear that cannot be read.
- Read-only connectors for wireless and SD-WAN controllers that publish a documented API, behind
  a common interface so each one is a self-contained module.
- A Linux build.

## Out of scope

These are deliberate choices, not gaps:

- **Continuous monitoring, alerting and uptime history.** Meshwork works while you are on site;
  dedicated monitoring systems do this job better.
- **Flow collection (NetFlow, sFlow, IPFIX).** It needs an always-on collector.
- **Changing device configuration.** Meshwork reads; it never writes to the equipment it
  inspects.
- **Full service-provider modelling** (MPLS label paths, EVPN, segment routing). VRFs and
  tunnels above cover what a site visit needs; carrier cores are a different product.
