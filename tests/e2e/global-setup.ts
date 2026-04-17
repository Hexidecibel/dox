/**
 * Playwright global setup — logs in as the two staging accounts and stores
 * their auth state on disk. Every subsequent test reuses these sessions via
 * the `storageState` in playwright.config.ts.
 *
 * Running this once (per `bin/e2e` invocation) avoids paying the login cost
 * for every single test. The sessions are JWTs in localStorage plus any
 * cookies Cloudflare Pages sets, captured with page.context().storageState().
 */

import { chromium, FullConfig, request } from '@playwright/test';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

const BASE_URL = process.env.E2E_BASE_URL || 'https://doc-upload-site-staging.pages.dev';

const ADMIN_EMAIL = 'a@a.a';
const ADMIN_PASSWORD = 'a';
const PARTNER_EMAIL = 'p@p.p';
const PARTNER_PASSWORD = 'p';

const ADMIN_STATE = 'tests/e2e/.auth/admin.json';
const PARTNER_STATE = 'tests/e2e/.auth/partner.json';

/**
 * Hit /api/auth/login with the given creds and stuff the returned token into
 * localStorage in the browser context, then save state. Going through the
 * API is faster and less flaky than driving the login form and also
 * sidesteps the "already logged in, redirecting..." race in Login.tsx.
 */
async function loginAndSaveState(
  email: string,
  password: string,
  stateFile: string,
): Promise<void> {
  mkdirSync(dirname(stateFile), { recursive: true });

  // 1. Get the token from the API directly.
  const api = await request.newContext({ baseURL: BASE_URL });
  const loginRes = await api.post('/api/auth/login', {
    data: { email, password },
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(
      `global-setup: login failed for ${email} (${loginRes.status()}): ${body}`,
    );
  }
  const loginData = (await loginRes.json()) as { token: string; user: unknown };
  if (!loginData.token) {
    throw new Error(`global-setup: no token in login response for ${email}`);
  }
  await api.dispose();

  // 2. Seed localStorage in a fresh browser context, then save state.
  //    AuthContext reads both `auth_token` and `auth_user` from localStorage
  //    on mount; missing either one triggers a silent logout.
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE_URL });
  const page = await ctx.newPage();

  // Must navigate before localStorage is scoped to an origin.
  await page.goto('/login');
  await page.evaluate(
    ({ token, user }) => {
      localStorage.setItem('auth_token', token);
      localStorage.setItem('auth_user', JSON.stringify(user));
    },
    { token: loginData.token, user: loginData.user },
  );

  // Verify the token works by hitting a protected page.
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle').catch(() => {
    /* networkidle sometimes never fires on SPAs; ignore */
  });

  await ctx.storageState({ path: stateFile });
  await browser.close();
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // Both accounts — admin for most flows, partner for A/B eval attribution.
  await loginAndSaveState(ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_STATE);
  await loginAndSaveState(PARTNER_EMAIL, PARTNER_PASSWORD, PARTNER_STATE);
}
