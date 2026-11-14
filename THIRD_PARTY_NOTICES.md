# Third-party notices

This app bundles the following third-party data, fonts and libraries.

| Component | Use | Licence |
| --- | --- | --- |
| IEEE registration authority lists (MA-L, MA-M, MA-S, IAB), from standards-oui.ieee.org | MAC address vendor names (`resources/data/oui.json`, refreshed in the app) | IEEE public listing |
| Inter (`@fontsource-variable/inter`) | UI font | SIL Open Font License 1.1 |
| JetBrains Mono (`@fontsource-variable/jetbrains-mono`) | Monospaced font for addresses and ports | SIL Open Font License 1.1 |
| Lucide (`lucide-react`) | Interface and device glyphs | ISC |
| Electron | Desktop runtime | MIT |
| React, React DOM | UI | MIT |
| Radix UI primitives | Accessible dialogs and overlays | MIT |
| Zustand | UI state | MIT |
| dns-packet | Multicast DNS name queries | MIT |
| net-snmp | Reading switches and routers over SNMP | MIT |
| electron-updater | Update checks and installs for the direct downloads | MIT |
| React Flow (`@xyflow/react`) | Map canvas: pan, zoom, nodes and links | MIT |
| html-to-image | Map export to PNG and SVG | MIT |
| Tailwind CSS | Styling | MIT |

`scripts/collect-licenses.mjs` runs before every build. It collects the licence text of each package
above and of everything they depend on into `resources/licenses/THIRD_PARTY_LICENSES.txt`, which is
packaged with the app and opened from **Help → Acknowledgements**. The build stops if any bundled
package uses a licence outside the allow list (MIT, ISC, BSD, Apache-2.0, OFL-1.1 and similar).
