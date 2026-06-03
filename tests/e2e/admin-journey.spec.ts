/**
 * Golden-path JOURNEY E2E — ADMIN persona (Stage 5 go/no-go, docs/go-live-readiness.md § 4 Stage 1b + § 7).
 *
 * Walks the admin journey end-to-end ACROSS module seams in one continuous session:
 *   sign-in (F1) → plans (F2) → members (F3) → invoice (F4) → payment view (F5)
 *   → broadcasts (F7) → dashboard + audit (F9) → renewals + escalation (F8).
 *
 * Unlike the per-feature specs (admin-*, f9-*, broadcast-*), this asserts the HANDOFFS
 * between features are reachable and wired — a per-module audit cannot see a broken seam.
 *
 * Flag-gating design: this is ONE journey crossing many flags (F5/F7/F8/F9 default OFF).
 * A hard-throw on every flag would make the journey all-or-nothing. Instead the ALWAYS-ON
 * core (sign-in → plans → members → invoices) is asserted unconditionally, and each
 * flag-gated step is asserted ONLY when its flag is ON, else recorded as a skipped step in
 * the test annotations. On the go/no-go preview (every flag flipped) every step asserts;
 * locally (some features dark) the reachable seams still run. Run with `--workers=1`.
 */
import { expect, test } from './fixtures';
import { signInAsAdmin } from './helpers/admin-session';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const F5 = process.env.FEATURE_F5_ONLINE_PAYMENT === 'true';
const F7 = process.env.FEATURE_F7_BROADCASTS === 'true';
const F8 = process.env.FEATURE_F8_RENEWALS === 'true';
const F9 = process.env.FEATURE_F9_DASHBOARD === 'true';

test.describe('Journey — admin golden path across module seams @journey', () => {
  // A journey visits ~10 admin routes; under `next dev` each compiles on first hit
  // (Turbopack), blowing the default 30 s per-test budget on a cold run. 120 s is ample
  // here and on the pre-built preview (where routes are already compiled).
  test.describe.configure({ timeout: 120_000 });

  test.beforeAll(() => {
    if (!ADMIN_EMAIL) {
      throw new Error(
        'E2E_ADMIN_EMAIL/E2E_ADMIN_PASSWORD missing — set the seeded admin creds in .env.local before running @journey.',
      );
    }
  });

  test('admin walks sign-in → plans → members → invoice → payment → broadcast → dashboard → audit → renewals', async ({
    page,
  }, testInfo) => {
    const skipped: string[] = [];
    const gated = async (name: string, enabled: boolean, fn: () => Promise<void>): Promise<void> => {
      if (!enabled) {
        skipped.push(name);
        return;
      }
      await fn();
    };

    // --- F1 — sign in (lands on /admin) ---
    await signInAsAdmin(page);

    // --- F2 — membership plans ---
    await page.goto('/admin/plans');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // --- F3 — members list → a real member detail ---
    await page.goto('/admin/members');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });
    // The first `a[href^="/admin/members/"]` is the New-member CTA, not a row — filter to a UUID href.
    const memberHref = await page
      .locator('a[href^="/admin/members/"]')
      .evaluateAll((els) =>
        els
          .map((e) => e.getAttribute('href'))
          .find((h) => h !== null && /\/admin\/members\/[0-9a-f-]{36}/i.test(h)),
      );
    if (memberHref) {
      await page.goto(memberHref);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 10_000 });
    } else {
      skipped.push('F3 member detail (no seeded member row)');
    }

    // --- F4 — invoices list ---
    await page.goto('/admin/invoices');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 10_000 });

    // --- F5 — paid-online reconciliation view ---
    await gated('F5 payment reconciliation', F5, async () => {
      await page.goto('/admin/invoices?paidOnline=1');
      await expect(page.getByTestId('paid-online-filter-chip')).toBeVisible({ timeout: 10_000 });
    });

    // --- F7 — broadcasts admin surface ---
    await gated('F7 broadcasts settings', F7, async () => {
      await page.goto('/admin/settings/broadcasts');
      await expect(
        page.locator('[data-slot="card-title"]', { hasText: /image source allowlist/i }).first(),
      ).toBeVisible({ timeout: 10_000 });
    });

    // --- F9 — dashboard (the /admin landing becomes the dashboard when F9 is on) ---
    await gated('F9 dashboard', F9, async () => {
      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Dashboard', level: 1 })).toBeVisible({
        timeout: 10_000,
      });
    });

    // --- F9 — audit viewer ---
    await gated('F9 audit log', F9, async () => {
      await page.goto('/admin/audit');
      await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible({
        timeout: 10_000,
      });
    });

    // --- F8 — renewals pipeline + escalation queue ---
    await gated('F8 renewals pipeline', F8, async () => {
      await page.goto('/admin/renewals');
      await expect(page.getByRole('heading', { name: /renewal pipeline/i })).toBeVisible({
        timeout: 10_000,
      });
    });
    await gated('F8 escalation queue', F8, async () => {
      await page.goto('/admin/renewals/tasks');
      await expect(page.getByRole('heading', { name: /escalation tasks/i })).toBeVisible({
        timeout: 10_000,
      });
    });

    if (skipped.length > 0) {
      testInfo.annotations.push({
        type: 'journey-steps-skipped (feature dark)',
        description: skipped.join(' · '),
      });
    }
  });
});
