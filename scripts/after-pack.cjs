/**
 * electron-builder afterPack hook (macOS). Runs before code signing.
 *
 * The app's executables are copies of the prebuilt runtime binaries, so their Mach-O LC_UUID is
 * identical to every other app built on the same runtime version. macOS privacy features such as
 * Local Network access identify executables by that UUID, which makes permission prompts and
 * settings collide between apps. This hook writes a UUID derived from the app id, the executable
 * name and the architecture: unique to this app, and stable across releases so a granted
 * permission survives updates.
 */
const { createHash } = require('node:crypto');
const { readFileSync, readdirSync, writeFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' };

/** RFC 4122 name-based UUID bytes (version 5 layout) from a SHA-256 of `name`. */
function stableUuid(name) {
  const bytes = createHash('sha256').update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
}

/** Replaces the LC_UUID of a thin 64-bit little-endian Mach-O file. Returns the old and new UUIDs. */
function rewriteUuid(file, uuid) {
  const buf = readFileSync(file);
  if (buf.readUInt32LE(0) !== MH_MAGIC_64) throw new Error(`${file}: not a thin 64-bit Mach-O binary`);
  const ncmds = buf.readUInt32LE(16);
  let offset = 32; // size of mach_header_64
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(offset);
    const size = buf.readUInt32LE(offset + 4);
    if (cmd === LC_UUID) {
      const before = buf.subarray(offset + 8, offset + 24).toString('hex');
      uuid.copy(buf, offset + 8);
      writeFileSync(file, buf);
      return { before, after: uuid.toString('hex') };
    }
    offset += size;
  }
  throw new Error(`${file}: no LC_UUID load command`);
}

/** The main executable plus every helper app executable inside Contents/Frameworks. */
function executables(appDir, productName) {
  const list = [join(appDir, 'Contents', 'MacOS', productName)];
  const frameworks = join(appDir, 'Contents', 'Frameworks');
  for (const entry of readdirSync(frameworks)) {
    if (!entry.endsWith('.app')) continue;
    const name = entry.slice(0, -'.app'.length);
    const exe = join(frameworks, entry, 'Contents', 'MacOS', name);
    if (existsSync(exe)) list.push(exe);
  }
  return list;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin' && context.electronPlatformName !== 'mas') return;
  const { id: appId, productFilename } = context.packager.appInfo;
  const arch = ARCH_NAMES[context.arch] ?? String(context.arch);
  // A universal app is merged from the x64 and arm64 apps, whose executables were already rewritten.
  if (arch === 'universal') return;
  const appDir = join(context.appOutDir, `${productFilename}.app`);
  for (const exe of executables(appDir, productFilename)) {
    const exeName = exe.split('/').pop();
    const { before, after } = rewriteUuid(exe, stableUuid(`${appId}:${exeName}:${arch}`));
    console.log(`  • executable uuid  ${exeName} (${arch}) ${before} → ${after}`);
  }
};
