import { _electron as electron, expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Screenshots for the website, taken on the fictional demo network (scripts/demo-network.ts).
 * Runs only when MESHWORK_SHOTS names the folder to write into.
 */
const outDir = process.env.MESHWORK_SHOTS;
test.skip(!outDir, 'set MESHWORK_SHOTS to the folder for website screenshots');

test('website screenshots on the demo network', async () => {
  const out = outDir as string;
  mkdirSync(out, { recursive: true });
  const userData = mkdtempSync(join(tmpdir(), 'app-shots-'));
  execFileSync('npx', ['-y', 'tsx', '--tsconfig', 'tsconfig.node.json', 'scripts/demo-network.ts', userData], { stdio: 'inherit' });
  writeFileSync(
    join(userData, 'app-prefs.json'),
    JSON.stringify({ updateMode: 'notify', usageCount: false, noticeSeen: true, installId: '00000000-0000-4000-8000-000000000000', seenVersion: JSON.parse(readFileSync('package.json', 'utf8')).version }),
  );

  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`] });
  const page = await app.firstWindow();
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 400)); });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message.slice(0, 400)));
  await page.setViewportSize({ width: 1440, height: 900 });
  // Double pixel density, so the images stay sharp on high-resolution screens.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  const shot = async (name: string) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 900, scale: 1 } });
    writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
  };
  const setTheme = async (theme: 'light' | 'dark') => {
    const toggle = page.getByRole('button', { name: /Switch to (light|dark) theme/ });
    if ((await toggle.getAttribute('aria-label')) === `Switch to ${theme} theme`) await toggle.click();
  };

  await setTheme('light');
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.locator('.map-node.internet')).toBeVisible();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(800);

  // The whole network: every device grouped under its switch, with ports, VLANs and PoE.
  await page.getByRole('button', { name: 'Hide the side panel' }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /fit view/i }).click();
  await page.waitForTimeout(900);
  await shot('map-overview');
  // A closer look: the floor switch with its devices, ports, VLANs and PoE.
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.keyboard.type('sw-floor2');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await page.mouse.click(1300, 860);
  for (let i = 0; i < 2; i++) await page.getByRole('button', { name: /zoom out/i }).click();
  await page.waitForTimeout(600);
  await shot('map-detail');
  await page.getByRole('button', { name: 'Clear the search' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Show the side panel' }).click();

  await page.getByRole('button', { name: 'Infrastructure' }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(800);
  await shot('map-infrastructure');
  await page.getByRole('button', { name: 'Topology' }).click();

  await page.getByRole('button', { name: 'Connections (CSV)' }).click();
  const exporter = page.getByRole('dialog');
  // Only cameras: turn every other kind off.
  for (const chip of await exporter.locator('.chip-toggle').all()) {
    if (!/Cameras/.test((await chip.textContent()) ?? '') && (await chip.getAttribute('aria-pressed')) === 'true') await chip.click();
  }
  await page.waitForTimeout(300);
  await shot('export-connections');
  await page.keyboard.press('Escape');

  await setTheme('dark');
  await page.getByRole('button', { name: 'Infrastructure' }).click();
  await page.getByRole('button', { name: 'Fit', exact: true }).click();
  await page.waitForTimeout(800);
  await shot('map-dark');

  await page.getByRole('button', { name: 'Network Inventory', exact: true }).click();
  await page.getByRole('button', { name: 'Show all networks' }).click().catch(() => undefined);
  await page.locator('table.data-table tbody tr', { hasText: 'cam-loading' }).click();
  await page.waitForTimeout(400);
  await shot('inventory-dark');

  // The same view in the light theme, so the two can be compared side by side.
  await setTheme('light');
  await page.waitForTimeout(400);
  await shot('inventory-light');
  await page.keyboard.press('Escape');

  await app.close();
});
