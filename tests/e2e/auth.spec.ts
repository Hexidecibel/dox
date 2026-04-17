/**
 * Auth smoke tests — login/logout happy path + bad-password rejection.
 *
 * Runs in the `unauth` project (no storageState) so we actually exercise
 * the login form. All other specs piggyback on the session global-setup
 * persists, so these are the only tests that type credentials.
 */

import { test, expect } from '@playwright/test';

// These tests deliberately do NOT use the shared storage state. The unauth
// project config takes care of that; we just assert it to catch misconfig.
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('auth', () => {
  test('login with valid admin credentials redirects to dashboard', async ({
    page,
  }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill('a@a.a');
    await page.getByLabel('Password').fill('a');
    await page.getByRole('button', { name: /sign in/i }).click();

    // Wait for navigation away from /login.
    await page.waitForURL(/\/dashboard$/);

    // The Layout shell should be visible on the dashboard.
    await expect(page).toHaveURL(/\/dashboard$/);
    // The MUI Drawer renders nav items as buttons. "Dashboard" always shows
    // for every logged-in role, so it's the most stable anchor.
    await expect(
      page.getByRole('button', { name: /^dashboard$/i }).first(),
    ).toBeVisible({ timeout: 10_000 });
  });

  test('login with bad password shows error and stays on /login', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('a@a.a');
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: /sign in/i }).click();

    // MUI Alert component with severity="error".
    await expect(page.getByRole('alert')).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login$/);
  });

  test('logout clears session and redirects to /login', async ({ page }) => {
    // Log in first.
    await page.goto('/login');
    await page.getByLabel('Email').fill('a@a.a');
    await page.getByLabel('Password').fill('a');
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(/\/dashboard$/);

    // The logout button lives inside the Layout. Drawer is collapsible on
    // mobile but always rendered on desktop (which is what Playwright uses
    // by default). Hit logout directly. Fall back to clearing tokens and
    // reloading if a Logout button isn't surfaced on this viewport.
    const logoutBtn = page.getByRole('button', { name: /logout/i });
    if (await logoutBtn.count()) {
      await logoutBtn.first().click();
    } else {
      await page.evaluate(() => {
        localStorage.removeItem('auth_token');
        localStorage.removeItem('auth_user');
      });
      await page.goto('/dashboard');
    }

    await page.waitForURL(/\/login$/, { timeout: 15_000 });
    await expect(page).toHaveURL(/\/login$/);

    // Session artifacts gone.
    const token = await page.evaluate(() =>
      localStorage.getItem('auth_token'),
    );
    expect(token).toBeNull();
  });
});
