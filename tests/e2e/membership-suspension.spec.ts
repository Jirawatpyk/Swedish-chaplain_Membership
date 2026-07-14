/**
 * 059-membership-suspension Task 10 — Slice-1 E2E: the SUSPENDED-member
 * journey, proven end-to-end in a real browser.
 *
 * The API/use-case enforcement itself is already proven by the live-Neon
 * integration tests in Tasks 3/5/6/7/8 (`checkPortalAccess`,
 * `submitBroadcast`, `inviteColleague`, the two portal chokepoints). This
 * spec proves what those can't: the actual BROWSER journey (does the
 * amber card really render, does the CTA really land somewhere useful,
 * does the compose form really fail to appear), plus `@a11y` + `@i18n`
 * coverage of the new suspension surfaces.
 *
 * Fixture: `seedSuspendedMember()` (./helpers/suspended-member-seed.ts)
 * mints `e2e-member`'s ONLY renewal cycle as `awaiting_payment` — the one
 * status `deriveMembershipAccess` maps to `{ access: 'suspended', reason:
 * 'unpaid' }` UNCONDITIONALLY, before any expiry comparison runs (see
 * `src/modules/renewals/domain/renewal-cycle.ts:363-365`). The existing
 * `seedF8Renewals()` fixture (upcoming + lapsed pair) is NOT reused here —
 * its `upcoming` cycle is inserted after the `lapsed` one, so it is always
 * the member's LATEST cycle by `created_at DESC, cycle_id DESC`, which
 * resolves that member to `full`, not `suspended` — see the seed helper's
 * own docstring for the full reasoning.
 *
 * `e2e-member` already carries a real ISSUED membership invoice from
 * `scripts/seed-e2e-portal-invoices.ts` (`E2E_ISSUED_INVOICE_ID`,
 * `invoice_subject='membership'`, `status='issued'`), so the dashboard's
 * smart-CTA resolves straight to `/portal/invoices/[id]` and that same
 * invoice id doubles as the "reachable invoice detail page" + "reachable
 * PDF download" fixture — no extra invoice seeding needed.
 *
 * Scenarios (plan.md Task 10 + design doc § User-facing surfaces):
 *   1. Dashboard renders the amber `suspended` card with a working smart
 *      pay CTA that does not dead-end on a blocked route.
 *   2. `/portal/invoices` (list) stays reachable.
 *   3. The never-block routes stay reachable: invoice detail, GDPR
 *      data-export, credit-note detail, invoice PDF download.
 *   4. `/portal/broadcasts/new` is blocked — the compose form never
 *      renders for a suspended member (whichever chokepoint fires: the
 *      layout-level guard on a hard navigation, or the page's own
 *      redirect on a client-side one — see `portal-page-access.ts` and
 *      `broadcasts/new/page.tsx` for why the two can differ).
 *   5. `@a11y` axe scan on the suspended `/portal` dashboard + the
 *      blocked-compose landing page.
 *   6. `@i18n` the suspension banner renders correctly in EN/TH/SV.
 */
import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';
import { seedSuspendedMember } from './helpers/suspended-member-seed';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const ISSUED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;

/**
 * The Membership StatCard. NOT scoped by `data-variant="warning"` alone —
 * the Outstanding-balance card (`outstanding-stat-section.tsx`) ALSO
 * renders `variant="warning"` (due-but-not-overdue) or `variant=
 * "destructive"` (overdue — which our seeded invoice's past due date
 * triggers), so `data-variant` is not unique on this page. `(home)/
 * page.tsx` always renders `<MembershipStatSection>` FIRST of the 3 stat
 * cards (plain `grid-cols-3`, no CSS `order` override), so DOM order is a
 * stable, locale-agnostic anchor — safe across the @i18n locale-switch
 * tests too.
 */
function membershipCard(page: Page): Locator {
  return page.locator('[data-testid="stat-card"]').first();
}

async function expectNoSeriousAxeViolations(page: Page, surface: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  if (bad.length > 0) {
    console.error(
      `[axe ${surface}] ${bad.length} serious/critical violations:`,
      JSON.stringify(bad, null, 2),
    );
  }
  expect(bad, `${surface}: serious/critical axe violations`).toHaveLength(0);
}

