/**
 * 088 US8 (UX-A) — §80/1(5) zero-rate issue-form a11y scan (SC-010).
 *
 * Complements `invoice-admin-a11y.spec.ts` (static admin surfaces) by scanning
 * the DYNAMIC issue-invoice dialog — before AND after the admin selects the
 * `vat_treatment` = zero-rate option (which progressively reveals the MFA-cert
 * fields via aria-live). axe tags: WCAG 2.0/2.1 A + AA; zero violations.
 *
 * Preview-gated + fixture-dependent (mirrors the F4 E2E policy): it needs an
 * authenticated admin, the `FEATURE_088_TAX_AT_PAYMENT` flag ON, and a
 * non-membership (event/service) DRAFT invoice for the toggle to appear. Each
 * precondition is a graceful skip, so the spec is safe to keep in the suite and
 * only turns green on preview where the fixtures exist.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import { signInViaForm, waitForLayoutContainer } from './helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;

test.describe('088 zero-rate issue form a11y @a11y @f088', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('the issue dialog (before + after zero-rate select) passes WCAG 2.1 AA', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/admin/sign-in',
      ADMIN_EMAIL!,
      ADMIN_PASSWORD!,
      /^\/admin(\/|$)/,
    );

    // Find a DRAFT invoice — the issue dialog only exists on drafts.
    await page.goto('/admin/invoices?status=draft');
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    const draftLink = page
      .getByRole('link', { name: /SC-|draft/i })
      .first();
    const hasDraft = await draftLink
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasDraft, 'no draft invoice fixture available');

    await draftLink.click();
    await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/);
    await waitForLayoutContainer(page);

    // Open the issue dialog.
    const issueTrigger = page.getByRole('button', { name: /^Issue…?$/ });
    const canIssue = await issueTrigger
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!canIssue, 'invoice is not an issuable draft');
    await issueTrigger.click();

    // Scan the open dialog (standard state).
    await expect(
      page.getByRole('alertdialog').or(page.getByRole('dialog')),
    ).toBeVisible();
    const before = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
    expect(
      before.violations,
      'issue dialog (standard) has zero WCAG 2.1 AA violations',
    ).toEqual([]);

    // Reveal the cert fields — non-membership drafts under the flag show the
    // zero-rate radio; membership drafts (or flag off) skip this half.
    const zeroRateRadio = page.getByRole('radio', { name: /Zero-rated/i });
    const hasToggle = await zeroRateRadio
      .waitFor({ state: 'visible', timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!hasToggle, 'no vat_treatment toggle (membership draft or flag off)');

    await zeroRateRadio.check();
    await expect(page.getByTestId('zero-rate-cert-fields')).toBeVisible();
    const after = await new AxeBuilder({ page }).withTags([...AXE_TAGS]).analyze();
    expect(
      after.violations,
      'issue dialog (zero-rate, cert fields revealed) has zero WCAG 2.1 AA violations',
    ).toEqual([]);
  });
});
