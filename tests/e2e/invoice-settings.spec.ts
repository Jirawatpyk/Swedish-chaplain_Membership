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
import { createThrowawayTenant } from './helpers/throwaway-tenant';

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

  // T115t — AS1 un-fixme'd. Tests the settings-change UI path only
  // (API + DB + FR-011 snapshot immutability on existing issued docs
  // is covered behaviorally by integration tests —
  // settings-form.test.ts + vat-source-chain.test.ts T123).
  test.describe('AS1 VAT change via throwaway tenant', () => {
    test.skip(
      process.env.E2E_X_TENANT_HEADER_ENABLED !== '1',
      'E2E_X_TENANT_HEADER_ENABLED=1 required for throwaway-tenant (T115t)',
    );

    test('AS1 — admin changes VAT 7→10 on settings form', async ({ page }) => {
      const tenant = await createThrowawayTenant({ seedSettings: true });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');
        await expect(page).toHaveURL(/\/admin\/settings\/invoicing/);

        // Replace the pre-seeded 7.00 value with 10.00.
        const vatField = page.getByLabel(/VAT rate|อัตรา VAT|momssats/i);
        await vatField.fill('10.00');
        await page.getByRole('button', { name: /^(save|บันทึก|spara)$/i }).click();
        await page.waitForLoadState('networkidle');
        await expect(
          page.getByText(/saved|บันทึกแล้ว|sparad/i).first(),
        ).toBeVisible({ timeout: 10_000 });

        // Re-fetch the page — the VAT field should persist at 10.00
        // (round-trip through PATCH /api/tenant-invoice-settings →
        // DB → GET /api/tenant-invoice-settings).
        await page.reload();
        await expect(vatField).toHaveValue(/10\.00|10/);
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });
  });

  // T115t — AS2 (happy path) + AS4 (rejection paths) un-fixme'd via
  // throwaway-tenant fixture. Real Blob writes land in the throwaway
  // tenant's prefix (`invoicing/{throwaway-slug}/logos/...`) — blob
  // residue under a short-lived slug is acceptable (slug is unique
  // per test so no cross-test contamination) and `cleanup()` below
  // drops the settings row reference; orphaned blob bytes get swept
  // by the tenant-wide purge job.
  test.describe('AS2 + AS4 logo upload via throwaway tenant', () => {
    test.skip(
      process.env.E2E_X_TENANT_HEADER_ENABLED !== '1',
      'E2E_X_TENANT_HEADER_ENABLED=1 required for throwaway-tenant (T115t)',
    );

    // Generate PNG bytes inline via sharp — avoids checked-in fixture
    // files + guarantees deterministic bytes regardless of CI image.
    async function makePng(width: number, height: number): Promise<Buffer> {
      const sharp = (await import('sharp')).default;
      return sharp({
        create: {
          width,
          height,
          channels: 3,
          background: { r: 0x2e, g: 0x4a, b: 0x7a },
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
    }

    test('AS2 — upload 400×200 PNG → success toast + logo_blob_key stored + save persists', async ({
      page,
    }) => {
      const tenant = await createThrowawayTenant({ seedSettings: true });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');
        await expect(page).toHaveURL(/\/admin\/settings\/invoicing/);

        const validPng = await makePng(400, 200);
        await page.locator('input#logo_file').setInputFiles({
          name: 'logo.png',
          mimeType: 'image/png',
          buffer: validPng,
        });

        // Success toast + current-key status both surface.
        await expect(
          page.getByText(/logo uploaded|อัปโหลดโลโก้แล้ว|logotyp uppladdad/i).first(),
        ).toBeVisible({ timeout: 15_000 });
        const keyLabel = page.locator('#logo_status').getByText(
          new RegExp(`invoicing/${tenant.slug}/logos/`),
        );
        await expect(keyLabel).toBeVisible({ timeout: 5_000 });

        // Save and verify persistence via page reload — the hidden
        // `logo_blob_key` should survive the PATCH round-trip.
        await page.getByRole('button', { name: /^(save|บันทึก|spara)$/i }).click();
        await page.waitForLoadState('networkidle');
        await expect(
          page.getByText(/saved|บันทึกแล้ว|sparad/i).first(),
        ).toBeVisible({ timeout: 10_000 });

        await page.reload();
        await expect(
          page.locator('#logo_status').getByText(
            new RegExp(`invoicing/${tenant.slug}/logos/`),
          ),
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('AS4 — SVG rejected with mime_rejected error', async ({ page }) => {
      const tenant = await createThrowawayTenant({ seedSettings: true });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');
        await expect(page).toHaveURL(/\/admin\/settings\/invoicing/);

        const svgBytes = Buffer.from(
          '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"/>',
        );
        await page.locator('input#logo_file').setInputFiles({
          name: 'logo.svg',
          mimeType: 'image/svg+xml',
          buffer: svgBytes,
        });

        // MIME whitelist rejects → `mime_rejected` localised error.
        await expect(page.locator('p[role="alert"]').first()).toBeVisible({
          timeout: 10_000,
        });
        // Status line should NOT show a logo_blob_key — upload failed.
        await expect(
          page.locator('#logo_status').getByText(
            new RegExp(`invoicing/${tenant.slug}/logos/`),
          ),
        ).toHaveCount(0);
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('AS4 — 2400×600 PNG rejected with dimensions_out_of_range error', async ({
      page,
    }) => {
      const tenant = await createThrowawayTenant({ seedSettings: true });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');
        await expect(page).toHaveURL(/\/admin\/settings\/invoicing/);

        // Width 2400 > MAX_WIDTH=2000 → dimensions_out_of_range.
        const oversizePng = await makePng(2400, 600);
        await page.locator('input#logo_file').setInputFiles({
          name: 'too-wide.png',
          mimeType: 'image/png',
          buffer: oversizePng,
        });

        await expect(page.locator('p[role="alert"]').first()).toBeVisible({
          timeout: 15_000,
        });
        await expect(
          page.locator('#logo_status').getByText(
            new RegExp(`invoicing/${tenant.slug}/logos/`),
          ),
        ).toHaveCount(0);
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });

    test('AS4 — 100×50 PNG rejected (below MIN dimensions)', async ({ page }) => {
      const tenant = await createThrowawayTenant({ seedSettings: true });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');

        // 100 < MIN_WIDTH=200 AND 50 < MIN_HEIGHT=100 → both fail.
        const tinyPng = await makePng(100, 50);
        await page.locator('input#logo_file').setInputFiles({
          name: 'too-small.png',
          mimeType: 'image/png',
          buffer: tinyPng,
        });

        await expect(page.locator('p[role="alert"]').first()).toBeVisible({
          timeout: 15_000,
        });
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });
  });

  // T115t — AS5 un-fixme'd via throwaway-tenant fixture + X-Tenant
  // header override. Gated on E2E_X_TENANT_HEADER_ENABLED=1 in
  // .env.local (env validator refuses the flag in production so a
  // forgotten flag cannot be weaponised as a tenant-override vector).
  test.describe('AS5 bootstrap via throwaway tenant', () => {
    test.skip(
      process.env.E2E_X_TENANT_HEADER_ENABLED !== '1',
      'E2E_X_TENANT_HEADER_ENABLED=1 required for throwaway-tenant (T115t)',
    );

    test('AS5 — first-time bootstrap: empty-state → fill + save → row created', async ({
      page,
    }) => {
      // No settings row seeded → empty-state path.
      const tenant = await createThrowawayTenant({ seedSettings: false });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');
        await expect(page).toHaveURL(/\/admin\/settings\/invoicing/);

        // Fill every required field + Save (first write creates the
        // row per R7-B2, unlocking issuance per FR-010).
        await page.getByLabel(/VAT rate|อัตรา VAT|momssats/i).fill('7.00');
        await page
          .getByLabel(/tax id|เลขประจำตัวผู้เสียภาษี|skatte.*id/i)
          .fill('0105500000000');
        await page
          .getByLabel(/^(legal name|ชื่อ|juridiskt namn).* Thai.*/i)
          .fill('ทดสอบ Throwaway');
        await page
          .getByLabel(/^(legal name|ชื่อ|juridiskt namn).* English.*/i)
          .fill('Throwaway Test');
        await page
          .getByLabel(/^(address|ที่อยู่|adress).* Thai.*/i)
          .fill('1 ถนนทดสอบ, กรุงเทพฯ');
        await page
          .getByLabel(/^(address|ที่อยู่|adress).* English.*/i)
          .fill('1 Test Rd, Bangkok');
        await page.getByLabel(/invoice.*prefix/i).fill('E2E');
        await page.getByLabel(/credit.*prefix/i).fill('E2EC');

        await page.getByRole('button', { name: /^(save|บันทึก|spara)$/i }).click();
        await page.waitForLoadState('networkidle');
        await expect(
          page.getByText(/saved|บันทึกแล้ว|sparad/i).first(),
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });
  });
});
