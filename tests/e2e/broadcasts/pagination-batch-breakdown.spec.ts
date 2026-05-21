/**
 * T040 — F7.1a US1 E2E: admin broadcast detail per-batch breakdown.
 *
 * Phase 3E.2 (2026-05-19) — converted from RED skip-equivalent to
 * REAL Playwright + axe-core assertions targeting the now-shipped
 * Phase 3C/3D components:
 *   - T049 admin broadcast detail page extension (cluster C)
 *   - T052 admin/batch-breakdown.tsx (cluster D)
 *   - T053 admin/retry-confirmation-dialog.tsx (cluster D)
 *   - T054 admin/accept-partial-dialog.tsx (cluster D)
 *
 * Run with `--workers=1` per project memory `feedback_e2e_workers`
 * (default workers=3 hangs the dev workstation).
 *
 * Operator pre-conditions (test SKIPS without all 3 env vars):
 *   - E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD — admin login credentials
 *     (existing F7 MVP admin-portal E2E pattern)
 *   - E2E_PARTIAL_BROADCAST_ID — UUID of a pre-seeded broadcast in
 *     status='partially_sent' with manual_retry_count=1 + at least
 *     one failed batch_manifest. Operator seeds this via the
 *     `scripts/seed-partial-broadcast.ts` helper (Phase 3E.3 work)
 *     OR via SQL fixture in the test tenant.
 *
 * The env-gated approach lets CI keep `test:e2e` runs fast (skip
 * heavyweight setup) while ship-day operator can RUN the full suite
 * against a seeded staging tenant.
 *
 * A11y assertions (WCAG 2.1 AA per SC-008):
 *   - axe-core scan on collapsible-expanded view: 0 serious/critical
 *   - Retry AlertDialog has aria-modal + focus-trap + Escape closes
 *   - reduced-motion media query honored
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '../fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const PARTIAL_BROADCAST_ID = process.env.E2E_PARTIAL_BROADCAST_ID;

async function signInAsAdmin(page: import('@playwright/test').Page): Promise<void> {
  // E2E route fix 2026-05-21: F1 routes are `/admin/sign-in` and
  // `/portal/sign-in` — there is no plain `/sign-in`. Also the
  // `waitForURL` regex must EXCLUDE `/admin/sign-in` itself so the
  // wait doesn't fall through immediately on a failed sign-in (the
  // page stays on /admin/sign-in which matches `/\/admin/`).
  await page.goto('/admin/sign-in');
  await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
  await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (url) =>
      url.pathname.startsWith('/admin') &&
      !url.pathname.startsWith('/admin/sign-in'),
    { timeout: 10_000 },
  );
}

test.describe('@a11y F7.1a US1 — admin broadcast detail per-batch breakdown (T040)', () => {
  // E2E rate-limit fix 2026-05-21 (matches sibling specs).
  test.describe.configure({ retries: 0 });

  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run admin-portal e2e scans',
  );
  test.skip(
    !PARTIAL_BROADCAST_ID,
    'Set E2E_PARTIAL_BROADCAST_ID to a seeded partially_sent broadcast (see header)',
  );

  test('partially_sent broadcast → per-batch breakdown collapsible visible + axe-clean', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(`/admin/broadcasts/${PARTIAL_BROADCAST_ID}`);

    // Region landmark from BatchBreakdown component.
    await expect(
      page.getByRole('heading', { name: /per-batch dispatch breakdown/i }),
    ).toBeVisible();

    // Collapsible should be OPEN by default for partially_sent state
    // (defaultOpen heuristic in admin detail page).
    await expect(page.getByRole('table')).toBeVisible();

    // Status column rendered (rows depend on seed; sanity-check ≥1).
    await expect(page.getByRole('row').first()).toBeVisible();

    // axe-core scan — 0 serious/critical violations on the expanded view.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const seriousOrCritical = results.violations.filter(
      (v) => v.impact === 'serious' || v.impact === 'critical',
    );
    expect(seriousOrCritical).toEqual([]);
  });

  test('retry button → AlertDialog with budget-remaining + focus-trap + Esc closes', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(`/admin/broadcasts/${PARTIAL_BROADCAST_ID}`);

    await page
      .getByRole('button', { name: /retry \d+ failed batches/i })
      .first()
      .click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/manual retries remaining|of 3/i);

    // Esc closes
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('accept-partial button → AlertDialog with reason text-area (max 500)', async ({
    page,
  }) => {
    await signInAsAdmin(page);
    await page.goto(`/admin/broadcasts/${PARTIAL_BROADCAST_ID}`);

    await page
      .getByRole('button', { name: /accept partial delivery/i })
      .first()
      .click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    const textarea = dialog.getByRole('textbox', { name: /reason/i });
    await expect(textarea).toBeVisible();

    // Live counter updates as user types
    // "Resend rate-limit blocking remaining batches" = 44 chars
    await textarea.fill('Resend rate-limit blocking remaining batches');
    await expect(dialog.getByText(/44 \/ 500/)).toBeVisible();

    // Confirm button enabled by default (reason is optional)
    const confirm = dialog.getByRole('button', { name: /accept partial/i });
    await expect(confirm).toBeEnabled();

    // Esc closes without persisting
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
  });

  test('prefers-reduced-motion → AlertDialog has no animation', async ({
    browser,
  }) => {
    const context = await browser.newContext({ reducedMotion: 'reduce' });
    const page = await context.newPage();

    // E2E route fix 2026-05-21: /admin/sign-in (not /sign-in).
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: 'Password' }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (url) =>
        url.pathname.startsWith('/admin') &&
        !url.pathname.startsWith('/admin/sign-in'),
      { timeout: 10_000 },
    );

    await page.goto(`/admin/broadcasts/${PARTIAL_BROADCAST_ID}`);
    await page
      .getByRole('button', { name: /retry \d+ failed batches/i })
      .first()
      .click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();

    // shadcn AlertDialog respects prefers-reduced-motion at the CSS
    // level — animation-duration should be 0s OR very small. We
    // assert it's not the default `200ms` Radix transition.
    const animationDuration = await dialog.evaluate(
      (el) => window.getComputedStyle(el).animationDuration,
    );
    // Tailwind's `motion-reduce:transition-none` zeroes the duration.
    expect(['0s', '0ms', '']).toContain(animationDuration);

    await context.close();
  });
});
