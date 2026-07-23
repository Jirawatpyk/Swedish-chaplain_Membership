/**
 * E2E round-trip for the "needs portal invite" filter chip
 * (057-members-portal-status, Task 12).
 *
 * Guards the URL/aria-pressed round-trip that a component test can't reach:
 * clicking the chip must set `?portal=needs_invite`, flip `aria-pressed` to
 * `true`, and keep the chip mounted even if the filtered result is zero rows
 * (see `directory-filters.tsx`'s `showChip` — `portalActive` keeps it
 * visible independent of the count). Clear must strip the `portal` param.
 *
 * The chip may legitimately be absent in this environment if the seeded dev
 * tenant has zero members needing an invite AND the count read cleanly (not
 * `null`) — `showChip` only renders it when there's work, the filter is
 * already on, or the count is unavailable. This spec does not seed data (a
 * URL round-trip test, not a data-shape test) and skips gracefully in that
 * case, exactly like `members-table-overflow.spec.ts`'s seed-unavailable
 * skip.
 *
 * `/admin/members` streams its filter bar behind a Suspense skeleton
 * (`loading.tsx` shimmer — see `members-table-overflow.spec.ts` for the
 * same `waitForLoadState('networkidle')` need) while `portalInviteCount`
 * resolves server-side, so `page.goto()`'s default `load` wait can
 * complete before the real chip replaces the skeleton. Without the
 * `networkidle` wait below this reads as "chip not visible" and
 * self-skips even when there IS invite-needing data — confirmed via a
 * live probe: the skeleton (`data-slot="skeleton"`) is still in the DOM
 * at the moment `chip.isVisible()` would otherwise be checked.
 *
 * Dev-profiler pageerror (DEV-ONLY noise — NARROW scoped opt-out below,
 * copied verbatim from `members-table-overflow.spec.ts`): under `next dev`,
 * navigating `/admin/members` deterministically trips React's dev
 * component-performance profiler (`flushComponentPerformance`), which
 * throws a `Performance.measure` `TypeError` unrelated to this spec's
 * filter-chip assertions. It reproduces on WebKit (`mobile-safari`) only,
 * where the shared `../fixtures` pageerror auto-fail would otherwise treat
 * it as a genuine client crash. See that spec's header comment for the full
 * explanation of why the narrow pattern (not the blanket ignore) is safe.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe('members directory — needs-invite chip', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD');

  // Scope the dev-profiler pageerror opt-out to THIS spec's worker process —
  // see the header note. Restoring (not deleting) the prior value in
  // afterAll prevents leaking into other specs sharing the same
  // `--workers=1` process.
  let prevPageErrorIgnorePattern: string | undefined;
  test.beforeAll(() => {
    prevPageErrorIgnorePattern = process.env.E2E_PAGEERROR_IGNORE_PATTERN;
    process.env.E2E_PAGEERROR_IGNORE_PATTERN = 'flushComponentPerformance';
  });
  test.afterAll(() => {
    if (prevPageErrorIgnorePattern === undefined) {
      delete process.env.E2E_PAGEERROR_IGNORE_PATTERN;
    } else {
      process.env.E2E_PAGEERROR_IGNORE_PATTERN = prevPageErrorIgnorePattern;
    }
  });

  test('filters, survives a zero count, and Clear strips the param', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');

    const chip = page.getByRole('button', { name: /needs portal invite/i });
    test.skip(!(await chip.isVisible()), 'no members need an invite in this environment');

    await chip.click();
    await expect(page).toHaveURL(/portal=needs_invite/);
    await expect(chip).toHaveAttribute('aria-pressed', 'true');

    // The chip must still be present while the filter is on, even at zero.
    await expect(chip).toBeVisible();

    await page.getByRole('button', { name: /clear/i }).click();
    await expect(page).not.toHaveURL(/portal=/);
  });
});
