/**
 * T062 (016 PR 4, US4) — four-persona navigation walk on the ON leg.
 *
 * The property under test is **visible ≡ permitted**: everything the staff
 * sidebar offers a persona actually opens for that persona, and the surfaces
 * their bundle excludes are not offered at all.
 *
 * Both halves matter and they fail differently:
 *  - offered-but-denied is a dead link. Until T063 the nav filtered on three
 *    hand-maintained role arrays, so after the D4 narrowing a plain admin was
 *    shown four links their own page guard refused — a defect that shipped with
 *    the cutover and was found by hand.
 *  - permitted-but-hidden is a stranded feature. Nobody reports it, because
 *    from the user's side it simply does not exist.
 *
 * Deliberately BLACK-BOX. The walk reads the hrefs the app actually rendered
 * and then follows each one; it does not import `staffNavConfig` or
 * `ROLE_BUNDLES`. A spec that re-derived the expected set from the same config
 * the page renders from would agree with any config, including a wrong one —
 * `tests/unit/nav/nav-permission-parity.test.ts` is the source-vs-source check,
 * and this is the does-it-actually-work check.
 *
 * The MUST_NOT_SEE lists are frozen literals for the same reason.
 *
 * Preconditions: FEATURE_RBAC_V2=true + Migration C applied on the dev branch +
 * `scripts/seed-e2e-user.ts` re-run (mints all four personas), then
 * `E2E_RBAC_V2_ON=true`. Run:
 *   `pnpm test:e2e --grep "rbac-navigation" --workers=1`
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin, signInAsSuperAdmin } from './helpers/admin-session';
import { signInAsManager } from './helpers/manager-session';
import { signInAsMarketing } from './helpers/marketing-session';

const RBAC_V2_ON = process.env.E2E_RBAC_V2_ON === 'true';
const HAVE_PERSONAS = Boolean(
  process.env.E2E_SUPER_ADMIN_EMAIL &&
    process.env.E2E_ADMIN_EMAIL &&
    process.env.E2E_MANAGER_EMAIL &&
    process.env.E2E_MARKETING_EMAIL,
);

/**
 * Surfaces each persona's bundle excludes. Frozen literals, NOT derived — the
 * point is to state independently what the design says, so a bundle edit that
 * widens access has to come here and be argued for.
 *
 * `super_admin` has no entry: it holds every key, so a MUST_NOT_SEE list for it
 * would be empty and the case vacuous.
 */
const MUST_NOT_SEE: Readonly<Record<string, readonly string[]>> = {
  // D4 moved these four to super-admin-only.
  admin: [
    '/admin/users',
    '/admin/audit',
    '/admin/settings/invoicing',
    '/admin/compliance/erasure-log',
  ],
  // All FOUR settings pages, not just the two that were admin-only pre-016:
  // `settings.invoicing` went super-admin-only (D4) and
  // `settings.renewal_schedules` is not in the manager bundle either, so the
  // manager's OFF-leg read-only view of both is gone on the ON leg. This is the
  // list design § 10 pins, and it is wider than the pre-016 shape.
  manager: [
    '/admin/users',
    '/admin/audit',
    '/admin/compliance/erasure-log',
    '/admin/settings/invoicing',
    '/admin/settings/renewals/schedules',
    '/admin/settings/broadcasts',
    '/admin/settings/integrations/eventcreate',
  ],
  marketing: [
    '/admin/invoices',
    '/admin/credit-notes',
    '/admin/renewals',
    '/admin/plans',
    '/admin/directory',
    '/admin/users',
    '/admin/audit',
    '/admin/compliance/erasure-log',
    '/admin/settings/invoicing',
    '/admin/settings/renewals/schedules',
    '/admin/settings/broadcasts',
    '/admin/settings/integrations/eventcreate',
  ],
};

/** Every href the rendered staff sidebar offers, de-duplicated. */
async function sidebarHrefs(page: Page): Promise<readonly string[]> {
  const nav = page.getByRole('navigation').first();
  await expect(nav).toBeVisible();
  const hrefs = await nav
    .locator('a[href^="/admin"]')
    .evaluateAll((els: Element[]) => els.map((el) => el.getAttribute('href') ?? ''));
  return [...new Set(hrefs.filter(Boolean))];
}

/**
 * A staff page that RENDERED for this persona — not a `notFound()` and not a
 * redirect back to sign-in.
 *
 * Asserted at the HTTP level rather than by looking for a heading: the pages
 * differ too much for one selector, and a heading-based check would silently
 * pass on any page that happens to have an <h1> — including the 404 shell.
 */
async function assertOpens(page: Page, href: string): Promise<void> {
  const res = await page.context().request.get(href, {
    failOnStatusCode: false,
    maxRedirects: 0,
  });
  const status = res.status();
  expect(status, `${href} returned ${status}`).toBeLessThan(400);
  const body = await res.text();
  // The dev RSC response can be a 200 that CARRIES the not-found marker, so a
  // status check alone is not enough (idiom: rbac-admin-persona.spec.ts).
  expect(body, `${href} rendered the not-found shell`).not.toContain(
    'NEXT_HTTP_ERROR_FALLBACK;404',
  );
}

