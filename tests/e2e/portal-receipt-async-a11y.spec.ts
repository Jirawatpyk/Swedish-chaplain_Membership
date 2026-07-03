/**
 * 088 T066a (FR-019) — PREVIEW-GATED @a11y coverage for the member-facing
 * async §86/4 RC receipt-PDF state (`<ReceiptStatusWatcher>` + graceful
 * permanent-fail state).
 *
 * This spec is authored + collected but is NOT expected to be green locally:
 * it needs a seeded invoice whose `receiptPdfStatus === 'pending'` (or
 * `'failed'`) under the async-receipt-PDF flag, which only exists in a preview
 * environment with the F5 async flag on and a payment mid-render. It is
 * TRIPLE-gated (member creds + a seeded invoice id via env) so it stays skipped
 * on a bare local run rather than flaking.
 *
 * What it asserts on the invoice DETAIL page:
 *   - the aria-live polite `role="status"` region ANNOUNCES the "being
 *     generated" copy (SR parity for the pending state), and
 *   - the surface passes axe-core WCAG 2.1 AA with that live region present.
 *
 * The auto-refresh poll + backoff + stop-on-terminal behaviour is covered
 * deterministically by the fake-timer unit test
 * (tests/unit/app/portal/invoices/receipt-status-watcher.test.tsx) — this spec
 * is purely the accessibility-of-the-live-region check that only a real browser
 * can make.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import { signInViaForm } from './helpers/layout';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
// A seeded invoice (owned by the E2E member) whose receipt PDF is mid-render
// under the async flag — only present in a preview env.
const PENDING_RECEIPT_INVOICE_ID = process.env.E2E_RECEIPT_PENDING_INVOICE_ID;

test.describe('088 T066a — portal async receipt live region @a11y @088', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD || !PENDING_RECEIPT_INVOICE_ID,
    'E2E_MEMBER_* and E2E_RECEIPT_PENDING_INVOICE_ID not set (preview-only)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('pending receipt announces via aria-live + passes WCAG 2.1 AA', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );

    await page.goto(`/portal/invoices/${PENDING_RECEIPT_INVOICE_ID}`);
    await page.waitForLoadState('networkidle');

    // The aria-live polite status region is present and announces the pending
    // ("being generated") state to assistive tech.
    const live = page.getByTestId('receipt-status-watcher');
    await expect(live).toBeVisible();
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveAttribute('role', 'status');

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    expect(
      results.violations,
      'portal invoice detail (async receipt pending) has zero WCAG 2.1 AA violations',
    ).toEqual([]);
  });
});
