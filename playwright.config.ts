import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for dox e2e tests.
 *
 * Targets the live staging Pages project by default. Override with
 * E2E_BASE_URL to point at a local dev server or a different staging
 * deployment.
 *
 * Auth is established once in global-setup.ts and reused by all tests via
 * a stored session on disk. The `auth` project seeds the session; every
 * other project depends on it so the whole suite benefits from one login.
 */

const BASE_URL = process.env.E2E_BASE_URL || 'https://doc-upload-site-staging.pages.dev';
const IS_CI = !!process.env.CI;

export default defineConfig({
  testDir: 'tests/e2e',
  // Shake out flakiness in CI; locally, fail fast so we see issues immediately.
  retries: IS_CI ? 2 : 0,
  // 1 worker against staging — we're mutating the real staging DB and R2
  // bucket, so parallel runs would race each other.
  workers: 1,
  timeout: 30_000,
  reporter: IS_CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: BASE_URL,
    navigationTimeout: 15_000,
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  globalSetup: require.resolve('./tests/e2e/global-setup.ts'),
  projects: [
    // Unauthenticated project — login tests that deliberately do not want a
    // pre-seeded session.
    {
      name: 'unauth',
      testMatch: /auth\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    // Admin-authenticated flows.
    {
      name: 'admin',
      testIgnore: [/auth\.spec\.ts/, /ab-eval\.spec\.ts/],
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/e2e/.auth/admin.json',
      },
    },
    // Partner-authenticated flows (A/B eval attribution).
    {
      name: 'partner',
      testMatch: /ab-eval\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'tests/e2e/.auth/partner.json',
      },
    },
  ],
});
