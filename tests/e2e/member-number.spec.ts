/**
 * T-MN-04 — E2E: member-number column CLS, th-TH no-wrap, portal badge.
 *
 * @f-mn @layout @i18n
 *
 * (1) Admin list /admin/members:
 *     - "Member No." column header is visible after data loads
 *       (proves the column was added, not just in the skeleton).
 *     - CLS ≤ 0.01 on the members list page after skeleton→data swap
 *       at 1280px viewport (design spec §10).
 *     - th-TH locale: "เลขสมาชิก" column header renders without line-break
 *       (whitespace-nowrap enforced per design spec §10).
 *
 * (2) Admin member detail /admin/members/:id:
 *     - Formatted member number (e.g. "SCCM-0001") is visible.
 *     - A copy button is present adjacent to the formatted number.
 *
 * (3) Member portal /portal (dashboard):
 *     - Signed-in member sees a badge containing their formatted
 *       member number on the portal dashboard.
 *
 * Markup-reconciliation notes (vs plan draft):
 *   - The column header is a SORT BUTTON (members-table.tsx
 *     MemberNumberSortHeader): a <button aria-label="Sort by member
 *     number"> with `whitespace-nowrap` whose text node is the i18n
 *     label ("Member No." / "เลขสมาชิก") + a sort icon. We target the
 *     button by role+aria-label (locale-stable) and measure ITS height
 *     for the no-wrap check.
 *   - The portal badge is a shadcn <Badge variant="outline"
 *     className="font-mono"> wrapping the formatted number.
 *   - The detail copy button uses aria-label = "Copy member number".
 *
 * Local-noise caveat (per project memory): @a11y/@i18n + CLS assertions
 * are authoritative on the PREVIEW deploy (prod build + co-located Neon).
 * On local dev these can flake (dev-server sign-in latency, RTT-driven
 * layout settle). Treat local @f-mn failures of CLS/axe as preview-only
 * noise, not regressions — re-run authoritatively against a preview.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD + E2E_MEMBER_EMAIL/PASSWORD.
 * Serial mode: each test signs in fresh.
 */
import AxeBuilder from '@axe-core/playwright';
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

// Formatted-number pattern: PREFIX (1–8 upper-alnum) + '-' + ≥4 digits.
const MEMBER_NUMBER_RE = /^[A-Z][A-Z0-9]{0,7}-\d{4,}$/;

test.describe.configure({ mode: 'serial' });

