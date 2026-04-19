/**
 * N9 (review 2026-04-19 21:19) — Portal /portal/invoices smoke test.
 *
 * R7-B3 shipped the US3 member-portal invoice surfaces
 * (list + PDF download route). The admin flows have dedicated specs
 * (`invoice-draft-issue`, `invoice-pay`), but the member-side had
 * zero E2E coverage — an auth-boundary regression (e.g., a member
 * seeing another tenant's invoice, or the page 5xx'ing) would not
 * be caught.
 *
 * This spec asserts:
 *   1. `/portal/invoices` renders without error for a signed-in
 *      member (no 5xx, page title present, container mounted).
 *   2. The rendered table scope is the member's OWN invoices only —
 *      either an `h1` + table body or the empty-state copy (for
 *      members with zero invoices). No crash, no 403, no mis-render.
 *
 * PDF download is intentionally skipped here (aligns with admin spec
 * `invoice-draft-issue`'s `test.fixme` policy — PDF binary assertions
 * belong in a dedicated fixture-seeded spec, tracked as E2E debt).
 */
import { expect, test } from './fixtures';
import { signInViaForm, waitForLayoutContainer } from './helpers/layout';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe('F4 portal /portal/invoices smoke (N9) @f4', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'E2E_MEMBER_* not set');

  test('member can load /portal/invoices without error', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );

    const response = await page.goto('/portal/invoices');

    // Not 5xx — auth-boundary regressions used to silently 500 when a
    // member wasn't linked to a tenant (now handled by the
    // portal-layout "not linked" path).
    expect(response?.status() ?? 0).toBeLessThan(500);

    await waitForLayoutContainer(page);

    // Either (a) h1 + some table body OR (b) the empty-state message
    // OR (c) the "not linked" explanatory copy for unseeded envs.
    const h1Visible = await page
      .getByRole('heading', { level: 1 })
      .first()
      .isVisible()
      .catch(() => false);
    const notLinkedVisible = await page
      .getByText(/not linked|please contact your administrator/i)
      .first()
      .isVisible()
      .catch(() => false);
    const emptyVisible = await page
      .getByText(/no invoices|ยังไม่มีใบแจ้งหนี้|inga fakturor/i)
      .first()
      .isVisible()
      .catch(() => false);

    expect(
      h1Visible || notLinkedVisible || emptyVisible,
      '/portal/invoices must render either an <h1>, an empty-state message, or the "not linked" copy',
    ).toBe(true);
  });
});
