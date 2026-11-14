// Compiles the macOS network code for Mac App Store builds (native/macos/net) into
// resources/bin/mac:
//   meshwork-net        universal command-line traceroute helper
//   meshwork-arp.node   universal Node-API module that reads the neighbour table in the main process
// Only Mac App Store builds use them. Run after scripts/build-wifi-helper.mjs, which recreates
// resources/bin/mac. Does nothing on other platforms.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

if (process.platform !== 'darwin') {
  console.log('net helper: skipped (macOS only)');
  process.exit(0);
}

const root = join(import.meta.dirname, '..');
const src = join(root, 'native', 'macos', 'net');
const outDir = join(root, 'resources', 'bin', 'mac');
const common = ['-O2', '-Wall', '-Wextra', '-Werror', '-arch', 'arm64', '-arch', 'x86_64', '-mmacosx-version-min=12.0'];

// Node-API is ABI-stable, so the headers of the Node.js running this script fit Electron too.
const nodeInclude = join(dirname(process.execPath), '..', 'include', 'node');
if (!existsSync(join(nodeInclude, 'node_api.h'))) {
  console.error(`net helper: node_api.h not found in ${nodeInclude}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const helper = join(outDir, 'meshwork-net');
execFileSync('xcrun', ['clang', ...common, join(src, 'main.c'), '-o', helper], { stdio: 'inherit' });
console.log(`net helper: ${helper}`);

const addon = join(outDir, 'meshwork-arp.node');
execFileSync(
  'xcrun',
  ['clang', ...common, '-bundle', '-undefined', 'dynamic_lookup', '-I', nodeInclude, join(src, 'arp_addon.c'), join(src, 'arp_table.c'), '-o', addon],
  { stdio: 'inherit' },
);
console.log(`net helper: ${addon}`);
