import { defineConfig } from '@playwright/test';

const port = process.env.SCRATCHTREE_WEB_TEST_PORT ?? '4612';
const baseURL = `http://127.0.0.1:${port}`;
const browser = process.env.SCRATCHTREE_WEB_BROWSER;
if (!/^\d+$/.test(port))
  throw Error('SCRATCHTREE_WEB_TEST_PORT must be numeric');
if (browser && !['chrome', 'firefox', 'webkit'].includes(browser))
  throw Error('Unknown SCRATCHTREE_WEB_BROWSER');

export default defineConfig({
  testDir: 'tests/public-web',
  testMatch: '**/*.pw.ts',
  expect: { timeout: 5000 },
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    browserName:
      browser === 'firefox' || browser === 'webkit' ? browser : 'chromium',
    channel: browser === 'chrome' ? browser : undefined,
  },
  webServer: {
    command: 'node tests/support/public-web-server.mjs',
    url: baseURL,
    reuseExistingServer: false,
  },
});
