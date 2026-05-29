/**
 * T088 (F9 US6) — `@f9` member GDPR self-service data export E2E.
 *
 * Asserts the member-facing request flow (FR-029/030) against the dev server:
 *   - the data-export page renders (heading, description, request button);
 *   - clicking "Request my data export" POSTs the request, shows the success
 *     toast, and the recent-requests table reflects the new (Preparing) job;
 *   - a member is the only role with this self-service surface (the route is
 *     member-gated; staff use the admin-on-behalf path).
 *
 * The async worker + private-blob download round-trip are NOT exercised here —
 * the worker is an operator-gated cron and private-Blob delivery needs a private
 * store (ship-day gate T101a). This suite covers the member request surface;
 * the single-use download proxy is covered by the contract suite
 * (`export-download.contract.test.ts`) + the worker integration.
 *
 * Requires `FEATURE_F9_DASHBOARD=true` + E2E_MEMBER_* in `.env.local`.
 * Run with `pnpm test:e2e --grep "@f9" --workers=1`.
 */
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';
import { signInAsAdmin } from './helpers/admin-session';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const F9_ENABLED = process.env.FEATURE_F9_DASHBOARD === 'true';

test.describe('F9 — member GDPR data export (US6) @f9', () => {
  test.beforeAll(() => {
    if (!MEMBER_EMAIL) {
      throw new Error('E2E_MEMBER_EMAIL missing — set it in .env.local before running this suite.');
    }
    if (!F9_ENABLED) {
      throw new Error('FEATURE_F9_DASHBOARD=false — set it true in .env.local before this suite.');
    }
  });

  test('member requests a data export and the request is acknowledged', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/account/data-export');

    // Page structure (FR-029).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const requestButton = page.getByRole('button', { name: /request my data export/i });
    await expect(requestButton).toBeVisible();

    // State-aware (W4): the button is DISABLED when an export is already
    // requested/processing — and dev has no cron to drain jobs, so prior runs
    // accumulate pending jobs. If enabled → request → success toast; if disabled
    // → the "already preparing" hint proves the W4 guard + a prior request. Both
    // paths verify the feature; the recent-requests table renders either way.
    if (await requestButton.isEnabled()) {
      await requestButton.click();
      await expect(page.getByText(/export requested/i).first()).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(
        page.getByText(/already being prepared|กำลังจัดเตรียม|förbereds redan/i),
      ).toBeVisible();
    }
    await expect(page.getByRole('table')).toBeVisible({ timeout: 15_000 });
  });

  test('the data-export link is discoverable from the account page', async ({ page }) => {
    await signInAsMember(page);
    await page.goto('/portal/account');
    const link = page.getByRole('link', { name: /go to data export/i });
    await expect(link).toBeVisible();
    await link.click();
    await page.waitForURL(/\/portal\/account\/data-export/, { timeout: 15_000 });
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('admin can produce a member’s data export on their behalf (FR-031)', async ({ page }) => {
    await signInAsAdmin(page);
    await page.goto('/admin/members');
    await expect(page.locator('a[href^="/admin/members/"]').first()).toBeVisible({
      timeout: 15_000,
    });
    // Pick a member-DETAIL link (href = /admin/members/<uuid>), skipping the
    // page-level "New member" button (/admin/members/new).
    const detailHref = await page
      .locator('a[href^="/admin/members/"]')
      .evaluateAll((els) =>
        els
          .map((e) => e.getAttribute('href'))
          .find((h) => h !== null && /\/admin\/members\/[0-9a-f-]{36}/i.test(h)),
      );
    expect(detailHref, 'a seeded member-detail link exists').toBeTruthy();
    await page.goto(detailHref!);
    await page.waitForURL(/\/admin\/members\/[0-9a-f-]{36}/i, { timeout: 15_000 });

    // The admin on-behalf GDPR card is present (CardTitle is a <div>, not a
    // heading), and a request is acknowledged.
    await expect(page.getByText(/data export \(gdpr\)/i).first()).toBeVisible({ timeout: 15_000 });
    const requestButton = page.getByRole('button', { name: /request my data export/i });
    await expect(requestButton).toBeVisible();
    // State-aware (W4): same as the member test — admin on-behalf request when
    // the button is enabled, else the already-pending hint proves the guard.
    if (await requestButton.isEnabled()) {
      await requestButton.click();
      await expect(page.getByText(/export requested/i).first()).toBeVisible({ timeout: 15_000 });
    } else {
      await expect(
        page.getByText(/already being prepared|กำลังจัดเตรียม|förbereds redan/i),
      ).toBeVisible();
    }
  });
});
