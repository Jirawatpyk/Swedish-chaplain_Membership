/**
 * 088 T072a (SC-010 + SC-011) — §80/1(5) zero-rate issue-form a11y + responsive.
 *
 * Extends the original `invoice-issue-zero-rate-a11y.spec.ts` (which only ran the
 * axe scan) into the full T072a matrix for the DYNAMIC issue-invoice dialog:
 *
 *   1. axe-core WCAG 2.0/2.1 A+AA — zero violations (before AND after the admin
 *      selects zero-rate, which progressively reveals the MFA-cert fields);
 *   2. WCAG 2.5.5 Target Size — every NEW control (zero-rate radio label,
 *      cert-no, cert-date, cert-scan button, typed-phrase confirm) is ≥44×44px;
 *   3. WCAG 1.4.10 Reflow / SC-011 — at 320 and 375 CSS px, the page has no
 *      horizontal scroll (`document.scrollWidth ≤ window.innerWidth`);
 *   4. WCAG 1.4.4 Resize Text 200% — root font doubled, dialog stays usable
 *      (no clipping, no page h-scroll);
 *   5. keyboard reach + focus — the revealed cert fields are focusable;
 *   6. aria-live — the cert-reveal announce region is present.
 *
 * Preconditions: an authenticated admin with `invoicing.write`, the
 * `FEATURE_088_TAX_AT_PAYMENT` flag ON, and an **event** DRAFT invoice. The
 * toggle renders only when `taxAtPayment && !isMembership`
 * (`issue-invoice-form.tsx:142`), and `invoiceSubject` is a two-arm union
 * (`'membership' | 'event'`), so a membership draft can never reveal it.
 *
 * `scripts/seed-f4-e2e-admin-fixtures.ts` now provisions that draft and
 * `global-setup.ts` runs it, so the fixture is expected to be present. Two
 * things used to make this file report green while testing nothing, and both
 * are closed here:
 *
 *   - it took `.first()` of `?status=draft`, and the list orders by
 *     `desc(issueDate), desc(invoiceId)` with drafts' NULL issueDate sorting
 *     first under Postgres DESC — so WHICH draft it opened was decided by a
 *     random UUID. It now filters `&subject=event`, which the admin list
 *     already honours (`admin/invoices/page.tsx:277-280`).
 *   - a missing fixture was a silent skip. It is now a FAILURE when the seeder
 *     ran (`E2E_HAS_ADMIN_FIXTURES=1`), and a skip naming the seeder only when
 *     the fixture pipeline did not run at all.
 *
 * Note that test 1 is only half-gated: its `before` axe scan asserts BEFORE the
 * toggle check, so on the wrong draft it would have scanned the wrong dialog
 * rather than skipping.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures';
import { clearE2ERateLimits } from '../helpers/rate-limit';
import { signInViaForm, waitForLayoutContainer } from '../helpers/layout';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] as const;
const MIN_TARGET = 44;

/**
 * `global-setup.ts` sets this after `seed-f4-e2e-admin-fixtures.ts` exits 0 —
 * i.e. the run that is supposed to have provisioned the event draft.
 */
const FIXTURES_SEEDED = process.env.E2E_HAS_ADMIN_FIXTURES === '1';
const MISSING_DRAFT =
  'no EVENT draft at /admin/invoices?status=draft&subject=event — run ' +
  '`pnpm exec tsx --env-file=.env.local scripts/seed-f4-e2e-admin-fixtures.ts` ' +
  '(global-setup runs it too)';

/**
 * The fixture gate. When the seeder ran, a missing draft is a DEFECT and must
 * fail — a skip here is what let all six a11y tests report green while
 * asserting nothing. When the seeder did not run (no DATABASE_URL, someone
 * invoking the file directly), skip and say what to run.
 */
function gateOnDraft(hasDraft: boolean): void {
  if (hasDraft) return;
  expect(FIXTURES_SEEDED, `[088 a11y fixture] ${MISSING_DRAFT}`).toBe(false);
  test.skip(true, MISSING_DRAFT);
}