test.describe('Member-number column + portal badge @f-mn @layout @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signInAdmin(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  async function setLocale(context: BrowserContext, locale: string): Promise<void> {
    await context.addCookies([
      { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
    ]);
  }

  async function firstMemberId(page: Page): Promise<string | null> {
    await page.goto('/admin/members');
    await page.waitForLoadState('networkidle');
    // The first row link points at /admin/members/<uuid> (company-name cell).
    const hrefs = await page
      .locator('tbody tr a[href*="/admin/members/"]')
      .evaluateAll((els) =>
        els.map((e) => (e as HTMLAnchorElement).getAttribute('href') ?? ''),
      )
      .catch(() => [] as string[]);
    for (const href of hrefs) {
      const id = href.match(/\/admin\/members\/([0-9a-f-]{36})/)?.[1];
      if (id) return id;
    }
    return null;
  }

  // ── (1a) Member No. column header visible ────────────────────────────────

  test('1a. /admin/members — member-number column header is visible after data loads', async ({
    page,
  }) => {
    await signInAdmin(page);
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // The header is a sort button (locale-stable aria-label) carrying the
    // EN label "Member No.". Assert both: the button exists and its visible
    // text is the EN column label.
    const header = page.getByRole('button', { name: /sort by member number/i });
    await expect(header).toBeVisible({ timeout: 5_000 });
    await expect(header).toContainText('Member No.');
  });

  // ── (1b) CLS ≤ 0.01 at 1280px on skeleton→data swap ────────────────────

  test('1b. /admin/members — CLS ≤ 0.01 at 1280px viewport (skeleton→data swap)', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAdmin(page);

    // Instrument CLS observer BEFORE navigation.
    await page.goto('/admin/members');
    await page.evaluate(() => {
      (window as unknown as { __cls?: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as Array<{
          value: number;
          hadRecentInput: boolean;
        }>) {
          if (!entry.hadRecentInput) {
            const w = window as unknown as { __cls?: number };
            w.__cls = (w.__cls ?? 0) + entry.value;
          }
        }
      }).observe({ type: 'layout-shift', buffered: true });
    });

    // Wait for real data to replace skeleton.
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');
    // Small settle window for any deferred paint.
    await page.waitForTimeout(300);

    const cls = await page.evaluate(
      () => (window as unknown as { __cls?: number }).__cls ?? 0,
    );
    expect(cls, '/admin/members CLS at 1280px').toBeLessThanOrEqual(0.01);
  });

  // ── (1c) th-TH column header no-wrap at 1280px ──────────────────────────

  test('1c. /admin/members th-TH locale — member-number header has no line-break at 1280px', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await signInAdmin(page);
    await setLocale(context, 'th');
    await page.goto('/admin/members');
    await page.waitForSelector('[data-slot="table"]', { timeout: 10_000 });
    await page.waitForLoadState('networkidle');

    // Locate the sort button (locale-stable aria-label) and confirm the TH
    // label renders. The button carries `whitespace-nowrap` — assert it
    // occupies a single line (no wrapping) by measuring its height.
    const thHeader = page.getByRole('button', { name: /เรียงตามหมายเลขสมาชิก/ });
    await expect(thHeader).toBeVisible({ timeout: 5_000 });
    await expect(thHeader).toContainText('เลขสมาชิก');

    const headerHeight = await thHeader.evaluate(
      (el) => (el as HTMLElement).clientHeight,
    );
    expect(
      headerHeight,
      'th-TH member-number column header must not wrap (whitespace-nowrap)',
    ).toBeLessThanOrEqual(28); // generous for font scaling + icon row height
  });

  // ── (2a) Admin detail: formatted number visible ──────────────────────────

  test('2a. /admin/members/:id — formatted member number is visible on detail', async ({
    page,
  }) => {
    await signInAdmin(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping detail member-number check');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    const formattedNumber = page.getByText(MEMBER_NUMBER_RE, { exact: false });
    const isVisible = await formattedNumber.first().isVisible().catch(() => false);
    expect(
      isVisible,
      'Formatted member number (e.g. SCCM-0001) must be visible on member detail',
    ).toBe(true);
  });

  // ── (2b) Admin detail: copy button adjacent to formatted number ──────────

  test('2b. /admin/members/:id — copy button for member number is present', async ({
    page,
  }) => {
    await signInAdmin(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping copy-button check');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // CopyButton renders aria-label = "Copy member number" (EN locale).
    const copyButton = page
      .getByRole('button', { name: /copy member number/i })
      .first();
    await expect(copyButton).toBeVisible({ timeout: 5_000 });
  });

  // ── (2c) Admin detail: no axe violations after member-number addition ────

  test('2c. /admin/members/:id — no axe violations (member-number section)', async ({
    page,
  }) => {
    await signInAdmin(page);
    const memberId = await firstMemberId(page);
    if (!memberId) {
      test.skip(true, 'No members seeded — skipping axe scan');
      return;
    }
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  // ── (3) Portal dashboard: member-number badge ────────────────────────────

  test('3. /portal — member-number badge visible on portal dashboard', async ({
    page,
  }) => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'Set E2E_MEMBER_EMAIL and E2E_MEMBER_PASSWORD',
    );

    await page.goto('/portal/sign-in');
    await fillField(page.getByLabel(/email/i), MEMBER_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => /^\/portal(\/|$)/.test(new URL(u).pathname),
      { timeout: 15_000 },
    );

    await page.waitForLoadState('networkidle');

    // The portal dashboard badge is a font-mono <Badge> showing the
    // formatted member number (PREFIX-NNNN). Match by the formatted pattern.
    const badge = page.getByText(MEMBER_NUMBER_RE, { exact: false });
    const isVisible = await badge.first().isVisible().catch(() => false);
    expect(
      isVisible,
      'Portal dashboard must show the member-number badge (PREFIX-NNNN)',
    ).toBe(true);
  });
});
