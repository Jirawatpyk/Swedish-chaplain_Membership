/**
 * T018 — E2E: F5 FR-027 "Pay online" email deep-link.
 *
 * Covers the post-critique (2026-04-23) requirement that the F4
 * `invoice_issued` auto-email includes a bilingual "Pay online" CTA
 * pointing at `/portal/invoices/[id]?pay=1&utm_*` whenever the sending
 * tenant has `online_payment_enabled = true`.
 *
 * Scope split:
 *   1. **Deterministic render assertions** (executable today) — drive
 *      `buildInvoiceAutoEmail` through the Node-context layer so we
 *      assert the rendered HTML without needing a seeded invoice or
 *      test email sink. This covers:
 *        a. EN / TH / SV CTA copy present
 *        b. Exact href = `{origin}/portal/invoices/{id}?pay=1&utm_*`
 *        c. CTA ABSENT when tenant has `online_payment_enabled=false`
 *   2. **End-to-end click-through** (signed-out returnUrl preservation +
 *      signed-in direct land) — marked `test.fixme` pending the F4 e2e
 *      seeder (T115) that provisions an `issued` invoice on a throwaway
 *      tenant. Follows the same pattern already used by
 *      `invoice-pay.spec.ts` for F4 AS1–AS3.
 *
 * Convention per project rules: always run with `--workers=1` (the
 * default of 3 hangs developer machines). Covered by the shared
 * Playwright config in the repo root.
 */
import { expect, test } from './fixtures';
import { signInAsMember } from './helpers/member-session';
import {
  buildInvoiceAutoEmail,
  buildPayOnlineUrl,
} from '@/modules/invoicing/infrastructure/email/invoice-auto-email';

const INVOICE_ID = 'inv_01HQTESTT018E2ED33PL1NK';
/**
 * R5 (2026-04-25): real seeded invoice id used by the click-through
 * specs (formerly fixme'd pending T115 throwaway-tenant infra). The
 * pre-existing `E2E_ISSUED_INVOICE_ID` fixture (seeded by
 * `pnpm tsx scripts/seed-e2e-portal-invoices.ts`) already provides
 * exactly the row shape the tests need (issued, member-owned, tenant
 * with online_payment_enabled=true), so a throwaway-tenant pipeline
 * is not strictly required to assert the deep-link returnUrl
 * round-trip.
 */
const SEEDED_INVOICE_ID = process.env.E2E_ISSUED_INVOICE_ID;
const DOWNLOAD_URL = 'https://blob.test/invoice-issued.pdf';

/**
 * Base URL used to compose the pay-online link. The test runs against
 * the Playwright baseURL (usually `http://localhost:3100`); we use that
 * same origin so the `?returnUrl=` round-trip in the sign-in flow is
 * byte-identical to what a real member clicks from their inbox.
 */
function payUrlFor(page: import('@playwright/test').Page): string {
  const origin = new URL(page.url() || 'http://localhost:3100').origin;
  return buildPayOnlineUrl(origin, INVOICE_ID);
}

test.describe('@us-f5 @fr-027 pay-online email deep-link — render', () => {
  test('EN email renders CTA with exact href + utm params (online_payment_enabled=true)', async ({
    page,
  }) => {
    // Navigate first so the test has a stable origin for URL composition.
    await page.goto('/');
    const expectedHref = payUrlFor(page);

    const built = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_issued',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      tenantOnlinePaymentEnabled: true,
      payOnlineUrl: expectedHref,
    });

    expect(built.html).toContain('Pay online now');
    // React Email HTML-encodes `&` as `&amp;` inside href — compare encoded.
    expect(built.html).toContain(`href="${expectedHref.replace(/&/g, '&amp;')}"`);
    expect(expectedHref).toContain('?pay=1&');
    expect(expectedHref).toContain('utm_source=invoice_email');
    expect(expectedHref).toContain('utm_medium=email');
    expect(expectedHref).toContain('utm_campaign=f5_pay_online');
  });

  test('TH email renders "ชำระเงินออนไลน์" CTA when tenant enabled', async ({ page }) => {
    await page.goto('/');
    const expectedHref = payUrlFor(page);
    const built = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_issued',
      downloadUrl: DOWNLOAD_URL,
      locale: 'th',
      tenantOnlinePaymentEnabled: true,
      payOnlineUrl: expectedHref,
    });
    expect(built.html).toContain('ชำระเงินออนไลน์');
    // React Email HTML-encodes `&` as `&amp;` inside href — compare encoded.
    expect(built.html).toContain(`href="${expectedHref.replace(/&/g, '&amp;')}"`);
  });

  test('SV email renders "Betala online" CTA when tenant enabled', async ({ page }) => {
    await page.goto('/');
    const expectedHref = payUrlFor(page);
    const built = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_issued',
      downloadUrl: DOWNLOAD_URL,
      locale: 'sv',
      tenantOnlinePaymentEnabled: true,
      payOnlineUrl: expectedHref,
    });
    expect(built.html).toContain('Betala online');
    // React Email HTML-encodes `&` as `&amp;` inside href — compare encoded.
    expect(built.html).toContain(`href="${expectedHref.replace(/&/g, '&amp;')}"`);
  });

  test('tenant online_payment_enabled=false → CTA absent from email', async ({ page }) => {
    await page.goto('/');
    const candidateHref = payUrlFor(page);
    const built = await buildInvoiceAutoEmail({
      toEmail: 'member@example.com',
      eventType: 'invoice_issued',
      downloadUrl: DOWNLOAD_URL,
      locale: 'en',
      tenantOnlinePaymentEnabled: false,
      payOnlineUrl: candidateHref,
    });
    // Every localised label must be absent; utm signature must not leak.
    expect(built.html).not.toContain('Pay online now');
    expect(built.html).not.toContain('ชำระเงินออนไลน์');
    expect(built.html).not.toContain('Betala online');
    expect(built.html).not.toContain('utm_campaign=f5_pay_online');
    // The pre-F5 download CTA remains — the email is unchanged from F4.
    expect(built.html).toContain(DOWNLOAD_URL);
  });
});

