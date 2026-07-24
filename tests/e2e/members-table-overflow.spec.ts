/**
 * Regression guard for the `/admin/members` directory's fixed-width columns
 * bleeding into their neighbours (Plan 185px, Contact 175px, Status 130px).
 *
 * `table-fixed` + an explicit `<colgroup>` pin each `<td>`'s BOX to the
 * column's declared width, but `TableCell` (`src/components/ui/table.tsx`)
 * sets `whitespace-nowrap` with no `overflow`/`text-overflow` guard, so
 * content wider than its column overflows *visibly* into the neighbour
 * instead of wrapping or clipping. The cell box itself never overlaps —
 * only its painted content does — so this asserts the content's rendered
 * right edge against the cell's right edge, not `scrollWidth`.
 *
 * Uses a dedicated seeded fixture (`seedLongContentMember`) rather than
 * iterating "every row": the existing directory specs are written to
 * tolerate an empty table, and there is no other members seed helper — a
 * generic iteration would pass vacuously against an empty/short-content
 * table, guarding nothing.
 *
 * Task 7 (057-members-portal-status): extended to `sv`/`th` and to the
 * Contact column (index 4), which now carries the portal-state badge row
 * (`PortalBadge`, `members-table.tsx`). `Badge` is overflow-hidden/nowrap/
 * shrink-0 and cannot wrap, and the portal + bounce labels are longest in
 * `sv`/`th`, so those locales are where a too-long label bleeds first — this
 * closes the residual the Task 2 skeleton doc flagged (stacking rows already
 * exceeded the old fixed skeleton height). Locale switch follows
 * `members-i18n.spec.ts`: next-intl reads the `NEXT_LOCALE` cookie (no
 * middleware path-prefix in this project), so the switch is a cookie write,
 * not a URL path segment.
 *
 * Dev-profiler pageerror (DEV-ONLY noise — NARROW scoped opt-out below,
 * mirrors `tests/e2e/portal/account-hub-route-safety.spec.ts`): under
 * `next dev`, navigating `/admin/members` deterministically trips React's
 * dev component-performance profiler (`flushComponentPerformance`, in
 * `/_next/static/...`), which throws a `Performance.measure` `TypeError`
 * unrelated to this spec's table-layout assertion. The profiler's
 * `performance.measure` calls are DEV-ONLY (stripped from prod builds), so
 * it never fires against a production build — the related endpoint 404s
 * there. It reproduces on WebKit (`mobile-safari`) only: WebKit surfaces the
 * error as a bare, uninformative `Type error` whose sole stable
 * discriminator is the `flushComponentPerformance` stack frame, so the
 * shared `../fixtures` pageerror auto-fail (which only carves out
 * `__nextjs`-prefixed messages) treats it as a genuine client crash and
 * fails the spec even though the Plan/Status bleed assertion below never
 * ran or passed cleanly. `playwright.config.ts` runs `pnpm dev` as its
 * webServer both locally and in CI, and `mobile-safari` is a default
 * (non-opt-in) project, so this trips on every documented run without the
 * fix below.
 *
 * We set the NARROW `E2E_PAGEERROR_IGNORE_PATTERN` regex (not the blanket
 * `E2E_PAGEERROR_IGNORE=true`) in `beforeAll`/restore in `afterAll`, scoped
 * to this spec file's worker only. `flushComponentPerformance` is a React
 * dev-profiler internal that never appears in an app-level error stack, so
 * it cannot mask a real `MISSING_MESSAGE`, hydration mismatch, or any other
 * app `TypeError` — those still fail loudly. Do not read this as "ignore
 * page errors on this page": it ignores exactly one known, deterministic,
 * dev-only, engine-specific noise source and nothing else.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';
import {
  cleanupLongContentMember,
  seedLongContentMember,
} from './helpers/long-content-member-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const LOCALES = ['en', 'sv', 'th'] as const;
type Locale = (typeof LOCALES)[number];

// Mirrors `members-i18n.spec.ts`'s `setLocale`: next-intl reads the active
// locale from the `NEXT_LOCALE` cookie (no middleware path-prefix here).
async function setLocale(context: BrowserContext, locale: Locale): Promise<void> {
  await context.addCookies([
    { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
  ]);
}

/**
 * Shared assertion, extracted from the original English-only "Plan and
 * Status" test so Task 7's `sv`/`th` + Contact-column extension isn't a
 * copy-paste of the per-cell measurement three times over.
 *
 * Admin session → `enableSelection` is on, so the rendered column order is:
 * select(0), Member No.(1), Company(2), Plan(3), Contact(4), Status(5),
 * Engagement(6), Last activity(7) — verified against `members-table.tsx`'s
 * `columns` array. Company + Contact's name already wrap (`break-words
 * whitespace-normal` + a `max-w`) so the column indices under test are the
 * ones with `whitespace-nowrap` (fixed-width Badge) content: Plan, Contact
 * (badge row), and Status.
 */
async function expectNoCellBleed(
  page: Page,
  companyName: string,
  columnIndices: readonly number[],
): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: companyName });
  await expect(row).toBeVisible();

  for (const columnIndex of columnIndices) {
    const cell = row.getByRole('cell').nth(columnIndex);
    const bleed = await cell.evaluate((td) => {
      const cellRight = td.getBoundingClientRect().right;
      let worst = 0;
      for (const child of Array.from(td.querySelectorAll('*'))) {
        worst = Math.max(worst, child.getBoundingClientRect().right - cellRight);
      }
      return worst;
    });
    // 1px tolerance for sub-pixel rounding.
    expect(bleed, `column ${columnIndex} content bleed past its cell`).toBeLessThanOrEqual(1);
  }
}

test.describe('members directory — column overflow @a11y', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  // Scope the dev-profiler pageerror opt-out (see header note) to THIS
  // spec's worker process — the shared fixtures.ts pageerror auto-fail
  // reads `process.env.E2E_PAGEERROR_IGNORE_PATTERN` at teardown, so
  // toggling it here is honoured per-test, and restoring (not deleting) the
  // prior value in afterAll prevents leaking into / clobbering other specs
  // that may run in the same `--workers=1` process.
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

  test.afterAll(async () => {
    await cleanupLongContentMember();
  });

  for (const locale of LOCALES) {
    test(`content stays inside its column in ${locale} @i18n`, async ({ page, context }) => {
      const seed = await seedLongContentMember();
      test.skip(seed === null, 'seed unavailable (no DATABASE_URL or no active plan to clone)');

      await signInAsAdmin(page);
      await setLocale(context, locale);
      await page.goto(`/admin/members?q=${encodeURIComponent(seed!.companyName)}`);
      await page.waitForLoadState('networkidle');

      // Plan(3), Contact(4, portal + bounce badge row), Status(5).
      await expectNoCellBleed(page, seed!.companyName, [3, 4, 5]);
    });
  }
});
