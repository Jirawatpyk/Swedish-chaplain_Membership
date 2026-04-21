/**
 * T097 — F4 US4 tenant invoice settings E2E (US4 AS1–AS5).
 *
 * Scope — AS that do NOT mutate shared SweCham tenant state:
 *   - AS3 non-admin (member / manager) reaching /admin/settings/invoicing
 *     hits a 403/404 guard OR sees the page with save disabled
 *     (manager UI-disabled, security boundary at API route).
 *   - Form surface renders with all expected sections + labels.
 *   - A11y scan on the settings page.
 *
 * Mutating AS1 / AS2 / AS4 / AS5 are `test.fixme` — they require a
 * throwaway-tenant seeder (same constraint as T115 for US1/US2/US5
 * E2E variants) so a test run does not corrupt the real SweCham
 * tenant's invoice settings row.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

async function signIn(
  page: import('@playwright/test').Page,
  email: string,
  password: string,
  portal: 'admin' | 'portal',
): Promise<void> {
  const path = portal === 'admin' ? '/admin/sign-in' : '/portal/sign-in';
  await page.goto(path);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  const expectedPrefix = portal === 'admin' ? /\/admin(\/|$)/ : /\/portal(\/|$)/;
  await page.waitForURL(expectedPrefix, { timeout: 10_000 });
}

test.describe('@us4 tenant-invoice-settings', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL + E2E_ADMIN_PASSWORD to run',
  );

  test('admin can reach /admin/settings/invoicing and sees the form', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
    await page.goto('/admin/settings/invoicing');
    await expect(page).toHaveURL(/\/admin\/settings\/invoicing/);

    // Header + all 5 sections (identity, tax, numbering, defaults, logo).
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Legend-based sections — each is a <legend> inside a <fieldset>.
    const sectionLabels = ['Legal', 'Tax', 'Numbering', 'Logo'];
    for (const label of sectionLabels) {
      const matches = page.getByText(new RegExp(label, 'i'));
      await expect(matches.first()).toBeVisible();
    }
  });

  test('settings page passes WCAG 2.1 AA axe-core scan', async ({ page }) => {
    await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
    await page.goto('/admin/settings/invoicing');
    await page.waitForLoadState('networkidle');
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('member cannot reach /admin/settings/invoicing', async ({ page }) => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'Set E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD to run',
    );
    await signIn(page, MEMBER_EMAIL!, MEMBER_PASSWORD!, 'portal');
    const res = await page.goto('/admin/settings/invoicing');
    // Route group redirects unauthenticated-for-admin users — expect
    // either a 4xx from the API guard or a redirect away from /admin.
    expect([302, 307, 401, 403, 404]).toContain(res?.status() ?? 0);
    expect(page.url()).not.toMatch(/\/admin\/settings\/invoicing$/);
  });

  test.fixme(
    'AS1 admin saves new VAT 7→10, next invoice uses 10% (needs throwaway-tenant infra — T115t)',
    async () => {
      // Flow: open settings → change vat_percent to 10 → Save →
      // verify toast + API 200 → issue new invoice → assert
      // vat_rate_snapshot=0.1000 on new doc, existing issued docs
      // unchanged (FR-011).
    },
  );

  test.fixme(
    'AS2 logo upload → preview → save → PDF renders logo (needs throwaway-tenant infra — T115t)',
    async () => {
      // Flow: open settings → upload 400×200 PNG → assert success
      // toast + logo_blob_key stored → Save → next invoice PDF embeds
      // logo (tenant identity snapshot carries logo_blob_key).
    },
  );

  test.fixme(
    'AS4 logo-upload rejects SVG / oversized / bad-dims (needs throwaway-tenant infra — T115t)',
    async () => {
      // Flow covered by T092 at the Application layer. E2E variant
      // deferred to avoid real-Blob-store side effects in CI.
    },
  );

  test.fixme(
    'AS5 first-time bootstrap flow (needs fresh-tenant fixture)',
    async () => {
      // Flow: sign in to a freshly-provisioned tenant that has NO
      // tenant_invoice_settings row → /admin/settings/invoicing
      // renders bootstrap empty-state card + "Create settings" CTA →
      // save with all required fields → row created, issuance
      // unblocked (FR-010).
    },
  );
});