/**
 * Same policy for the five tests that go through `openIssueDialogAtZeroRate`.
 * Only `no-draft` is treated as a fixture defect: `no-toggle` can legitimately
 * mean `FEATURE_088_TAX_AT_PAYMENT` is off, and `not-issuable` can mean the
 * signed-in role lacks `invoicing.write` — environment choices, not a bad
 * fixture, so those stay skips.
 */
function gateOnState(state: 'no-draft' | 'not-issuable' | 'no-toggle' | 'revealed'): void {
  if (state === 'revealed') return;
  if (state === 'no-draft') gateOnDraft(false);
  test.skip(true, `precondition not met (${state})`);
}

/**
 * Sign in, open a DRAFT invoice's issue dialog, and (if the vat_treatment
 * toggle is present) select zero-rate so the cert fields reveal. Returns a
 * status describing how far it got so callers can graceful-skip.
 */
async function openIssueDialogAtZeroRate(
  page: Page,
): Promise<'no-draft' | 'not-issuable' | 'no-toggle' | 'revealed'> {
  await signInViaForm(
    page,
    '/admin/sign-in',
    ADMIN_EMAIL!,
    ADMIN_PASSWORD!,
    /^\/admin(\/|$)/,
  );

  await page.goto('/admin/invoices?status=draft&subject=event');
  await waitForLayoutContainer(page);
  await page.waitForLoadState('networkidle');

  const draftLink = page.getByRole('link', { name: /SC-|draft/i }).first();
  const hasDraft = await draftLink
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasDraft) return 'no-draft';

  await draftLink.click();
  await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/);
  await waitForLayoutContainer(page);

  const issueTrigger = page.getByRole('button', { name: /^Issue…?$/ });
  const canIssue = await issueTrigger
    .waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!canIssue) return 'not-issuable';
  await issueTrigger.click();

  await expect(
    page.getByRole('alertdialog').or(page.getByRole('dialog')),
  ).toBeVisible();

  const zeroRateRadio = page.getByRole('radio', { name: /Zero-rated/i });
  const hasToggle = await zeroRateRadio
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (!hasToggle) return 'no-toggle';

  await zeroRateRadio.check();
  await expect(page.getByTestId('zero-rate-cert-fields')).toBeVisible();
  return 'revealed';
}

