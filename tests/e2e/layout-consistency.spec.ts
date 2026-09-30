/**
 * T064 (rewritten for F5) — E2E layout consistency across admin + portal pages.
 *
 * Per-category width assertions based on Content-Type Mapping:
 *   - [data-variant="table"]  → ≤ 1536px (96rem cap)
 *   - [data-variant="detail"] → 1152±4px (72rem pixel parity)
 *   - [data-variant="form"]   → 672±8px  (42rem)
 *
 * Also asserts every page has a h1 with font-size 30px (F4 typography scale).
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

// `/admin/users` is super-admin only under RBAC v2: a plain admin gets the
// "Page not available" detail page, which is the wrong container to measure.
const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;
const SEEDED_YEAR = process.env.E2E_SEEDED_PLAN_YEAR ?? '2026';
const SEEDED_PLAN_ID = process.env.E2E_SEEDED_PLAN_ID ?? 'diamond';

type Variant = 'table' | 'detail' | 'form';

const PAGES: Array<{ path: string; variant: Variant }> = [
  { path: '/admin', variant: 'detail' },
  { path: '/admin/account', variant: 'form' },
  { path: '/admin/users', variant: 'table' },
  { path: '/admin/plans', variant: 'table' },
  { path: '/admin/plans/new', variant: 'form' },
  { path: '/admin/plans/clone', variant: 'form' },
  { path: `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}`, variant: 'detail' },
  { path: `/admin/plans/${SEEDED_YEAR}/${SEEDED_PLAN_ID}/edit`, variant: 'form' },
  // The invoicing settings page is a detail page: several cards, not one
  // form column.
  { path: '/admin/settings/invoicing', variant: 'detail' },
];

// Spec 122 put page titles on the boards' step (`--font-size-h1`: 26px on
// phones, 32px from 640px, #435), so the h1 is read against the token in
// force at that h1 — see typography-scale.spec.ts for the same check.

function rangeFor(variant: Variant): [number, number] {
  switch (variant) {
    case 'table':
      return [0, 1536];
    case 'detail':
      return [1148, 1156];
    case 'form':
      return [664, 680];
  }
}

test.describe('F5 layout consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_SUPER_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('every admin page applies the correct container variant at 1440px', async ({ page }) => {
    // Nine routes plus the sign-in, each a possible Turbopack cold compile,
    // against Playwright's DEFAULT 30 s (playwright.config.ts sets no
    // `timeout`). That is what timed out on chromium while mobile-chrome —
    // running second, against a warm server — passed. 120 s is a real raise
    // here, not a copy of the default: do not "tidy" it back down.
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => {
      const p = new URL(u).pathname;
      return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
    });

    for (const { path, variant } of PAGES) {
      await page.goto(path);
      // No `networkidle`: it is unreliable behind Turbopack's on-demand
      // compile (see helpers/sign-in-landing.ts), and the h1 assertion
      // below already waits for the page to render.
      const h1 = page.getByRole('heading', { level: 1 }).first();
      await expect(h1, `${path} has h1`).toBeVisible();
      // Retry the probe. It appends a span to the h1 and reads back its
      // computed size; if React replaces the h1 mid-hydration the span is
      // detached before the read and the token comes back NaN. `networkidle`
      // used to hide that by waiting out hydration — at the cost of the 30 s
      // timeout this test kept hitting. Retrying is the cheap half.
      await expect(async () => {
        const { fontSize, token } = await h1.evaluate((el) => {
          const probe = document.createElement('span');
          probe.style.fontSize = 'var(--font-size-h1)';
          el.append(probe);
          const tokenPx = parseFloat(getComputedStyle(probe).fontSize);
          probe.remove();
          return { fontSize: parseFloat(getComputedStyle(el).fontSize), token: tokenPx };
        });
        expect(token, `${path} --font-size-h1 resolves`).toBeGreaterThan(0);
        expect(fontSize, `${path} h1 font-size`).toBeCloseTo(token, 0);
      }).toPass({ timeout: 15_000 });

      const container = page
        .locator(`[data-slot="layout-container"][data-variant="${variant}"]`)
        .first();
      await expect(container, `${path} has ${variant} container`).toBeVisible();

      const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
      const [lo, hi] = rangeFor(variant);
      expect(boxWidth, `${path} ${variant} container width must be in [${lo}, ${hi}]`).toBeGreaterThanOrEqual(lo);
      expect(boxWidth, `${path} ${variant} container width must be in [${lo}, ${hi}]`).toBeLessThanOrEqual(hi);
    }
  });
});
