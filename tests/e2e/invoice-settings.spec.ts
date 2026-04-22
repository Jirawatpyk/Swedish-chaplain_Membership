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
import { signInViaForm } from './helpers/layout';
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
  const landing = portal === 'admin' ? /^\/admin(\/|$)/ : /^\/portal(\/|$)/;
  await signInViaForm(page, path, email, password, landing);
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
    // Playwright auto-follows redirects and reports the terminal
    // response (200 sign-in / portal page) — assert on final URL
    // instead of the status code to verify the RBAC redirect.
    await page.goto('/admin/settings/invoicing');
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

        // Replace the pre-seeded 7.00 value with 10.00. On WebKit,
        // `.fill()` on `input[type=number]` updates the DOM value
        // but does NOT reliably fire React's onChange — the form
        // state stays at the initial 7.00 and PATCH sends the stale
        // value. Use click+keyboard to force the onChange.
        const vatField = page.getByLabel(/VAT rate|อัตรา VAT|momssats/i);
        await vatField.click();
        await vatField.press('Control+a');
        await vatField.press('Delete');
        await vatField.pressSequentially('10.00');
        await vatField.blur();
        // Intercept the PATCH response so we verify the save hit
        // the server with 200 OK (not 403 cross-tenant or 400
        // validation). Covers the "did the save succeed?" gate.
        const patchResponse = page.waitForResponse(
          (r) =>
            r.url().includes('/api/tenant-invoice-settings') &&
            !r.url().includes('/logo') &&
            r.request().method() === 'PATCH',
          { timeout: 15_000 },
        );
        await page.getByRole('button', { name: /^(save|บันทึก|spara)/i }).click();
        const resp = await patchResponse;
        expect(resp.ok()).toBe(true);
        await expect(
          page
            .getByText(
              /Invoice settings (updated|created)|การตั้งค่าเรียบร้อย|Fakturainställningar (uppdaterade|skapade)/i,
            )
            .first(),
        ).toBeVisible({ timeout: 10_000 });

        // Verify persistence via a direct GET API call with an
        // explicit X-Tenant header in the fetch options. WebKit's
        // Playwright setExtraHTTPHeaders can drop silently on some
        // requests, so the explicit header eliminates the
        // browser-quirk variable entirely.
        const throwawaySlug = tenant.slug;
        const getResp = await page.evaluate(async (slug) => {
          const r = await fetch('/api/tenant-invoice-settings', {
            method: 'GET',
            headers: {
              accept: 'application/json',
              'X-Tenant': slug,
            },
          });
          return { status: r.status, body: await r.json() };
        }, throwawaySlug);
        expect(getResp.status).toBe(200);
        expect(getResp.body?.settings?.vat_rate).toBe('0.1000');
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

        // Success is signalled by the persistent #logo_status key
        // label (the sonner toast is transient and can dismiss before
        // the assertion runs on slow first-compile of the logo route).
        const keyLabel = page.locator('#logo_status').getByText(
          new RegExp(`invoicing/${tenant.slug}/logos/`),
        );
        await expect(keyLabel).toBeVisible({ timeout: 20_000 });

        // Save and verify persistence via page reload — the hidden
        // `logo_blob_key` should survive the PATCH round-trip.
        await page.getByRole('button', { name: /^(save|บันทึก|spara)/i }).click();
        // Skip `waitForLoadState('networkidle')` — Next.js dev HMR
        // websocket keeps network active and never settles. The toast
        // assertion below is the real signal for save success.
        await expect(
          page
            .getByText(
              /Invoice settings (updated|created)|การตั้งค่าเรียบร้อย|Fakturainställningar (uppdaterade|skapade)/i,
            )
            .first(),
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
      // Mobile-safari cold-compiles /api/tenant-invoice-settings/logo
      // the first time it's hit in a dev-server session — widen well
      // beyond the default envelope.
      test.setTimeout(90_000);
      const tenant = await createThrowawayTenant({ seedSettings: true });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');
        await expect(page).toHaveURL(/\/admin\/settings\/invoicing/);

        const svgBytes = Buffer.from(
          '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"/>',
        );
        // Intercept the POST response directly — WebKit's
        // `setInputFiles` + React onChange rendering of the
        // error alert paragraph is flakier than the HTTP boundary.
        // Status codes per `src/app/api/tenant-invoice-settings/logo/route.ts:138`:
        // `mime_rejected` → 415.
        const responsePromise = page.waitForResponse(
          (r) =>
            r.url().includes('/api/tenant-invoice-settings/logo') &&
            r.request().method() === 'POST',
          { timeout: 75_000 },
        );
        await page.locator('input#logo_file').setInputFiles({
          name: 'logo.svg',
          mimeType: 'image/svg+xml',
          buffer: svgBytes,
        });
        const resp = await responsePromise;
        expect(resp.status()).toBe(415);
        const body = await resp.json();
        expect(body?.error?.code).toBe('mime_rejected');

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

    test('AS4 — 100×50 PNG rejected (below MIN dimensions)', async ({
      page,
    }) => {
      // Mobile-safari cold-compiles /api/tenant-invoice-settings/logo
      // the first time it's hit in a dev-server session — widen well
      // beyond the default envelope.
      test.setTimeout(90_000);
      const tenant = await createThrowawayTenant({ seedSettings: true });
      try {
        await page.setExtraHTTPHeaders({ 'X-Tenant': tenant.slug });
        await signIn(page, ADMIN_EMAIL!, ADMIN_PASSWORD!, 'admin');
        await page.goto('/admin/settings/invoicing');

        // 100 < MIN_WIDTH=200 AND 50 < MIN_HEIGHT=100 → both fail.
        const tinyPng = await makePng(100, 50);
        const responsePromise = page.waitForResponse(
          (r) =>
            r.url().includes('/api/tenant-invoice-settings/logo') &&
            r.request().method() === 'POST',
          { timeout: 75_000 },
        );
        await page.locator('input#logo_file').setInputFiles({
          name: 'too-small.png',
          mimeType: 'image/png',
          buffer: tinyPng,
        });
        // Wait for the server-side sharp dimension check to return.
        // First sharp invocation in the dev server can be slow; use a
        // generous 45s envelope above the 60s test timeout.
        const resp = await responsePromise;
        // 415 Unsupported Media Type for mime_rejected +
        // dimensions_out_of_range per src/app/api/tenant-invoice-settings/logo/route.ts:138.
        expect(resp.status()).toBe(415);
        const body = await resp.json();
        expect(body?.error?.code).toBe('dimensions_out_of_range');

        // Client-side alert rendering is the UX contract — confirm it
        // appears once the response lands.
        await expect(
          page.locator('fieldset').filter({ hasText: /Logo/i })
            .locator('p[role="alert"]').first(),
        ).toBeVisible({ timeout: 10_000 });
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
          .getByLabel(/^(legal name|ชื่อ|juridiskt namn).*Thai.*/i)
          .fill('ทดสอบ Throwaway');
        await page
          .getByLabel(/^(legal name|ชื่อ|juridiskt namn).*English.*/i)
          .fill('Throwaway Test');
        await page
          .getByLabel(/^(registered address|address|ที่อยู่|adress).*Thai.*/i)
          .fill('1 ถนนทดสอบ, กรุงเทพฯ');
        await page
          .getByLabel(/^(registered address|address|ที่อยู่|adress).*English.*/i)
          .fill('1 Test Rd, Bangkok');
        await page.getByLabel(/invoice.*prefix/i).fill('E2E');
        await page.getByLabel(/credit.*prefix/i).fill('E2EC');

        // Bootstrap path → button label is "Create settings" (no row
        // exists yet), not "Save settings".
        await page
          .getByRole('button', { name: /^(create|สร้าง|skapa)/i })
          .click();
        await expect(
          page
            .getByText(
              /Invoice settings (updated|created)|การตั้งค่าเรียบร้อย|Fakturainställningar (uppdaterade|skapade)/i,
            )
            .first(),
        ).toBeVisible({ timeout: 10_000 });
      } finally {
        await tenant.cleanup().catch(() => {});
      }
    });
  });
});
