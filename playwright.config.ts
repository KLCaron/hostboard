import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60000,
  expect: { timeout: 15000 },
  workers: 1,
  use: { baseURL: process.env.HOSTBOARD_TEST_URL || 'http://127.0.0.1:3001', browserName: 'firefox', trace: 'retain-on-failure' },
  webServer: process.env.HOSTBOARD_TEST_URL ? undefined : { command: 'npx tsx tests/browser-server.ts', url: 'http://127.0.0.1:3001/api/health', reuseExistingServer: false, timeout: 30000 },
  projects: [
    { name: 'firefox-desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'firefox-mobile', use: { viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
});
