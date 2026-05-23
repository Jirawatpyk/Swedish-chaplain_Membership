/**
 * P2.1 — E2E net: inline-edit SAVE path in a real browser @f3.
 *
 * The component test (inline-edit-cells.test.tsx) covers edit-mode entry,
 * the synchronous onSave args/count, and the race guards deterministically
 * — but it cannot exercise the full async round-trip (PATCH → router.refresh
 * → re-render) the way a real browser does. This spec is the real-stack
 * regression net for the `useInlineEditField` hook extraction:
 *
 *   1. country: double-click → type → Enter → success toast (server saved)
 *   2. country: Escape cancels — no save toast
 *
 * Non-destructive: the country edit is reverted via an authenticated API
 * PATCH in a `finally` block, so seed data is unchanged regardless of UI
 * refresh timing (a UI revert risks a stale-prop no-op leaving the change
 * committed).
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const BASE = 'http://localhost:3100';

async function signIn(page: Page): Promise<void> {
  await clearE2ERateLimits();
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
  await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    },
    { timeout: 15_000 },
  );
}

/** Revert a member's field via the authenticated inline-edit API. */
async function revertField(
  page: Page,
  memberId: string,
  field: 'country' | 'notes',
  value: string | null,
): Promise<void> {
  await page.request.patch(`${BASE}/api/members/${memberId}/inline-edit`, {
    headers: {
      'Content-Type': 'application/json',
      // Same-origin Origin header to satisfy the CSRF allow-list, plus a
      // fresh idempotency key (mirrors the UI fetch in directory-with-bulk).
      Origin: BASE,
      'Idempotency-Key': crypto.randomUUID(),
    },
    data: { field, value },
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('inline-edit save path @f3', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
  });

  test('country: double-click → type → Enter saves (toast), then reverts', async ({
    page,
  }) => {
    const editButtons = page.getByRole('button', { name: /edit country/i });
    const count = await editButtons.count();
    test.skip(count === 0, 'No editable member rows in the directory');

    // Resolve the first row's memberId from its detail link (for revert).
    const href = await page
      .getByRole('link', { name: /^open /i })
      .first()
      .getAttribute('href');
    const memberId = href?.split('/').pop() ?? '';
    expect(memberId, 'could not resolve first-row memberId').toMatch(
      /[0-9a-f-]{36}/i,
    );

    await editButtons.first().dblclick();
    const input = page.getByRole('textbox', { name: /country code/i });
    await expect(input).toBeVisible({ timeout: 5_000 });
    const original = (await input.inputValue()).trim().toUpperCase();
    const next = original === 'SE' ? 'TH' : 'SE';

    try {
      await input.fill(next);
      await input.press('Enter');
      // The success toast only fires on a server 200 → proof the save
      // committed end-to-end (PATCH → use-case → DB).
      await expect(page.getByText(/country updated/i)).toBeVisible({
        timeout: 8_000,
      });
      // Edit mode closes on success.
      await expect(
        page.getByRole('textbox', { name: /country code/i }),
      ).toBeHidden({ timeout: 5_000 });
    } finally {
      // Deterministic revert regardless of UI refresh timing.
      if (original) await revertField(page, memberId, 'country', original);
    }
  });

  test('country: Escape cancels — no save toast', async ({ page }) => {
    const editButtons = page.getByRole('button', { name: /edit country/i });
    test.skip((await editButtons.count()) === 0, 'No editable member rows');

    await editButtons.first().dblclick();
    const input = page.getByRole('textbox', { name: /country code/i });
    await expect(input).toBeVisible({ timeout: 5_000 });
    const original = (await input.inputValue()).trim().toUpperCase();

    await input.fill(original === 'SE' ? 'TH' : 'SE');
    await input.press('Escape');

    // Edit mode closes and NO success toast appears (nothing was saved).
    await expect(
      page.getByRole('textbox', { name: /country code/i }),
    ).toBeHidden({ timeout: 5_000 });
    await expect(page.getByText(/country updated/i)).toHaveCount(0);
  });
});
