/**
 * T045 (016 PR 3, US1) — plain-admin persona on the ON leg (flag ON + Migration C).
 *
 * The independent test for US1 (spec §US1): once the RBAC v2 flag is ON and the
 * promotion has run, a demoted plain `admin` must 404 on the D4-narrowed staff
 * surfaces (users / audit / settings.invoicing / erasure-log) while every money
 * and member-read operation it always held still works. This is the falsifiable
 * proof that the cutover scoped admins DOWN without breaking day-to-day ops.
 *
 * ── PRECONDITIONS (why this suite skips by default) ─────────────────────────
 * These assertions are only meaningful on the ON leg with a FRESH plain admin:
 *   1. The dev server runs with `FEATURE_RBAC_V2=true`.
 *   2. Migration C has been applied on the dev branch (runbook § dev-branch step).
 *   3. `scripts/seed-e2e-user.ts` has been RE-RUN afterwards, so `E2E_ADMIN_*`
 *      is a plain admin again (Migration C promoted the old one to super_admin —
 *      without the reset this suite would silently sign in as a super_admin and
 *      assert the OPPOSITE of what it claims to prove).
 * The operator sets `E2E_RBAC_V2_ON=true` in the E2E env during the cutover
 * session (T051) to opt this suite in; otherwise it skips. Run:
 *   `pnpm test:e2e --grep "rbac-admin-persona" --workers=1`
 *
 * The retrofitted users-PAGE axe evidence lives in `rbac-super-admin-persona`
 * (T046) — a plain admin 404s on `/admin/users`, so it can never render the page
 * to scan. The task list assigned that axe scan to this persona; that is a
 * persona mismatch (the page is `users.manage` SA-only), corrected here.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const RBAC_V2_ON = process.env.E2E_RBAC_V2_ON === 'true';

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

/** The four D4-narrowed surfaces a plain admin loses at the flip (design §10). */
const DENIED_ROUTES = [
  '/admin/users',
  '/admin/audit',
  '/admin/settings/invoicing',
  '/admin/compliance/erasure-log',
] as const;

/** Surfaces a plain admin KEEPS — money + member reads (D3: admin retains these). */
const ALLOWED_ROUTES = ['/admin/invoices', '/admin/members', '/admin/renewals'] as const;

/**
 * A plain admin's denial is a `notFound()` (404), NOT a redirect — the (staff)
 * layout admits the admin (still staff), and the PAGE gate answers notFound.
 * Accept the dev RSC 200-with-not-found-marker or a prod strict 404, never 5xx.
 */
async function assertNotFound(page: Page, route: string): Promise<void> {
  const res = await page.context().request.get(route, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  expect(res.status(), `${route} must not 5xx`).toBeLessThan(500);
  expect([200, 404], `${route} must be a not-found, not a redirect`).toContain(res.status());
  expect(await res.text()).toMatch(
    /<meta\s+name="next-error"\s+content="not-found"|NEXT_HTTP_ERROR_FALLBACK;404/,
  );
}

async function assertReachable(page: Page, route: string): Promise<void> {
  const res = await page.context().request.get(route, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  expect(res.status(), `${route} must render for a plain admin`).toBeLessThan(400);
}

test.describe('T045 RBAC v2 — plain-admin persona (ON leg) @a11y', () => {
  test.skip(
    !ADMIN_EMAIL || !RBAC_V2_ON,
    'ON-leg suite: needs FEATURE_RBAC_V2=true + Migration C on dev + a FRESH E2E_ADMIN_* ' +
      '(re-run scripts/seed-e2e-user.ts), then set E2E_RBAC_V2_ON=true. See runbook §dev-branch.',
  );

  test.beforeEach(async ({ page }) => {
    await signInAsAdmin(page);
  });

  for (const route of DENIED_ROUTES) {
    test(`plain admin is 404'd on the D4-narrowed surface ${route}`, async ({ page }) => {
      await assertNotFound(page, route);
    });
  }

  for (const route of ALLOWED_ROUTES) {
    test(`plain admin still reaches ${route} (money/member ops untouched)`, async ({ page }) => {
      await assertReachable(page, route);
    });
  }

  test('the sidebar offers no link a plain admin cannot open (T062, visible ≡ permitted)', async ({
    page,
    isMobile,
  }) => {
    // Desktop rail only — on mobile the nav lives in a CLOSED Sheet, so any
    // link assertion there is vacuous (idiom: nav-a11y.spec.ts:124).
    test.skip(isMobile === true, 'Desktop rail only — mobile renders the nav in a Sheet');

    // PR 3 gated the PAGES and left the nav filtering on role literals, so a
    // plain admin still SAW the four D4-narrowed links and only discovered they
    // were dead on click. T063 made the sidebar declarative — each entry now
    // carries the same permission its target page guards on, evaluated server-
    // side — so those links are gone, and this asserts the property T062 asks
    // for: everything the sidebar offers actually opens.
    //
    // Route-by-route reachability is already covered by the DENIED_ROUTES /
    // ALLOWED_ROUTES cases above; what is only observable HERE is what the
    // rendered navigation contains.
    await page.goto('/admin/renewals', { waitUntil: 'domcontentloaded' });
    const nav = page.getByRole('navigation').first();
    await expect(nav).toBeVisible();

    for (const denied of DENIED_ROUTES) {
      await expect(
        nav.locator(`a[href="${denied}"]`),
        `${denied} is denied to a plain admin — the sidebar must not offer it`,
      ).toHaveCount(0);
    }
    for (const allowed of ALLOWED_ROUTES) {
      await expect(
        nav.locator(`a[href="${allowed}"]`),
        `${allowed} is permitted — hiding it would strand a reachable feature`,
      ).toHaveCount(1);
    }
  });

  test('axe-core WCAG 2.1/2.2 AA — a reachable admin surface has no violations', async ({
    page,
  }) => {
    // The users PAGE axe evidence is in T046 (super_admin) — a plain admin can
    // never render it. Scan an admin-reachable surface to prove PR 3 introduced
    // no a11y regression on the pages this persona DOES see.
    await page.goto('/admin/invoices', { waitUntil: 'domcontentloaded' });
    const results = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
    expect(results.violations).toEqual([]);
  });
});
