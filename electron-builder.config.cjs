/**
 * Packaging config for the direct-download builds: macOS dmg and zip, Windows NSIS installer.
 * Apple signing values come from the environment (see scripts/signing.cjs); without them the
 * macOS build is left unsigned and the Windows build is unaffected.
 */
const { envValue, entitlements, teamId } = require('./scripts/signing.cjs');

const LOCATION_REASON =
  'Meshwork shows the names of nearby Wi-Fi networks. macOS shares them only with apps that have Location access. Your location itself is not used or stored.';

const signed = Boolean(teamId() && envValue('MESHWORK_MAC_IDENTITY'));
if (!signed && process.platform === 'darwin') {
  console.warn('electron-builder.config: APPLE_TEAM_ID or MESHWORK_MAC_IDENTITY not set; the macOS build is not signed.');
}

module.exports = {
  appId: 'com.influxnetwork.meshwork',
  productName: 'Meshwork',
  directories: { output: 'release/${version}', buildResources: 'build' },
  files: ['out/**', '!out/signing/**', 'package.json'],
  extraResources: [
    { from: 'resources/data', to: 'data' },
    { from: 'resources/licenses', to: 'licenses' },
  ],
  asar: true,
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // The zip is what installed copies download when they update themselves.
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    // Names the zip; the dmg sets its own name below.
    artifactName: '${productName}-${version}-${arch}-mac.${ext}',
    identity: signed ? envValue('MESHWORK_MAC_IDENTITY') : null,
    hardenedRuntime: true,
    entitlements: signed ? entitlements('build/entitlements.mac.plist') : 'build/entitlements.mac.inherit.plist',
    entitlementsInherit: 'build/entitlements.mac.inherit.plist',
    provisioningProfile: signed ? 'build/embedded.provisionprofile' : undefined,
    extraResources: [
      { from: 'resources/data', to: 'data' },
      { from: 'resources/bin/mac', to: 'bin' },
      { from: 'resources/licenses', to: 'licenses' },
    ],
    extendInfo: {
      NSLocationUsageDescription: LOCATION_REASON,
      NSLocationWhenInUseUsageDescription: LOCATION_REASON,
      NSLocalNetworkUsageDescription: 'Meshwork scans the networks you choose to find devices and open services.',
      NSBonjourServices: ['_device-info._tcp', '_http._tcp', '_ssh._tcp', '_smb._tcp'],
    },
    notarize: signed,
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    license: 'resources/licenses/LICENSE.txt',
    artifactName: '${productName}-${version}-setup-${arch}.${ext}',
  },
  dmg: { artifactName: '${productName}-${version}-${arch}.dmg' },
  afterPack: 'scripts/after-pack.cjs',
  // Update manifests (latest.yml, latest-mac.yml) point at this address; the files themselves are uploaded separately.
  publish: { provider: 'generic', url: 'https://meshwork.influxnetwork.com/updates' },
};
