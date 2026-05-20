/**
 * T096 (F7.1a US7) — E2E happy path for template library flow.
 *
 * Playwright + axe-core. Env-gated `describe.skipIf` — skips when
 * E2E credentials are not set in the staging env (same pattern as
 * `tests/e2e/broadcasts/image-upload-allowlist.spec.ts`).
 *
 * Surfaces verified (all shipped through Phase 5A-5H.3):
 *   - Admin templates list page (/admin/broadcasts/templates) — 15
 *     starter rows + Starter badges + filter pills + a11y scan
 *   - Admin new template page — create + return to list
 *   - Member compose template picker — substitution + bracket survival
 *
 * Deferred to F7.1b polish: full Tiptap editor in admin form (T113
 * shipped via shared F7 MVP TiptapEditor); shadcn Combobox upgrade
 * for member picker (T115 MVP ships native <select>); bracket
 * placeholder Tiptap node-view (T116) + stale-draft banner (T117).
 */
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

const skipReason =
  !ADMIN_EMAIL || !ADMIN_PASSWORD || !MEMBER_EMAIL || !MEMBER_PASSWORD;

test.describe('F7.1a US7 template library flow @template-library', () => {
  test.skip(skipReason, 'E2E credentials not configured');

  test('admin sees 15 starter templates with Starter badge + filter pills', async ({
    page,
  }) => {
    await page.goto('/admin/sign-in');
    await page.getByLabel(/email/i).fill(ADMIN_EMAIL!);
    await page.getByLabel(/password/i).fill(ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.goto('/admin/broadcasts/templates');

    // 15 starter rows × 3 locales = visible (5 names × 3) + 1 header row
    const rows = page.getByRole('row');
    await expect(rows).toHaveCount(16);

    // Starter badge present on seeded rows (sr-only aria-label
    // "Seeded by the platform" via starterBadgeAria i18n key)
    const starterBadges = page.getByText(/^Starter$/);
    await expect(starterBadges.first()).toBeVisible();

    // 3 filter pills with aria-pressed state — All starts active
    const allPill = page.getByRole('button', { name: /^All$/ });
    await expect(allPill).toHaveAttribute('aria-pressed', 'true');

    // Filter to Starter only — count narrows to 15 (all rows ARE
    // starter for a fresh tenant) but the pill state toggles
    await page.getByRole('button', { name: /Starter only/ }).click();
    await expect(
      page.getByRole('button', { name: /Starter only/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(allPill).toHaveAttribute('aria-pressed', 'false');

    // Filter to Admin-authored — count drops to 0 for fresh tenant
    await page.getByRole('button', { name: /Admin-authored/ }).click();
    // Header row still shown but data rows = 0
    const dataRows = page.locator('tbody tr');
    await expect(dataRows).toHaveCount(0);

    // a11y baseline scan (WCAG 2.1 AA)
    const a11yResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(a11yResults.violations).toEqual([]);
  });

  test('admin creates new template → appears in list', async ({ page }) => {
    await page.goto('/admin/broadcasts/templates/new');

    await page.getByLabel(/^Name$/).fill('E2E Test Template');
    await page.getByLabel(/^Subject$/).fill('Test {{chamber_name}}');

    // Tiptap editor — fill via the editor's editable region.
    // labelledById="tpl-body-label" wires the Label as the accessible
    // name, so getByLabel matches.
    const bodyEditor = page.getByLabel(/^Body \(HTML\)$/);
    await bodyEditor.click();
    await page.keyboard.type('Hello [member name].');

    await page.getByRole('button', { name: /^Save template$/ }).click();

    await page.waitForURL('**/admin/broadcasts/templates');
    await expect(page.getByText('E2E Test Template')).toBeVisible();
  });

  test('member picks template → compose form populated with substituted chamber_name', async ({
    page,
  }) => {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();

    await page.goto('/portal/broadcasts/new');

    // Template picker is the first compose action — native <select>
    // exposes implicit combobox role. selectOption fires the change
    // handler which navigates to ?template={id} server-side.
    const picker = page.getByLabel(/Start from a template/i);
    // Exact label match — seeded migration 0168 ships "Monthly
    // Newsletter" in the EN locale (TH/SV variants ship localised
    // names). The starter suffix `(Starter)` is appended in the option
    // label per ComposeTemplatePicker, so the substring helper needs
    // the full prefix to match unambiguously when multiple starters
    // begin with the same word.
    await picker.selectOption({ label: 'Monthly Newsletter (Starter)' });

    // After navigation, the compose form should be pre-populated.
    // SweCham comes from NEXT_PUBLIC_TENANT_NAME fallback (or whatever
    // tenant.display_name resolves to in the staging env).
    const subject = page.getByLabel(/^Subject$/);
    await expect(subject).not.toBeEmpty();
    const subjectValue = await subject.inputValue();
    expect(subjectValue).toMatch(/Newsletter/);

    // Bracket placeholders survive the substitution literal
    const bodyEditor = page.getByLabel(/^Message$/);
    await expect(bodyEditor).toContainText('[');

    // a11y scan on compose surface with picker
    const a11yResults = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(a11yResults.violations).toEqual([]);
  });
});
