/**
 * A/B eval e2e — partner logs in, picks a winner on one doc, then checks the
 * report page. Partner auth isolation matters because evaluator_user_id is
 * used in the aggregate report.
 *
 * Skips gracefully when no eligible items exist — the staging worker may
 * still be crunching VLM extractions.
 */

import { test, expect, request as pwRequest } from '@playwright/test';

test.describe('ab eval (partner)', () => {
  test('pick a winner and verify the report increments', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL!;
    // Grab a partner token for the pre-check. Signing in via the page
    // already happened in global-setup — partner storageState loads auto.
    const api = await pwRequest.newContext({ baseURL: url });
    const loginRes = await api.post('/api/auth/login', {
      data: { email: 'p@p.p', password: 'p' },
    });
    const { token } = (await loginRes.json()) as { token: string };
    const auth = { Authorization: `Bearer ${token}` };

    // Fetch the report up front so we can assert it went up by one.
    const reportBefore = await api
      .get('/api/eval/report', { headers: auth })
      .then((r) => r.json() as Promise<{ totals?: { evaluated?: number } }>)
      .catch(() => ({ totals: { evaluated: 0 } }));
    const countBefore = reportBefore.totals?.evaluated ?? 0;

    // Check if anything is available to evaluate.
    const nextRes = await api.get('/api/eval/next', { headers: auth });
    const nextBody = (await nextRes.json()) as {
      item?: { id: string } | null;
    };
    test.skip(
      !nextBody.item,
      'No eligible A/B eval items on staging — skipping.',
    );
    if (!nextBody.item) return;

    // Go to /eval and wait for the Method cards.
    await page.goto('/eval');
    await expect(page.getByText(/method a/i).first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText(/method b/i).first()).toBeVisible();

    // Optional comment so we know the submit payload was fully formed.
    const comment = page.getByPlaceholder(/why\?/i);
    if (await comment.count()) {
      await comment.fill('e2e test: picking A deterministically');
    }

    // Pick "A wins". The button label is "A wins" (plus an ICON via MUI).
    const pickA = page.getByRole('button', { name: /^a wins$/i });
    await expect(pickA).toBeEnabled({ timeout: 5_000 });
    await pickA.click();

    // Auto-advance should either: (a) load the next item (cards reappear),
    // (b) show an "all caught up" empty state, or (c) leave us on /eval
    // with the method cards replaced. Any of those means the submit
    // succeeded without a network error.
    await page.waitForTimeout(2_000);
    // Now hit the report.
    await page.goto('/eval/report');
    await expect(
      page.getByRole('heading', { name: /eval|report/i }).first(),
    ).toBeVisible({ timeout: 15_000 });

    // Verify the API side shows the count ticked up by at least one.
    const reportAfter = await api
      .get('/api/eval/report', { headers: auth })
      .then((r) => r.json() as Promise<{ totals?: { evaluated?: number } }>)
      .catch(() => ({ totals: { evaluated: 0 } }));
    const countAfter = reportAfter.totals?.evaluated ?? 0;
    expect(countAfter).toBeGreaterThanOrEqual(countBefore + 1);

    await api.dispose();
  });
});
