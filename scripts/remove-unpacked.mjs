// Removes the unpacked app folders electron-builder leaves next to the installers of the current
// version. Only the installers and update files are kept: the Mac's app search would otherwise list
// every unpacked app as one more Meshwork.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
for (const dir of ['mac', 'mac-arm64', 'mac-universal', 'win-unpacked', 'win-arm64-unpacked']) {
  rmSync(join('release', version, dir), { recursive: true, force: true });
}
