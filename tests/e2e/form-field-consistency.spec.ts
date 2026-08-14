/**
 * T074 — E2E: F4 SC-012 form field 36px height + identical label gap + error state.
 */
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

// Super admin since 016 D4: this suite audits the form on
// /admin/settings/invoicing, which is `settings.invoicing` = super_admin-only
// (a plain admin now 404s there).
const ADMIN_EMAIL = process.env.E2E_SUPER_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_SUPER_ADMIN_PASSWORD;

test.describe('F4 SC-012 — form field consistency @layout', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_SUPER_ADMIN_* not set');

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  test('inputs on fees page compute 36px height + 12px inline padding', async ({ page }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByRole('textbox', { name: /^password$/i }).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL((u) => { const p = new URL(u).pathname; return /^\/admin(\/|$)/.test(p) && !p.startsWith("/admin/sign-in"); });

    await page.goto('/admin/settings/invoicing');
    // Wait for the form inputs to mount (loading.tsx skeleton swaps for the
    // real invoice-settings form). `#vat_rate` was the F2-era FeeConfigForm
    // id — F4's form maps the API field to element id `vat_percent`
    // (invoice-settings-form.tsx FIELD_ID_MAP), so the old wait timed out
    // forever once that form shipped.
    await page.waitForLoadState('networkidle');
    await page.locator('#vat_percent').waitFor({ timeout: 10_000 });
    // Scope to visible inputs only — hidden inputs (search Select combobox
    // hidden in Base UI, inputs inside closed dialogs, etc.) have
    // getBoundingClientRect().height === 0 and aren't part of the form
    // field consistency check.
    const inputs = page.locator('input[type="text"]:visible, input[type="number"]:visible, input:not([type]):visible');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++) {
      const el = inputs.nth(i);
      const { height, paddingInlineStart } = await el.evaluate((node) => {
        const cs = getComputedStyle(node);
        return { height: node.getBoundingClientRect().height, paddingInlineStart: cs.paddingInlineStart };
      });
      // Base UI renders a 1px form-association input under composite widgets
      // (Select/Switch). Playwright's `:visible` counts it (not display:none),
      // a human never sees it — it is not a form FIELD, skip it.
      if (height < 2) continue;
      // TWO sanctioned heights since 088 T072a: the 36px default (h-9) and
      // the deliberate ≥44px `min-h-11` on key inputs (numbering prefixes,
      // tax id, the bank block — WCAG 2.5.5 target size, asserted from the
      // other side by invoicing/invoice-settings-a11y.spec.ts). The pre-088
      // blanket ==36 contract read that intentional 44 as a defect. Anything
      // OUTSIDE the pair is still an inconsistency and fails.
      expect(
        Math.abs(height - 36) < 0.5 || height >= 43.5,
        `input ${i} height ${height}px must be 36 (default) or ≥44 (T072a target)`,
      ).toBe(true);
      expect(paddingInlineStart, `input ${i} padding-inline`).toBe('12px');
    }
  });
});
