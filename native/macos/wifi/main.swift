// Wi-Fi helper for macOS. Prints one JSON document on stdout.
//
//   meshwork-wifi scan       current connection and nearby networks (default)
//   meshwork-wifi status     Location authorisation only
//   meshwork-wifi authorize  asks for Location access, waits for the answer, prints the status
//
// macOS only reveals network names (SSID) and access point addresses (BSSID) to processes with
// Location access; without it those fields are null and everything else is still reported.
// The helper is packaged as a background app bundle (no Dock icon) because macOS only shows the
// Location prompt to app bundles; it is started with `open` so it is its own responsible process.

import AppKit
import CoreLocation
import CoreWLAN
import Foundation

struct Channel: Encodable {
  let number: Int
  /// "2.4", "5" or "6" (GHz); nil when unknown.
  let band: String?
  /// Channel width in MHz.
  let width: Int?
}

struct Network: Encodable {
  let ssid: String?
  let bssid: String?
  let rssi: Int
  let noise: Int
  let channel: Channel?
  let security: [String]
  let phy: [String]
  let beaconInterval: Int
  let countryCode: String?
  let adHoc: Bool
}

struct Connection: Encodable {
  let interface: String
  let poweredOn: Bool
  let ssid: String?
  let bssid: String?
  let rssi: Int
  let noise: Int
  let channel: Channel?
  let txRateMbps: Double
  let phy: String?
  let security: String?
  let countryCode: String?
}

struct Report: Encodable {
  let location: String
  let connection: Connection?
  let networks: [Network]
  let error: String?
}

func band(_ c: CWChannel) -> String? {
  switch c.channelBand {
  case .band2GHz: return "2.4"
  case .band5GHz: return "5"
  case .band6GHz: return "6"
  default: return nil
  }
}

func width(_ c: CWChannel) -> Int? {
  switch c.channelWidth {
  case .width20MHz: return 20
  case .width40MHz: return 40
  case .width80MHz: return 80
  case .width160MHz: return 160
  default: return nil
  }
}

func channel(_ c: CWChannel?) -> Channel? {
  guard let c else { return nil }
  return Channel(number: c.channelNumber, band: band(c), width: width(c))
}

let phyModes: [(String, CWPHYMode)] = [
  ("be", .mode11be), ("ax", .mode11ax), ("ac", .mode11ac), ("n", .mode11n), ("a", .mode11a), ("g", .mode11g), ("b", .mode11b),
]

let securityModes: [(String, CWSecurity)] = [
  ("WPA3 Enterprise", .wpa3Enterprise), ("WPA3", .wpa3Personal), ("WPA2/WPA3", .wpa3Transition),
  ("WPA2 Enterprise", .wpa2Enterprise), ("WPA2", .wpa2Personal), ("WPA Enterprise", .wpaEnterprise),
  ("WPA", .wpaPersonal), ("OWE", .OWE), ("OWE transition", .oweTransition), ("WEP", .WEP),
  ("Dynamic WEP", .dynamicWEP), ("Open", .none),
]

func phyName(_ mode: CWPHYMode) -> String? {
  phyModes.first { $0.1 == mode }?.0
}

func securityName(_ s: CWSecurity) -> String? {
  securityModes.first { $0.1 == s }?.0
}

func locationStatus(_ manager: CLLocationManager) -> String {
  switch manager.authorizationStatus {
  case .authorizedAlways: return "authorized"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-determined"
  @unknown default: return "unknown"
  }
}

func emit<T: Encodable>(_ value: T) {
  let encoder = JSONEncoder()
  if let data = try? encoder.encode(value), let text = String(data: data, encoding: .utf8) {
    print(text)
  }
}

/// Waits for the user's answer to the Location prompt (or a timeout) on the main run loop.
final class Authorizer: NSObject, CLLocationManagerDelegate {
  let manager = CLLocationManager()
  var done = false

  func run(timeout: TimeInterval) -> String {
    manager.delegate = self
    if manager.authorizationStatus == .notDetermined {
      manager.requestWhenInUseAuthorization()
      let deadline = Date().addingTimeInterval(timeout)
      while !done && Date() < deadline {
        RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.25))
      }
    }
    return locationStatus(manager)
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    if manager.authorizationStatus != .notDetermined { done = true }
  }
}

/// CoreLocation reports the real status through the delegate shortly after a manager is created;
/// waits briefly for that callback before reading it.
final class StatusReader: NSObject, CLLocationManagerDelegate {
  let manager = CLLocationManager()
  var ready = false

  func read() -> String {
    manager.delegate = self
    let deadline = Date().addingTimeInterval(1.5)
    while !ready && Date() < deadline {
      RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
    }
    return locationStatus(manager)
  }

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) { ready = true }
}

func scan() -> Report {
  let reader = StatusReader()
  let location = reader.read()
  guard let iface = CWWiFiClient.shared().interface() else {
    return Report(location: location, connection: nil, networks: [], error: "No Wi-Fi interface")
  }
  let connection = Connection(
    interface: iface.interfaceName ?? "",
    poweredOn: iface.powerOn(),
    ssid: iface.ssid(),
    bssid: iface.bssid(),
    rssi: iface.rssiValue(),
    noise: iface.noiseMeasurement(),
    channel: channel(iface.wlanChannel()),
    txRateMbps: iface.transmitRate(),
    phy: phyName(iface.activePHYMode()),
    security: securityName(iface.security()),
    countryCode: iface.countryCode()
  )
  if !iface.powerOn() {
    return Report(location: location, connection: connection, networks: [], error: "Wi-Fi is turned off")
  }
  do {
    let found = try iface.scanForNetworks(withName: nil)
    let networks = found.map { n in
      Network(
        ssid: n.ssid,
        bssid: n.bssid,
        rssi: n.rssiValue,
        noise: n.noiseMeasurement,
        channel: channel(n.wlanChannel),
        security: securityModes.filter { n.supportsSecurity($0.1) }.map { $0.0 },
        phy: phyModes.filter { n.supportsPHYMode($0.1) }.map { $0.0 },
        beaconInterval: n.beaconInterval,
        countryCode: n.countryCode,
        adHoc: n.ibss
      )
    }
    return Report(location: location, connection: connection, networks: networks, error: nil)
  } catch {
    return Report(location: location, connection: connection, networks: [], error: error.localizedDescription)
  }
}

switch CommandLine.arguments.dropFirst().first ?? "scan" {
case "status":
  let reader = StatusReader()
  emit(["location": reader.read()])
case "authorize":
  // An accessory app can present the system prompt without a Dock icon or menu bar.
  NSApplication.shared.setActivationPolicy(.accessory)
  NSApplication.shared.activate(ignoringOtherApps: true)
  let authorizer = Authorizer()
  emit(["location": authorizer.run(timeout: 120)])
default:
  emit(scan())
}