/** WCAG 2.5.5 — assert a control's rendered box is ≥ MIN_TARGET on both axes. */
async function expectTargetSize(locator: Locator, label: string): Promise<void> {
  await expect(locator, `${label} visible`).toBeVisible();
  // A target size belongs to the settled layout. Checking the zero-rate radio
  // reveals the certificate fields and reflows the dialog, and one read taken
  // during that reflow saw the label's bare 20px line box (relay R33). Poll
  // until the box settles; a control that never reaches 44px still fails at
  // the timeout. 0.5px epsilon absorbs sub-pixel rounding across engines.
  const side = (axis: 'height' | 'width') => async () => (await locator.boundingBox())?.[axis] ?? 0;
  await expect
    .poll(side('height'), { message: `${label} height ≥ ${MIN_TARGET}px`, timeout: 5000 })
    .toBeGreaterThanOrEqual(MIN_TARGET - 0.5);
  await expect
    .poll(side('width'), { message: `${label} width ≥ ${MIN_TARGET}px`, timeout: 5000 })
    .toBeGreaterThanOrEqual(MIN_TARGET - 0.5);
}

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

    await page.goto('/admin/invoices?status=draft&subject=event');
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    const draftLink = page.getByRole('link', { name: /SC-|draft/i }).first();
    const hasDraft = await draftLink
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    gateOnDraft(hasDraft);

    await draftLink.click();
    await page.waitForURL(/\/admin\/invoices\/[0-9a-f-]+$/);
    await waitForLayoutContainer(page);

    const issueTrigger = page.getByRole('button', { name: /^Issue…?$/ });
    const canIssue = await issueTrigger
      .waitFor({ state: 'visible', timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    test.skip(!canIssue, 'invoice is not an issuable draft');
    await issueTrigger.click();

    await expect(
      page.getByRole('alertdialog').or(page.getByRole('dialog')),
    ).toBeVisible();
    const before = await new AxeBuilder({ page })
      .withTags([...AXE_TAGS])
      .analyze();
    expect(
      before.violations,
      'issue dialog (standard) has zero WCAG 2.1 AA violations',
    ).toEqual([]);

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

  test('every new control meets the WCAG 2.5.5 ≥44px target size', async ({
    page,
  }) => {
    const state = await openIssueDialogAtZeroRate(page);
    gateOnState(state);

    // The zero-rate radio's target is its enclosing clickable <label> (the
    // native input is 16px; AURA's `touchHeight="always"` makes the label
    // 44px, `.is-touch-always`). Measure the label.
    const zeroRateLabel = page
      .locator('label')
      .filter({ has: page.getByRole('radio', { name: /Zero-rated/i }) });
    await expectTargetSize(zeroRateLabel, 'zero-rate radio label');
    // An AURA field's target is its bordered box (`.aura-input`), which the
    // input fills (spec 122 US8b); the input inside is the box less its 1px
    // border. Measure the box, as the legacy bordered <input> was measured.
    const fieldBox = (label: RegExp) =>
      page.locator('.aura-input').filter({ has: page.getByLabel(label) });
    await expectTargetSize(fieldBox(/MFA certificate number/i), 'cert-no input');
    await expectTargetSize(fieldBox(/Certificate date/i), 'cert-date input');
    await expectTargetSize(
      page.getByRole('button', { name: /Attach certificate scan/i }),
      'cert-scan button',
    );
    await expectTargetSize(fieldBox(/to confirm/i), 'typed-phrase confirm input');
  });

  for (const width of [320, 375] as const) {
    test(`no horizontal scroll at ${width}px (WCAG 1.4.10 reflow / SC-011)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const state = await openIssueDialogAtZeroRate(page);
      gateOnState(state);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      // Strict SC-011 target is scrollWidth ≤ innerWidth; allow 1px rounding.
      expect(overflow, `page overflow at ${width}px`).toBeLessThanOrEqual(1);
    });
  }

  test('remains usable at 200% text zoom (WCAG 1.4.4 resize text)', async ({
    page,
  }) => {
    // At 393px this used to overflow 67px: the staff top bar did not wrap and
    // the invoice detail totals behind the dialog ran past the screen (the
    // dialog itself contributed 0). Both were fixed in #530, so this runs as a
    // plain assertion on every project again.
    const state = await openIssueDialogAtZeroRate(page);
    gateOnState(state);

    // Text-only zoom: double the root font size (Tailwind sizing is rem/em
    // based, so this scales text without a layout-zoom). The dialog is
    // overflow-y-auto, so content must remain reachable, not clipped.
    await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
    await expect(page.getByLabel(/MFA certificate number/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Issue (bill|invoice)( · [\d,]+\.\d{2} THB)?$/ })).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(overflow, 'page overflow at 200% zoom').toBeLessThanOrEqual(1);
  });

  test('the revealed cert fields are keyboard-focusable with an aria-live announce', async ({
    page,
  }) => {
    const state = await openIssueDialogAtZeroRate(page);
    gateOnState(state);

    // The progressive-disclosure reveal is announced via a polite live region.
    await expect(
      page.locator('[role="status"][aria-live="polite"]').first(),
    ).toBeAttached();

    // The cert number enters the tab order and is focusable (the visible ring
    // is asserted structurally via the focus-visible utility on the Input).
    const certNo = page.getByLabel(/MFA certificate number/i);
    await certNo.focus();
    expect(
      await certNo.evaluate((el) => el === document.activeElement),
    ).toBe(true);
  });
});
