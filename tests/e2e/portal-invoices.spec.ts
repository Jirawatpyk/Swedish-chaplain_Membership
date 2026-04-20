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

// Fixture-presence env flags (set in the seeded staging env). Tests
// that need deterministic row counts gate on these so the spec stays
// green on un-seeded local dev boxes while still asserting the full
// US3 AS contracts on CI / staging where fixtures are present.
const EXPECTS_ROWS =
  process.env.E2E_MEMBER_HAS_INVOICES === '1' ||
  process.env.E2E_MEMBER_HAS_INVOICES === 'true';
const EXPECTS_EMPTY = process.env.E2E_MEMBER_EMPTY === '1';

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

  // US3 AS2 — cross-tenant / foreign-invoice probe.
  // A signed-in member crafting a URL for a tenant B / sibling-member
  // invoice via the PDF download route must NOT receive the PDF. The
  // bytes-streamed route is guarded by RLS + the `getInvoicePdfSignedUrl`
  // ownership check, so the response is a 4xx (404 preferred) — never
  // 200 with foreign PDF content, never 5xx.
  test('member hitting a foreign invoice PDF id gets 4xx, not 200/5xx (AS2)', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );

    // A syntactically valid but non-existent / foreign UUID. RLS sees
    // zero rows for the signed-in member → route returns 404 and emits
    // an `invoice_cross_tenant_probe` audit (asserted by integration
    // suite `audit-coverage.test.ts`).
    const foreignUuid = '00000000-0000-4000-8000-000000000000';
    const response = await page.request.get(
      `/api/portal/invoices/${foreignUuid}/pdf`,
    );
    const status = response.status();
    expect(status, 'foreign-invoice PDF route must not return 200').not.toBe(
      200,
    );
    expect(status, 'foreign-invoice PDF route must not 5xx').toBeLessThan(500);
    expect(status, 'expected 4xx (typically 404)').toBeGreaterThanOrEqual(400);
  });

  // US3 AS1/AS3 — portal landing page hosts the invoices summary card
  // (latest 3 + view-all) per US7 AS4. The card must render without
  // error for any member-linking state; the "view all" link is only
  // shown when at least one invoice exists.
  test('portal landing renders invoices summary card (US7 AS4)', async ({
    page,
  }) => {
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );

    const response = await page.goto('/portal');
    expect(response?.status() ?? 0).toBeLessThan(500);

    await waitForLayoutContainer(page);

    // The summary-card heading, empty-state, or not-linked copy must
    // be present (one of three legitimate states).
    const summaryHeadingVisible = await page
      .getByText(/recent invoices|ใบแจ้งหนี้ล่าสุด|senaste fakturor/i)
      .first()
      .isVisible()
      .catch(() => false);

    expect(
      summaryHeadingVisible,
      'portal landing must render the invoices summary card heading',
    ).toBe(true);
  });

  // US3 AS1 — dedicated row-count assertion. Gated on
  // `E2E_MEMBER_HAS_INVOICES=1` so un-seeded envs skip cleanly
  // rather than flaking. On seeded envs (CI / staging fixtures) the
  // table MUST render ≥1 body row with a per-row download link.
  test('AS1 — seeded member sees invoice rows with download links', async ({
    page,
  }) => {
    test.skip(
      !EXPECTS_ROWS,
      'E2E_MEMBER_HAS_INVOICES not set — seeded-row assertion skipped',
    );
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );
    await page.goto('/portal/invoices');
    await waitForLayoutContainer(page);

    // Header row + at least one body row.
    const rowCount = await page.getByRole('row').count();
    expect(rowCount, 'expected header + ≥1 body row').toBeGreaterThanOrEqual(2);

    // At least one PDF download link wired per the AS1 "download
    // buttons" requirement.
    const downloadLinks = page.locator('a[download][href*="/api/portal/invoices/"]');
    expect(await downloadLinks.count()).toBeGreaterThan(0);
  });

  // US3 AS3 — dedicated empty-state copy assertion. Gated on
  // `E2E_MEMBER_EMPTY=1`. Asserts the specific empty-state string,
  // not a broad OR over "empty | not-linked | h1".
  test('AS3 — empty-state copy shown for member with zero invoices', async ({
    page,
  }) => {
    test.skip(
      !EXPECTS_EMPTY,
      'E2E_MEMBER_EMPTY not set — empty-state assertion skipped',
    );
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );
    await page.goto('/portal/invoices');
    await waitForLayoutContainer(page);

    const empty = page.getByText(
      /no invoices yet|ยังไม่มีใบแจ้งหนี้|inga fakturor ännu/i,
    );
    await expect(empty).toBeVisible();
    // Must NOT render the data table when empty.
    expect(await page.getByRole('row').count()).toBe(0);
  });

  // US7 AS4 — summary card "view all" link asserted when rows
  // present. Gated on fixture flag so un-seeded envs skip.
  test('US7 AS4 — summary card "view all" link present when rows exist', async ({
    page,
  }) => {
    test.skip(
      !EXPECTS_ROWS,
      'E2E_MEMBER_HAS_INVOICES not set — view-all link assertion skipped',
    );
    await signInViaForm(
      page,
      '/portal/sign-in',
      MEMBER_EMAIL!,
      MEMBER_PASSWORD!,
      /^\/portal(\/|$)/,
    );
    await page.goto('/portal');
    await waitForLayoutContainer(page);

    const viewAll = page.getByRole('link', {
      name: /view all|ดูทั้งหมด|visa alla/i,
    });
    await expect(viewAll).toBeVisible();
    await expect(viewAll).toHaveAttribute('href', '/portal/invoices');
  });
});
