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
import {
  buildInvoiceAutoEmail,
  buildPayOnlineUrl,
} from '@/modules/invoicing/infrastructure/email/invoice-auto-email';

const INVOICE_ID = 'inv_01HQTESTT018E2ED33PL1NK';
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
  test.fixme(
    'signed-out: click CTA → sign-in page retains returnUrl=/portal/invoices/{id}?pay=1&utm_* → after sign-in lands on invoice detail with ?pay=1 intact (needs F4 e2e seeder — T115)',
    async ({ page }) => {
      // TODO(T115): This flow requires a seeded `issued` invoice owned
      // by an F3 member on a throwaway tenant with
      // `tenant_payment_settings.online_payment_enabled=true`. Sketch:
      //   1. Seed tenant + member + issued invoice (inv_id known).
      //   2. Compose CTA href = buildPayOnlineUrl(baseURL, inv_id).
      //   3. Navigate page to CTA href while signed out.
      //   4. Assert URL matches /portal/sign-in?returnUrl=%2Fportal%2Finvoices%2F{inv_id}%3Fpay%3D1%26utm_source%3Dinvoice_email%26utm_medium%3Demail%26utm_campaign%3Df5_pay_online
      //   5. Sign in as the invoice's owner.
      //   6. Assert page settles on /portal/invoices/{inv_id} with
      //      `?pay=1` + utm_* query params intact (assert via URL().searchParams).
      void page;
    },
  );

  test.fixme(
    'signed-in: click CTA → lands directly on /portal/invoices/{id}?pay=1 (no sign-in redirect) (needs F4 e2e seeder — T115)',
    async ({ page }) => {
      // TODO(T115): Sign in as the invoice's owner first, then
      // navigate to the CTA href and assert:
      //   - URL matches /portal/invoices/{inv_id}?pay=1&utm_*
      //   - h1 / invoice-detail landmark is visible
      //   - (Sheet drawer open assertion is US1 territory — not here.)
      void page;
    },
  );
});
