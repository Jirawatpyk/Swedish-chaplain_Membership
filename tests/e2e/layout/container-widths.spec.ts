/**
 * F5 US1 + US2 + detail non-regression — E2E container width assertions.
 *
 * Populated across Phases 3-5:
 *   - TableContainer block (Phase 3, US1): 375/1280/1440/1920 px → ≤1536px cap
 *   - FormContainer block (Phase 4, US2):  375/1280/1440/1920 px → 720px (AURA narrow), at the start edge
 *   - DetailContainer block (Phase 5):      375/1440 px → 1280px (AURA default), or the content width below it
 *
 * Spec 122 (2 Oct 2026): the three containers are AURA's `Container` — form
 * `narrow` (720), detail and the portal column the default (1280), table our
 * own 1536 override; the staff forms sit at the page's start edge.
 *
 * In all cases we assert NO horizontal body scroll and the correct
 * `[data-variant]` is present.
 *
 * The form block exercises representative routes (`/admin/plans/new`,
 * `/portal/account`, `/portal/edit`, `/portal/contacts/invite`) to protect
 * SC-002 across categories — prior revision covered only one.
 *
 * Task-8 HIGH (settings-ux-invoice-reminders wave B) — `/admin/settings/
 * invoicing` moved OUT of the form block and into the detail block below:
 * its two-column sticky-nav shell now renders `DetailContainer`
 * (`data-variant="detail"`), not `FormContainer` (see
 * `docs/ux-standards.md` §18.2's documented exception row).
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';
import { assertNoHorizontalScroll, signInViaForm, waitForLayoutContainer } from '../helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
// The GOOD-STANDING member, not `E2E_MEMBER_EMAIL`. That persona is LAPSED, and
// a membership gate redirects it off /portal/edit, /portal/contacts/invite and
// /portal/profile to the portal home — so those three cases were measuring the
// home page's container, or failing to find one, instead of the page named in
// the test title.
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;

const VIEWPORTS_FULL = [375, 1280, 1440, 1920] as const;
const VIEWPORTS_DETAIL = [375, 1440] as const;

const ADMIN_FORM_ROUTES = ['/admin/plans/new'] as const;
/**
 * Portal pages that render a `FormContainer`, each with the band its own board
 * sets — they are NOT all the 720px staff form column.
 *
 * `/portal/account` and `/portal/contacts/invite` used to be listed here and
 * have been `DetailContainer` since 122 US3 (`570b8c3c6`): the account page is a
 * hub of independent forms, which `docs/ux-standards.md § 18.1` puts in
 * `DetailContainer`, and the invite page draws a 720px inner column inside the
 * portal frame (`portal/contacts/invite/page.tsx:18-19`, `tasks.md:159`). They
 * moved to `PORTAL_DETAIL_ROUTES`; asserting them as staff forms could never pass.
 */
const PORTAL_FORM_ROUTES = [
  // 880px content column (`portal/edit/page.tsx:212`) → 944 outer at desktop,
  // wider than the staff 720 by design.
  { route: '/portal/edit', min: 936, max: 952 },
] as const;
// Task-8 HIGH — /admin/settings/invoicing renders DetailContainer (its
// two-column sticky-nav shell), not FormContainer. See docs/ux-standards.md
// §18.2's documented exception row.
const ADMIN_DETAIL_ROUTES = ['/admin', '/admin/settings/invoicing'] as const;
/**
 * Portal detail pages: AURA's default `Container`, 1280px outer at 1440 like
 * the admin's (spec 122, 2 Oct 2026; the portal had its own 1200px content
 * column before).
 */
const PORTAL_DETAIL_ROUTES = [
  '/portal/profile',
  '/portal/account',
  '/portal/contacts/invite',
] as const;
/** AURA's `--aura-container-max` and `--aura-container-narrow`. */
const DETAIL_MAX = 1280;
const FORM_MAX = 720;

async function signInAdmin(page: Page): Promise<void> {
  await signInViaForm(page, '/admin/sign-in', ADMIN_EMAIL!, ADMIN_PASSWORD!, /^\/admin(\/|$)/);
}

async function signInMember(page: Page): Promise<void> {
  await signInViaForm(page, '/portal/sign-in', MEMBER_EMAIL!, MEMBER_PASSWORD!, /^\/portal(\/|$)/);
}

/**
 * The width a full-bleed container can actually occupy: its parent's content
 * box. `globals.css` sets `html { scrollbar-gutter: stable }` (F8 #24,
 * 2026-05-11), so the browser reserves ~15 px for the scrollbar column and a
 * full-bleed container measures 360 px inside a 375 px viewport, not 375 —
 * and `documentElement.clientWidth` still reports 375, so it is not the right
 * reference either. Comparing against the raw viewport size failed on every
 * narrow case (3 of the 17 layout failures in the 2026-09-26 full-suite run)
 * and would keep failing whatever the shell renders.
 */
