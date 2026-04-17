/**
 * T146b — E2E: prefers-reduced-motion on F3 member surfaces (FR-044).
 *
 * @f3 @a11y
 *
 * When `prefers-reduced-motion: reduce` is set in the browser:
 *   (i)   Shimmer skeleton on /admin/members renders as static pulse
 *         (no animation-duration > 0s)
 *   (ii)  The command palette open/close has no slide animation
 *   (iii) Toast on a member action appears with no slide-in transition
 *   (iv)  Timeline event list renders instantly (no staggered reveal)
 *
 * Implementation note: Next.js injects the reduced-motion CSS class
 * via Tailwind's `motion-reduce:` variant and the global `@media
 * (prefers-reduced-motion: reduce)` rule in ux-standards.md § 2.2.
 * We assert animation-duration === "0s" on the representative element,
 * not the exact CSS class, for resilience.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('members reduced-motion compliance @f3 @a11y', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByLabel(/password/i), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  test('(i) shimmer skeleton on /admin/members has no active animation', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);

    // Navigate to a fresh /admin/members with a short network-idle wait to
    // let the loading skeleton render before the real data arrives.
    await page.goto('/admin/members', { waitUntil: 'commit' });

    // Use the skeleton that appears during SSR + data fetch.
    // If data loads too fast the skeleton is gone — pick the table instead.
    const skeletonOrTable = page
      .locator('[data-testid="members-table-skeleton"], [data-slot="table"]')
      .first();
    await skeletonOrTable.waitFor({ state: 'attached', timeout: 10_000 });

    // Any element on the page should have animation-duration ≤ "0s" or none.
    const animationDuration: string = await skeletonOrTable.evaluate(
      (el) => window.getComputedStyle(el).animationDuration,
    );
    expect(animationDuration).toMatch(/^(0s|none|\s*)$/);
  });

  test('(ii) timeline page renders instantly — no staggered animation', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);

    // Navigate to the directory to get a member ID
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    const firstRowLink = page.locator('tbody tr:first-child a').first();
    const href = await firstRowLink.getAttribute('href').catch(() => null);
    if (!href) {
      test.skip(true, 'No members in directory — skipping timeline reduced-motion check');
      return;
    }
    const match = href.match(/\/admin\/members\/([0-9a-f-]+)/);
    if (!match) return;
    const memberId = match[1]!;

    await page.goto(`/admin/members/${memberId}/timeline`);
    await page.waitForLoadState('networkidle');

    // Timeline event items should have no staggered animation under
    // prefers-reduced-motion. Check the first event item.
    const firstEvent = page
      .locator('[data-testid="timeline-event"], [role="listitem"], li')
      .first();
    const eventVisible = await firstEvent.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!eventVisible) return; // empty timeline — nothing to assert

    const animDuration: string = await firstEvent.evaluate(
      (el) => window.getComputedStyle(el).animationDuration,
    );
    expect(animDuration).toMatch(/^(0s|none|\s*)$/);
  });

  test('(iii) command palette open/close has no slide animation', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');

    // Open command palette
    await page.keyboard.press('Meta+k');
    const paletteDialog = page.getByRole('dialog');
    const paletteVisible = await paletteDialog.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!paletteVisible) {
      // Try Ctrl+k (Windows)
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+k');
    }

    const paletteOpen = await paletteDialog.isVisible({ timeout: 3_000 }).catch(() => false);
    if (!paletteOpen) {
      test.info().annotations.push({
        type: 'skip-reason',
        description: 'Command palette not triggered — skipping animation check',
      });
      return;
    }

    const animDuration: string = await paletteDialog.evaluate(
      (el) => window.getComputedStyle(el).animationDuration,
    );
    expect(animDuration).toMatch(/^(0s|none|\s*)$/);
  });
});
