/**
 * Apple signing values for the packaging configs. The team ID and the signing identities are
 * read from the environment (scripts/release-env.sh loads them from a file outside the
 * repository), so the repository holds no account identifiers.
 *
 *   APPLE_TEAM_ID              team ID; required to sign macOS builds
 *   MESHWORK_MAC_IDENTITY      Developer ID identity name, e.g. "Example LLC (ABCDE12345)"
 *   MESHWORK_MAS_DEV_IDENTITY  development identity for local Mac App Store test builds (optional)
 *
 * Entitlement files that need the team ID are templates holding `__APPLE_TEAM_ID__`; they are
 * written with the real value under out/signing/ at packaging time.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out', 'signing');
const PLACEHOLDER = /__APPLE_TEAM_ID__/g;

/** The team ID, or undefined when it is not set or not a 10-character Apple team ID. */
function teamId() {
  const id = (process.env.APPLE_TEAM_ID || '').trim();
  return /^[A-Z0-9]{10}$/.test(id) ? id : undefined;
}

/** An environment value with surrounding spaces removed, or undefined when empty. */
function envValue(name) {
  const value = (process.env[name] || '').trim();
  return value || undefined;
}

/**
 * Path of the entitlements file to sign with: the template itself when it has no placeholder,
 * otherwise a copy under out/signing/ with the team ID filled in. Throws when the template needs
 * a team ID and none is set, because signing with the placeholder would produce a broken app.
 */
function entitlements(templatePath) {
  const source = path.join(ROOT, templatePath);
  const text = fs.readFileSync(source, 'utf8');
  if (!PLACEHOLDER.test(text)) return templatePath;
  PLACEHOLDER.lastIndex = 0;
  const id = teamId();
  if (!id) throw new Error(`APPLE_TEAM_ID is not set; it is needed to sign with ${templatePath}`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, path.basename(templatePath));
  fs.writeFileSync(target, text.replace(PLACEHOLDER, id));
  return target;
}

module.exports = { teamId, envValue, entitlements };
