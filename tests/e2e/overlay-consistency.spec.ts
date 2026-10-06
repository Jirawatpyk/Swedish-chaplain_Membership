/**
 * T085 — E2E: F4 SC-014 overlay consistency (Card).
 *
 * SC-014 (`specs/004-page-layout-standard/spec.md:266`) asks that cards across
 * all pages have identical padding, radius and shadow. Spec 122 is migrating
 * the card surface one module at a time, so "all pages" currently spans TWO
 * implementations, measured on 2026-10-02 against the dev server:
 *
 *   AURA   `.aura-card`          padding 24px / 24px   radius 20px  shadow 0 1px 2px rgba(0,0,0,.05)
 *   legacy `[data-slot="card"]`  padding 24px /  0px   radius 12px  shadow none (ring only)
 *
 * The legacy radius is 12px because `--card-radius` resolves through
 * `--radius-lg` → `--radius` → `--aura-radius-md`, while AURA's own card uses
 * `--aura-card-radius` (20px); the side padding differs because the legacy Card
 * puts `py-` on itself and leaves the inline padding to CardHeader/CardContent.
 *
 * So this test measures the pages that have ALREADY migrated and asserts they
 * agree with each other. Add a page here as its module migrates; when 122 US13
 * deletes `src/components/ui/card.tsx` the two sets collapse into one and the
 * remaining admin pages (`/admin`, `/admin/account`, `/admin/invoices`) can
 * join the list (`/admin/events` joined with 122 US9a). The
 * cross-implementation drift is a tracked open item, not something for this test to assert as correct — an
 * expectation that the two differ would turn red the day US13 fixes it.
 *
 * It also no longer probes `/admin/users`: `users.manage` is `superAdminOnly`
 * (`permission-catalogue.ts:95`), so since 016 RBAC v2 that route renders
 * "Page not available" for the e2e `admin` persona and has no card at all.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

/** Admin pages whose cards are AURA's as of 122 US9a. */
const AURA_CARD_ROUTES = ['/admin/plans', '/admin/directory', '/admin/renewals', '/admin/events'] as const;

test.describe('F4 SC-014 — overlay consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('migrated cards share one padding, radius and elevation', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    });

    const measure = async (path: string) => {
      await page.goto(path);
      // `:visible`, not `.first()`: Next keeps the previous segment's DOM in the
      // tree (hidden) after a client nav, and this walks several routes.
      const card = page.locator('.aura-card:visible').first();
      await card.waitFor();
      return card.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          paddingTop: cs.paddingTop,
          paddingLeft: cs.paddingLeft,
          borderRadius: cs.borderRadius,
          boxShadow: cs.boxShadow,
        };
      });
    };

    const [first, ...rest] = AURA_CARD_ROUTES;
    const baseline = await measure(first);

    for (const route of rest) {
      const seen = await measure(route);
      expect(seen.paddingTop, `${route} vs ${first} padding-top`).toBe(baseline.paddingTop);
      expect(seen.paddingLeft, `${route} vs ${first} padding-left`).toBe(baseline.paddingLeft);
      expect(seen.borderRadius, `${route} vs ${first} radius`).toBe(baseline.borderRadius);
      expect(seen.boxShadow, `${route} vs ${first} elevation`).toBe(baseline.boxShadow);
    }

    // The tokens must actually resolve. A stylesheet that failed to load gives
    // every page padding 0 and radius 0, which "they all match" alone accepts.
    expect(parseFloat(baseline.paddingTop), 'card padding resolves').toBeGreaterThan(0);
    expect(parseFloat(baseline.paddingLeft), 'card inline padding resolves').toBeGreaterThan(0);
    expect(baseline.borderRadius, 'card radius resolves').not.toBe('0px');
    expect(baseline.boxShadow, 'card has elevation').not.toBe('none');
  });
});
