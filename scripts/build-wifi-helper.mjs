// Compiles the macOS Wi-Fi helper (native/macos/wifi) into a universal background app bundle at
// resources/bin/mac/MeshworkWiFi.app. Does nothing on other platforms.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('wifi helper: skipped (macOS only)');
  process.exit(0);
}

const root = join(import.meta.dirname, '..');
const source = join(root, 'native', 'macos', 'wifi', 'main.swift');
const plist = join(root, 'native', 'macos', 'wifi', 'Info.plist');
const outDir = join(root, 'resources', 'bin', 'mac');
const bundle = join(outDir, 'MeshworkWiFi.app');
const out = join(bundle, 'Contents', 'MacOS', 'meshwork-wifi');
const work = mkdtempSync(join(tmpdir(), 'wifi-helper-'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true });
copyFileSync(plist, join(bundle, 'Contents', 'Info.plist'));
const slices = ['arm64', 'x86_64'].map((arch) => {
  const slice = join(work, `meshwork-wifi-${arch}`);
  execFileSync(
    'xcrun',
    [
      'swiftc', '-O', '-target', `${arch}-apple-macos13.0`, source, '-o', slice,
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist,
    ],
    { stdio: 'inherit' },
  );
  return slice;
});
execFileSync('lipo', ['-create', ...slices, '-output', out], { stdio: 'inherit' });
rmSync(work, { recursive: true, force: true });
console.log(`wifi helper: ${bundle}`);
