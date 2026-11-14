import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('scans the local subnet and lists devices in the inventory', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'app-e2e-'));
  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`] });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1440, height: 900 });

  // First launch: the welcome notice explains the licence, update checks and the usage count.
  const welcome = page.getByRole('dialog');
  await expect(welcome.getByRole('heading', { name: 'Welcome to Meshwork' })).toBeVisible();
  await expect(welcome).toContainText('stays on this computer');
  await page.screenshot({ path: 'test-results/00-welcome.png' });
  await welcome.getByRole('checkbox').uncheck();
  await welcome.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();
  await page.screenshot({ path: 'test-results/01-discover-empty.png' });

  // The target defaults to this computer's own subnet.
  await expect(page.getByRole('button', { name: 'Start scan' })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Start scan' }).click();
  // The first scan asks to confirm the network may be scanned.
  const dialog = page.getByRole('dialog', { name: 'Scan only networks you may assess' });
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Start scan' }).click();

  // Scans start straight away: no confirmation dialog.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop scan' })).toBeVisible();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: 'test-results/03-discover-running.png' });

  await expect(page.getByRole('button', { name: 'Start scan' })).toBeVisible({ timeout: 4 * 60_000 });
  await page.screenshot({ path: 'test-results/04-discover-done.png' });

  // Picking a result opens its details in a drawer without leaving Discover.
  await page.locator('table.data-table tbody tr').first().click();
  await expect(page.getByRole('complementary', { name: 'Device details' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();
  await page.screenshot({ path: 'test-results/04b-discover-drawer.png' });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Device details' })).toBeHidden();

  // The scan is saved to a network, and Discover links straight to it.
  await expect(page.getByText(/saved to/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Open in Network Inventory' }).click();
  await expect(page.getByRole('heading', { name: 'Network Inventory' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Networks' }).getByRole('listitem')).toHaveCount(2);
  await page.screenshot({ path: 'test-results/05a-network.png' });
  await page.getByRole('button', { name: 'Show all networks' }).click();
  const rows = page.locator('table.data-table tbody tr');
  expect(await rows.count()).toBeGreaterThan(0);
  await rows.first().click();
  await page.screenshot({ path: 'test-results/05-inventory.png' });

  // The WiFi survey opens and lists what the platform reports (or explains why it cannot).
  await page.getByRole('button', { name: 'WiFi', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'WiFi' })).toBeVisible();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'test-results/07-wifi.png' });

  // The map draws the scanned network: internet, gateway and grouped devices; a device opens its details.
  await page.getByRole('button', { name: 'Map', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Map' })).toBeVisible();
  await expect(page.locator('.map-node.internet')).toBeVisible();
  expect(await page.locator('.map-member').count()).toBeGreaterThan(1);
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/08-map.png' });
  await page.locator('.map-member').first().click();
  await expect(page.getByRole('complementary', { name: 'Device details' })).toBeVisible();
  await page.screenshot({ path: 'test-results/08b-map-details.png' });
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Infrastructure' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'test-results/08c-map-infrastructure.png' });

  // The search box finds a device hidden by the infrastructure view, shows it again and selects it.
  await page.getByRole('button', { name: 'Topology' }).click();
  const target = ((await page.locator('.map-member b').last().textContent()) ?? '').trim();
  await page.getByRole('button', { name: 'Infrastructure' }).click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.keyboard.type(target);
  await expect(page.getByRole('listbox', { name: 'Devices found' })).toContainText(target);
  await page.keyboard.press('Enter');
  await expect(page.locator('.map-member.selected')).toContainText(target);
  await expect(page.getByRole('button', { name: 'Topology' })).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'test-results/08d-map-search.png' });

  // The connections export lists each device with what it is plugged into, filtered by kind and text.
  await page.getByRole('button', { name: 'Connections (CSV)' }).click();
  const exporter = page.getByRole('dialog');
  await expect(exporter.getByRole('heading', { name: 'Export connections' })).toBeVisible();
  await expect(exporter.getByRole('note')).toContainText('No switch data');
  await exporter.getByPlaceholder(/Name, IP, MAC or vendor/).fill(target);
  await expect(exporter.getByRole('table')).toContainText(target);
  await expect(exporter.getByRole('button', { name: /Export 1 device$/ })).toBeEnabled();
  await page.screenshot({ path: 'test-results/08e-map-export.png' });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /Switch to (light|dark) theme/ }).click();
  await page.screenshot({ path: 'test-results/06-inventory-other-theme.png' });

  // The version in the title bar opens About, with the third-party licences, on every platform.
  await page.getByRole('button', { name: /About Meshwork/ }).click();
  await expect(page.getByRole('dialog')).toContainText('Influx Network LLC');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Licence', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Third-party licences' })).toBeVisible();
  await page.screenshot({ path: 'test-results/09-about.png' });
  await page.keyboard.press('Escape');

  // Settings: the vendor database with its automatic check interval.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('dialog');
  await expect(settings).toContainText('MAC vendor database');
  await expect(settings).toContainText('manufacturers');
  const monthly = settings.getByRole('button', { name: 'Monthly' });
  await monthly.click();
  await expect(monthly).toHaveAttribute('aria-pressed', 'true');
  await settings.getByRole('button', { name: 'Weekly' }).click();
  // Updates and the usage count; the choice made in the welcome notice is kept.
  await expect(settings).toContainText('Updates are checked in the installed app');
  await settings.getByRole('button', { name: 'Automatic' }).click();
  await expect(settings.getByRole('button', { name: 'Automatic' })).toHaveAttribute('aria-pressed', 'true');
  await expect(settings.getByRole('checkbox', { name: /anonymous usage count/ })).not.toBeChecked();
  await page.screenshot({ path: 'test-results/10-settings.png' });
  await page.keyboard.press('Escape');

  await app.close();
});