async function parentContentWidth(container: Locator): Promise<number> {
  return container.evaluate((el) => {
    const parent = el.parentElement;
    if (parent === null) throw new Error('container has no parent element');
    const cs = getComputedStyle(parent);
    return (
      parent.clientWidth -
      Number.parseFloat(cs.paddingInlineStart) -
      Number.parseFloat(cs.paddingInlineEnd)
    );
  });
}

/** How far the container's left edge sits from its parent's content-box left edge. */
async function startOffset(container: Locator): Promise<number> {
  return container.evaluate((el) => {
    const parent = el.parentElement;
    if (parent === null) throw new Error('container has no parent element');
    const parentLeft = parent.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(parent).paddingInlineStart);
    return Math.abs(el.getBoundingClientRect().left - parentLeft);
  });
}

test.describe('F5 container widths @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test.describe('container-widths table', () => {
    for (const width of VIEWPORTS_FULL) {
      test(`TableContainer on /admin/members @ ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await signInAdmin(page);
        await page.goto('/admin/members');
        await waitForLayoutContainer(page);

        const container = page.locator('[data-slot="layout-container"][data-variant="table"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        if (width >= 1280) {
          expect(boxWidth, 'table container caps at 96rem (1536px)').toBeLessThanOrEqual(1536);
        } else {
          expect(
            boxWidth,
            'table container takes the full content width at 375px',
          ).toBe(await parentContentWidth(container));
        }

        await assertNoHorizontalScroll(page);
      });
    }
  });

  test.describe('container-widths form', () => {
    for (const route of ADMIN_FORM_ROUTES) {
      for (const width of VIEWPORTS_FULL) {
        test(`FormContainer on ${route} @ ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await signInAdmin(page);
          await page.goto(route);
          await waitForLayoutContainer(page);

          const container = page.locator('[data-slot="layout-container"][data-variant="form"]').first();
          await expect(container).toBeVisible();

          const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
          if (width >= 1280) {
            expect(boxWidth, 'form container is AURA narrow (720px) at desktop').toBeCloseTo(FORM_MAX, 0);
            // The staff form boards put the column at the page's start edge.
            expect(await startOffset(container), 'form column sits at the start edge').toBeLessThanOrEqual(1);
          } else {
            expect(
              boxWidth,
              'form container takes the full content width at 375px',
            ).toBe(await parentContentWidth(container));
          }

          await assertNoHorizontalScroll(page);
        });
      }
    }

    for (const { route, min, max } of PORTAL_FORM_ROUTES) {
      test(`FormContainer on ${route} @ 1440px`, async ({ page }) => {
        test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_*_EMPTY not set');
        await page.setViewportSize({ width: 1440, height: 900 });
        await signInMember(page);
        await page.goto(route);
        await waitForLayoutContainer(page);

        const container = page.locator('[data-slot="layout-container"][data-variant="form"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
        expect(boxWidth).toBeGreaterThanOrEqual(min);
        expect(boxWidth).toBeLessThanOrEqual(max);

        await assertNoHorizontalScroll(page);
      });
    }
  });

  test.describe('container-widths detail', () => {
    for (const route of ADMIN_DETAIL_ROUTES) {
      for (const width of VIEWPORTS_DETAIL) {
        test(`DetailContainer on ${route} @ ${width}px`, async ({ page }) => {
          await page.setViewportSize({ width, height: 900 });
          await signInAdmin(page);
          await page.goto(route);
          await waitForLayoutContainer(page);

          const container = page.locator('[data-slot="layout-container"][data-variant="detail"]').first();
          await expect(container).toBeVisible();

          const boxWidth = await container.evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);
          if (width === 1440) {
            // AURA's default Container (1280px), or the whole content width
            // when the shell's nav leaves less than that.
            expect(boxWidth).toBeCloseTo(Math.min(DETAIL_MAX, await parentContentWidth(container)), 0);
          } else {
            expect(
              boxWidth,
              'detail container takes the full content width at 375px',
            ).toBe(await parentContentWidth(container));
          }

          await assertNoHorizontalScroll(page);
        });
      }
    }

    // Portal detail routes — additional SC-003 coverage beyond /admin.
    for (const route of PORTAL_DETAIL_ROUTES) {
      test(`DetailContainer on ${route} @ 1440px`, async ({ page }) => {
        test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_*_EMPTY not set');
        await page.setViewportSize({ width: 1440, height: 900 });
        await signInMember(page);
        await page.goto(route);
        await waitForLayoutContainer(page);

        const container = page.locator('[data-slot="layout-container"][data-variant="detail"]').first();
        await expect(container).toBeVisible();

        const boxWidth = await container.evaluate(
          (el) => (el as HTMLElement).getBoundingClientRect().width,
        );
        expect(boxWidth).toBeCloseTo(Math.min(DETAIL_MAX, await parentContentWidth(container)), 0);

        await assertNoHorizontalScroll(page);
      });
    }
  });
});
