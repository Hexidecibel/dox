/**
 * Smart-upload e2e — drives the `/import` page through the queue-only flow:
 * pick a tenant (super_admin sees a selector), drop a PDF, hit Process, and
 * confirm the backend queue has the item. The Import page is fire-and-forget;
 * Stage 2 shows "N documents queued" and links out to the Review Queue, so we
 * stop here rather than waiting for the Qwen worker to finish on staging.
 *
 * Cleans up its own queue item via DELETE so reruns are idempotent.
 */

import { test, expect, request as pwRequest } from '@playwright/test';
import { readFileSync } from 'fs';
import { join } from 'path';

const SAMPLE_PDF = join(__dirname, 'fixtures', 'sample-coa.pdf');
const TENANT_ID = 'default';

async function getAdminToken(baseURL: string): Promise<string> {
  const api = await pwRequest.newContext({ baseURL });
  const res = await api.post('/api/auth/login', {
    data: { email: 'a@a.a', password: 'a' },
  });
  if (!res.ok()) {
    throw new Error(`admin login failed: ${res.status()}`);
  }
  const body = (await res.json()) as { token: string };
  await api.dispose();
  return body.token;
}

test.describe('smart upload', () => {
  test('uploading a PDF queues it for processing', async ({
    page,
    baseURL,
  }) => {
    const url = baseURL!;
    const pre = await pwRequest.newContext({ baseURL: url });
    const token = await getAdminToken(url);

    // Snapshot queue IDs before so we can pick out the new one.
    const beforeRes = await pre.get(`/api/queue?tenant_id=${TENANT_ID}&status=all&limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const before = (await beforeRes.json()) as { items: Array<{ id: string; file_name: string }> };
    const priorIds = new Set(before.items.map((i) => i.id));

    // Go to Import.
    await page.goto('/import');
    await page.waitForLoadState('networkidle').catch(() => {});

    // Super admin: the Import page renders its own Tenant Select that
    // gates the Process button. The Layout drawer also has a Tenant Filter
    // Select with the same ARIA label, which makes role-based targeting
    // ambiguous. Rather than fight MUI's portal-rendered listbox, we use
    // a `page.locator(role="main")` scoped combobox and drive it with
    // keyboard — space/arrow/enter is much more stable than click+portal.
    const main = page.getByRole('main');
    const pageTenantSelect = main.getByRole('combobox').first();
    await pageTenantSelect.waitFor({ state: 'visible', timeout: 10_000 });
    await pageTenantSelect.focus();
    // Space opens the MUI Select; ArrowDown highlights the first option;
    // Enter commits the selection.
    await page.keyboard.press(' ');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    // Attach the fixture to the hidden <input type="file">. The dropzone
    // wraps a hidden input; setInputFiles doesn't need a click.
    const fileChooser = page.locator('input[type="file"]');
    await fileChooser.setInputFiles(SAMPLE_PDF);

    // Click the big Process button.
    const processBtn = page.getByRole('button', { name: /^process/i });
    await expect(processBtn).toBeEnabled({ timeout: 5_000 });
    await processBtn.click();

    // Wait for the Stage-2 confirmation.
    await expect(
      page.getByText(/queued for processing/i),
    ).toBeVisible({ timeout: 20_000 });

    // Poll the queue API for the new item (matching by file_name).
    const matchName = 'sample-coa.pdf';
    let newItemId: string | null = null;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const res = await pre.get(
        `/api/queue?tenant_id=${TENANT_ID}&status=all&limit=200`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await res.json()) as {
        items: Array<{ id: string; file_name: string }>;
      };
      const match = data.items.find(
        (i) => i.file_name === matchName && !priorIds.has(i.id),
      );
      if (match) {
        newItemId = match.id;
        break;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }

    expect(newItemId, 'queue item should appear within 20s').not.toBeNull();

    // Clean up by rejecting the queue item (no DELETE endpoint; reject moves
    // it out of the 'pending' status so it won't clutter the review list).
    const delRes = await pre.put(`/api/queue/${newItemId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      data: { status: 'rejected' },
    });
    // Accept 200 or 4xx — rejection may fail if the worker already
    // transitioned the item mid-test. The point is to try cleanup, not
    // to die if it's already gone.
    expect([200, 400, 404, 409]).toContain(delRes.status());

    await pre.dispose();
  });
});

// Keep readFileSync used above for future tests that inspect the fixture.
void readFileSync;