test.describe('@us-f5 @fr-027 pay-online email deep-link — click-through', () => {
  // R5 fix (2026-04-25): both specs use the existing seeded invoice
  // (`E2E_ISSUED_INVOICE_ID`) — no throwaway-tenant infra required.
  // Skip cleanly if the env var is missing so a dev running the suite
  // without `pnpm tsx scripts/seed-e2e-portal-invoices.ts` doesn't see
  // a hard failure.
  test.skip(
    !SEEDED_INVOICE_ID,
    'E2E_ISSUED_INVOICE_ID missing — run `pnpm tsx scripts/seed-e2e-portal-invoices.ts`',
  );

  test('signed-out: click CTA → sign-in page retains returnUrl → after sign-in lands on invoice detail with ?pay=1 + utm_* intact', async ({
    page,
  }) => {
    // 1. Compose CTA href the same way the email build does — use
    //    page.context()'s baseURL so the returnUrl exactly matches
    //    middleware-side normalization.
    await page.goto('/');
    const origin = new URL(page.url()).origin;
    const ctaHref = buildPayOnlineUrl(origin, SEEDED_INVOICE_ID!);

    // 2. Navigate to CTA while signed out — middleware should redirect
    //    to /sign-in with returnUrl preserving the entire query string
    //    (?pay=1 + utm_*).
    await page.goto(ctaHref);
    await page.waitForURL(/\/sign-in\?/, { timeout: 10_000 });

    // 3. Assert the returnUrl param round-trips the original path +
    //    query verbatim (decoded: `/portal/invoices/{id}?pay=1&utm_*`).
    const signInUrl = new URL(page.url());
    const returnUrl = signInUrl.searchParams.get('returnTo');
    expect(returnUrl).not.toBeNull();
    expect(returnUrl).toContain(`/portal/invoices/${SEEDED_INVOICE_ID}`);
    expect(returnUrl).toContain('pay=1');
    expect(returnUrl).toContain('utm_source=invoice_email');
    expect(returnUrl).toContain('utm_medium=email');
    expect(returnUrl).toContain('utm_campaign=f5_pay_online');

    // 4. Sign in WITHOUT navigating away — we are already on the
    //    sign-in page with `returnTo` in the URL. Calling
    //    `signInAsMember(page)` here would `page.goto('/portal/sign-in')`
    //    bare and DROP the query string. Fill the form in place so the
    //    server reads `returnTo` from the form action.
    const email = process.env.E2E_MEMBER_EMAIL!;
    const password = process.env.E2E_MEMBER_PASSWORD!;
    await page.getByLabel(/email/i).fill(email);
    await page.getByLabel(/password/i).fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();

    // 5. After sign-in, URL must settle on the invoice detail page
    //    with ?pay=1 + utm_* preserved.
    await page.waitForURL(
      new RegExp(`/portal/invoices/${SEEDED_INVOICE_ID}\\?pay=1`),
      { timeout: 15_000 },
    );
    const finalUrl = new URL(page.url());
    expect(finalUrl.pathname).toBe(`/portal/invoices/${SEEDED_INVOICE_ID}`);
    expect(finalUrl.searchParams.get('pay')).toBe('1');
    expect(finalUrl.searchParams.get('utm_source')).toBe('invoice_email');
    expect(finalUrl.searchParams.get('utm_medium')).toBe('email');
    expect(finalUrl.searchParams.get('utm_campaign')).toBe('f5_pay_online');
  });

  test('signed-in: click CTA → lands directly on /portal/invoices/{id}?pay=1 (no sign-in redirect)', async ({
    page,
  }) => {
    // Sign in BEFORE composing the CTA so the click-through skips
    // middleware redirect.
    await page.goto('/');
    await signInAsMember(page);

    const origin = new URL(page.url()).origin;
    const ctaHref = buildPayOnlineUrl(origin, SEEDED_INVOICE_ID!);

    // Navigate to CTA while signed in — should land on invoice detail
    // directly with no /sign-in detour.
    await page.goto(ctaHref);
    await page.waitForURL(
      new RegExp(`/portal/invoices/${SEEDED_INVOICE_ID}\\?pay=1`),
      { timeout: 10_000 },
    );

    const finalUrl = new URL(page.url());
    expect(finalUrl.pathname).toBe(`/portal/invoices/${SEEDED_INVOICE_ID}`);
    expect(finalUrl.searchParams.get('pay')).toBe('1');

    // h1 invoice-detail landmark visible (sanity — page actually
    // rendered, not just URL match). The Sheet drawer open assertion
    // belongs to US1 (payment-card-happy-path.spec.ts), not here.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
