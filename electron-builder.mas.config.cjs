/**
 * Mac App Store build. Shares everything with electron-builder.config.cjs except the target,
 * signing and sandbox permissions. Updates come from the App Store, so no update feed is
 * published. Needs APPLE_TEAM_ID and MESHWORK_MAC_IDENTITY (see scripts/signing.cjs); the mas target
 * takes its identity from the mac section.
 */
const base = require('./electron-builder.config.cjs');
const { envValue, entitlements, teamId } = require('./scripts/signing.cjs');

const team = teamId();
if (!team || !base.mac.identity) {
  throw new Error('APPLE_TEAM_ID and MESHWORK_MAC_IDENTITY must be set; the Mac App Store build cannot be signed without them.');
}

const masDevIdentity = envValue('MESHWORK_MAS_DEV_IDENTITY');

module.exports = {
  ...base,
  mac: {
    ...base.mac,
    target: [{ target: 'mas', arch: ['universal'] }],
    artifactName: '${productName}-${version}-mas.${ext}',
    notarize: false,
  },
  mas: {
    hardenedRuntime: false,
    entitlements: entitlements('build/entitlements.mas.plist'),
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    provisioningProfile: 'build/appstore.provisionprofile',
    extendInfo: {
      ElectronTeamID: team,
      // Encryption is limited to HTTPS and the system keychain: exempt, so no export documentation per upload.
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  masDev: {
    // Local test builds: the development certificate listed in appstore-dev.provisionprofile.
    ...(masDevIdentity ? { identity: masDevIdentity } : {}),
    hardenedRuntime: false,
    entitlements: entitlements('build/entitlements.mas.plist'),
    entitlementsInherit: 'build/entitlements.mas.inherit.plist',
    provisioningProfile: 'build/appstore-dev.provisionprofile',
    extendInfo: { ElectronTeamID: team },
  },
  publish: null,
};