const PERSONAS = [
  { name: 'super_admin', signIn: signInAsSuperAdmin },
  { name: 'admin', signIn: signInAsAdmin },
  { name: 'manager', signIn: signInAsManager },
  { name: 'marketing', signIn: signInAsMarketing },
] as const;

test.describe('T062 RBAC v2 — four-persona navigation walk (ON leg)', () => {
  test.skip(
    !HAVE_PERSONAS || !RBAC_V2_ON,
    'ON-leg suite: needs FEATURE_RBAC_V2=true + Migration C on dev + all four ' +
      'E2E persona credentials (re-run scripts/seed-e2e-user.ts), then E2E_RBAC_V2_ON=true.',
  );

  for (const persona of PERSONAS) {
    test.describe(persona.name, () => {
      test.beforeEach(async ({ page }) => {
        await persona.signIn(page);
      });

      test('every sidebar link opens — no dead links', async ({ page, isMobile }) => {
        // Desktop rail only: on mobile the nav lives in a CLOSED Sheet, so the
        // links are not in the DOM and the walk would be vacuous
        // (idiom: nav-a11y.spec.ts:124).
        test.skip(isMobile === true, 'Desktop rail only — mobile renders the nav in a Sheet');
        // super_admin walks all 16 surfaces, and in dev each first hit pays a
        // Turbopack cold compile. That legitimately exceeds the 30s default —
        // observed as a flake on the first run of this suite. The budget is for
        // COMPILATION, not for the app being slow; the per-request assertions
        // below are unchanged.
        test.setTimeout(180_000);

        await page.goto('/admin', { waitUntil: 'domcontentloaded' });
        const hrefs = await sidebarHrefs(page);

        // A persona whose sidebar collapsed to nothing would pass the loop
        // below without executing it. Every staff role holds `dashboard.view`,
        // so the sidebar is never empty.
        expect(hrefs.length, `${persona.name} sees an empty sidebar`).toBeGreaterThan(0);

        for (const href of hrefs) {
          await assertOpens(page, href);
        }
      });

      test('the sidebar offers nothing this persona is denied', async ({ page, isMobile }) => {
        test.skip(isMobile === true, 'Desktop rail only — mobile renders the nav in a Sheet');
        const denied = MUST_NOT_SEE[persona.name];
        test.skip(denied === undefined, 'super_admin holds every key — nothing to deny');

        await page.goto('/admin', { waitUntil: 'domcontentloaded' });
        const hrefs = await sidebarHrefs(page);
        for (const href of denied!) {
          expect(hrefs, `${persona.name} must not be offered ${href}`).not.toContain(href);
        }
      });

      test('landing invariant — /admin renders the dashboard, never a denial', async ({
        page,
      }) => {
        // Every staff role holds `dashboard.view`, so the shared landing page
        // must render for all four. A persona that lands on a 404 cannot use
        // the product at all, which is the failure mode the pre-mint step (D18)
        // exists to prevent for super_admin and which a bundle edit could
        // reintroduce for any other role.
        await page.goto('/admin', { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(/\/admin\/?$/);
        await assertOpens(page, '/admin');
      });
    });
  }

  /**
   * Design § 10 pins the manager's denied set explicitly, so it is asserted by
   * DIRECT URL as well as by absence from the nav. The two are different
   * claims: the nav check proves the affordance is gone, this proves the door
   * is locked. A regression that only restored the link would pass the second;
   * a regression that only opened the guard would pass the first.
   */
  test.describe('manager direct-URL denials (design § 10)', () => {
    test.beforeEach(async ({ page }) => {
      await signInAsManager(page);
    });

    for (const route of [
      '/admin/users',
      '/admin/audit',
      '/admin/settings/invoicing',
      '/admin/settings/renewals/schedules',
      '/admin/settings/broadcasts',
      '/admin/settings/integrations/eventcreate',
    ]) {
      test(`manager is denied ${route} by direct URL`, async ({ page }) => {
        const res = await page.context().request.get(route, {
          failOnStatusCode: false,
          maxRedirects: 0,
        });
        // A plain denial is `notFound()` (404), not a redirect: the (staff)
        // layout admits the manager — they ARE staff — and the PAGE gate
        // answers. Accept the dev RSC 200-with-marker or a strict 404, never a
        // 5xx and never a rendered page.
        const status = res.status();
        expect(status, `${route} returned ${status}`).toBeLessThan(500);
        if (status === 200) {
          expect(await res.text(), `${route} rendered for a manager`).toContain(
            'NEXT_HTTP_ERROR_FALLBACK;404',
          );
        } else {
          expect(status).toBe(404);
        }
      });
    }
  });
});
