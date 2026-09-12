import { chromium } from 'playwright';

/**
 * Launch headless Chromium. Overrides (in order):
 *   A11Y_CHROMIUM_PATH=/usr/bin/chromium   explicit binary (e.g. apt-installed Chromium on the GB10)
 *   A11Y_BROWSER_CHANNEL=chrome            an installed Google Chrome / Edge via Playwright channels
 * Otherwise Playwright's own bundled Chromium (`npx playwright install chromium`).
 */
export async function launchBrowser() {
  const opts = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] };
  if (process.env.A11Y_CHROMIUM_PATH) opts.executablePath = process.env.A11Y_CHROMIUM_PATH;
  else if (process.env.A11Y_BROWSER_CHANNEL) opts.channel = process.env.A11Y_BROWSER_CHANNEL;
  return chromium.launch(opts);
}
