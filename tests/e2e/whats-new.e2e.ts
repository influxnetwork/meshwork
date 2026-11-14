import { _electron as electron, expect, test } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

/** Launches the app with saved preferences, as an installation that has run before. */
async function launchWith(prefs: Record<string, unknown>) {
  const userData = mkdtempSync(join(tmpdir(), 'app-e2e-'));
  writeFileSync(
    join(userData, 'app-prefs.json'),
    JSON.stringify({ updateMode: 'notify', usageCount: false, noticeSeen: true, installId: '00000000-0000-4000-8000-000000000000', ...prefs }),
  );
  const app = await electron.launch({ args: ['out/main/index.js', `--user-data-dir=${userData}`] });
  return { app, page: await app.firstWindow(), userData };
}

test('shows what changed once after an update', async () => {
  const { app, page, userData } = await launchWith({ seenVersion: '0.5.7' });
  const notice = page.getByRole('dialog');
  await expect(notice.getByRole('heading', { name: `Meshwork was updated to v${version}` })).toBeVisible();
  await expect(notice).toContainText('since v0.5.7');
  // Notes for many versions scroll inside the dialog; the title and button stay on a small screen.
  await page.setViewportSize({ width: 1000, height: 620 });
  await expect(notice.getByRole('heading', { name: `Meshwork was updated to v${version}` })).toBeInViewport();
  await expect(notice.getByRole('button', { name: 'Got it' })).toBeInViewport();
  await page.screenshot({ path: 'test-results/whats-new.png' });
  await notice.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const saved = JSON.parse(readFileSync(join(userData, 'app-prefs.json'), 'utf8')) as { seenVersion?: string };
  expect(saved.seenVersion).toBe(version);
  await app.close();
});

test('stays quiet when the version has not changed', async () => {
  const { app, page } = await launchWith({ seenVersion: version });
  await expect(page.getByRole('heading', { name: 'Discover' })).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await app.close();
});
