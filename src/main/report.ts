/**
 * Prints a report to PDF in a hidden window. The document is loaded from a temporary file (it can
 * be larger than a URL allows) with scripts off: it is static HTML with embedded images and fonts.
 */
import { app, BrowserWindow } from 'electron';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Longest a report may take to lay out and print. */
const PRINT_TIMEOUT_MS = 60_000;

export async function printPdf(html: string): Promise<Buffer> {
  const file = join(app.getPath('temp'), `meshwork-report-${process.pid}-${Date.now()}.html`);
  writeFileSync(file, html, 'utf8');
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
  });
  // The document has no links to follow; any navigation away is blocked.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      // Fonts and images are embedded as data URLs, so the load event means everything is in.
      await win.loadFile(file);
      return win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('the report took too long to print')), PRINT_TIMEOUT_MS);
    });
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    win.destroy();
    rmSync(file, { force: true });
  }
}