test.describe('059-membership-suspension — Slice 1 E2E (suspended member)', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD,
    'E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD not set',
  );

  test.beforeEach(async () => {
    const seed = await seedSuspendedMember();
    if (!seed) {
      throw new Error(
        'seedSuspendedMember returned null — verify DATABASE_URL + E2E_MEMBER_EMAIL are set in .env.local',
      );
    }
  });

  test('dashboard renders the amber suspension card with a working pay CTA', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.waitForLoadState('networkidle');

    const card = membershipCard(page);
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-variant', 'warning');
    await expect(card).toContainText(/benefits paused/i);
    // Icon + text — never colour-alone (WCAG 1.4.1, spec a11y-3).
    await expect(
      card.locator('[data-testid="stat-card-status"]'),
    ).toContainText(/benefits paused/i);

    const cta = card.getByRole('link', { name: /pay to restore benefits/i });
    await expect(cta).toBeVisible();

    // The smart CTA (`findUnpaidMembershipInvoiceId`) picks whichever of
    // e2e-member's ISSUED membership invoices has the EARLIEST due date —
    // `e2e-member` is a shared fixture account with invoices seeded by
    // several unrelated specs (F4, F5, …), so this is NOT necessarily
    // `E2E_ISSUED_INVOICE_ID` (that's pinned to a specific F5 payment
    // fixture, not "the" invoice). Assert the SHAPE + that it never
    // dead-ends, not one specific hardcoded id.
    const href = await cta.getAttribute('href');
    expect(href).toMatch(/^\/portal\/invoices\/[0-9a-f-]{36}$/);

    // The CTA must never dead-end: clicking it (a client-routed Next
    // <Link>, not a full navigation) must land on the real invoice detail
    // page — never bounce back via the suspension gate. If it DID bounce,
    // `waitForURL` would time out on a URL that never arrives, which is
    // itself a clear failure signal.
    await cta.click();
    await page.waitForURL(`**${href}`, { timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe(href);
  });

  test('/portal/invoices is reachable (must be, to pay)', async ({ page }) => {
    await signInAsMember(page);
    const response = await page.goto('/portal/invoices');
    expect(response?.status() ?? 0).toBeLessThan(400);
    expect(new URL(page.url()).pathname).toBe('/portal/invoices');
  });

  test('never-block routes stay reachable for a suspended member', async ({
    page,
  }) => {
    test.skip(!ISSUED_INVOICE_ID, 'E2E_ISSUED_INVOICE_ID not set');
    await signInAsMember(page);

    // (a) invoice detail — the real seeded ISSUED membership invoice.
    const invResp = await page.goto(`/portal/invoices/${ISSUED_INVOICE_ID}`);
    expect(invResp?.status() ?? 0).toBeLessThan(400);
    expect(new URL(page.url()).pathname).toBe(
      `/portal/invoices/${ISSUED_INVOICE_ID}`,
    );

    // (b) GDPR data-export (Art. 20 / PDPA portability) — the legacy route
    // redirects to the Account hub's Data & privacy section; it must land
    // THERE, never bounce back to the bare /portal dashboard.
    await page.goto('/portal/account/data-export');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).pathname).toBe('/portal/account');

    // (c) credit-note detail — reachability probe with a syntactically
    // valid, non-existent id. A 404 (the resource genuinely doesn't
    // exist) is fine and expected; what would FAIL this assertion is the
    // suspension gate intercepting the request and redirecting elsewhere
    // instead of letting it reach the page's own not-found handling.
    const fakeCnId = '00000000-0000-4000-8000-0000000000f1';
    const cnResp = await page.goto(`/portal/credit-notes/${fakeCnId}`);
    expect(new URL(page.url()).pathname).toBe(
      `/portal/credit-notes/${fakeCnId}`,
    );
    expect(cnResp?.status() ?? 0).not.toBe(302);
    expect(cnResp?.status() ?? 0).toBeLessThan(500);

    // (d) invoice PDF download API route.
    const pdfResp = await page.request.get(
      `/api/portal/invoices/${ISSUED_INVOICE_ID}/pdf`,
    );
    expect(pdfResp.status()).not.toBe(403);
    expect(pdfResp.status()).toBeLessThan(500);
  });

  test('/portal/broadcasts/new is blocked — compose form never renders', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/portal/broadcasts/new');
    await page.waitForLoadState('networkidle');

    // Never lands ON the compose route, and never renders the compose
    // form — regardless of WHICH chokepoint fired (the layout-level guard
    // sends a hard navigation to bare /portal; the page's own check sends
    // a client-side navigation to /portal/benefits?tab=broadcasts).
    expect(new URL(page.url()).pathname).not.toBe('/portal/broadcasts/new');
    await expect(page.getByLabel(/subject/i)).toHaveCount(0);
  });

  test('@a11y suspended /portal dashboard has no serious/critical axe violations', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.waitForLoadState('networkidle');
    await expectNoSeriousAxeViolations(page, '/portal (suspended)');
  });

  test('@a11y blocked /portal/broadcasts/new landing has no serious/critical axe violations', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/portal/broadcasts/new');
    await page.waitForLoadState('networkidle');
    await expectNoSeriousAxeViolations(page, '/portal/broadcasts/new (blocked landing)');
  });

  for (const [locale, expected] of [
    ['en', /benefits paused/i],
    ['th', /ระงับสิทธิประโยชน์ชั่วคราว/],
    ['sv', /förmåner pausade/i],
  ] as const) {
    test(`@i18n suspension banner renders in ${locale}`, async ({
      page,
      context,
    }) => {
      // Seed NEXT_LOCALE BEFORE the first navigation — next-intl's
      // request config honours this cookie server-side. domain+path (not
      // a full url) so this is base-URL/port agnostic (worktree runs use
      // a different port than the shared dev server).
      const baseUrl = process.env.E2E_BASE_URL ?? 'http://localhost:3100';
      const baseHost = new URL(baseUrl).hostname;
      await context.addCookies([
        { name: 'NEXT_LOCALE', value: locale, domain: baseHost, path: '/' },
      ]);
      await signInAsMember(page);
      await page.waitForLoadState('networkidle');
      await expect(membershipCard(page)).toContainText(expected);
    });
  }
});
