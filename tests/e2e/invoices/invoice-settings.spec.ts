/**
 * Task 10 (settings-ux-invoice-reminders) — Invoice Settings E2E.
 *
 * Verifies the Task 7-9 two-column sticky-nav redesign of
 * `/admin/settings/invoicing` did not regress the §87 prefix-change safety
 * guard (088 US5 T043a) when Save is triggered from the sticky bar's
 * `requestSubmit()` re-entry path instead of the in-form primary Save
 * button — design contract spec §4.3 (nav) + §6.3 (single-submit path).
 *
 *   (a) clicking a section-nav rail button moves focus to the target
 *       section's `<h2 data-section-heading tabIndex={-1}>`
 *       (`section-nav.tsx` `goToSection`) — the focus-management contract
 *       survived the Task 7 nav extraction.
 *   (b) editing the invoice-number prefix and clicking Save FROM the
 *       sticky bar (not the in-form primary button) still routes through
 *       the SAME `handleSubmit` (`formRef.current?.requestSubmit()`,
 *       `invoice-settings-form.tsx:778-782`) and still opens the §87
 *       `AlertDialog` — proving the sticky bar didn't fork the submit
 *       path.
 *   (c) confirming the dialog PATCHes with the FULL settings body
 *       (identity fields unchanged + the new prefix), not a
 *       partial/prefix-only body — the single-submit-path invariant.
 *   (d) `@a11y` axe scan of the page (run first, on the untouched page,
 *       before the dialog/dirty-state interactions below).
 *
 * The PATCH request is intercepted and fulfilled locally — it never
 * reaches the real route/DB. A genuine prefix change starts a NEW §87
 * numbering stream (`invoice-settings-form.tsx:540-554` +
 * `prefixChange.description` in en.json) and would permanently mutate the
 * shared e2e admin tenant's numbering state on every run. This spec is a
 * CLIENT-behaviour test (focus management, dialog gating, request-body
 * shape) — real persistence of a prefix change on an existing tenant is
 * already covered by `tests/e2e/invoice-settings.spec.ts`'s throwaway-
 * tenant AS1 flow.
 *
 * Precondition: the §87 confirmation only fires when the tenant already
 * has an invoice-settings row (`exists === true` —
 * `invoice-settings-form.tsx:544-549`; a brand-new/empty tenant skips the
 * dialog and PATCHes straight through). The shared e2e admin tenant
 * (SweCham dev) is expected to already have one — F4 shipped and the
 * sibling specs in this directory/`tests/e2e/invoice-settings.spec.ts`
 * navigate straight to the page with no seed step. Defensively
 * `test.skip`s at runtime if the page is actually in first-time-bootstrap
 * mode (Save button reads "Create settings"), rather than failing
 * confusingly on an environment where the row hasn't been created yet.
 *
 * AUTHORED, NOT RUN — this environment has no browser / live dev server
 * and no admin credentials. Run on CI/preview:
 *
 *   pnpm test:e2e tests/e2e/invoices/invoice-settings.spec.ts --workers=1
 *
 * Recommended to run alongside the @layout suite before merging this
 * branch (fix-wave B corrected `container-widths.spec.ts` for the new
 * detail variant this form now uses):
 *
 *   pnpm test:e2e --grep "@layout" --workers=1
 *   pnpm test:e2e --grep "invoice settings" --workers=1
 */
import { expect, test, fillField } from '../fixtures';
import { signInAsAdmin } from '../helpers/admin-session';
import { waitForLayoutContainer } from '../helpers/layout';
import { runAxeScan } from '../helpers/axe-scan';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

const SETTINGS_PATH = '/admin/settings/invoicing';

test.describe('invoice settings: section-nav focus + sticky-save prefix guard @f4', () => {
  test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, 'E2E_ADMIN_* not set');

  // Cold Turbopack compile of /admin/settings/invoicing on first hit
  // (same budget rationale as admin-session.ts's 60s /admin wait) plus
  // the axe scan + dialog round-trip below.
  test.describe.configure({ timeout: 90_000 });

  test('@a11y nav focus + sticky Save keeps the §87 prefix-change dialog + full-body PATCH', async ({
    page,
  }, testInfo) => {
    await signInAsAdmin(page);

    // Desktop viewport — the section-nav rail (`section-nav.tsx`) is
    // `hidden md:block`; below the `md` breakpoint only the mobile
    // `<select>` jump-menu renders and there is no nav BUTTON to click.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(SETTINGS_PATH);
    await waitForLayoutContainer(page);
    await page.waitForLoadState('networkidle');

    // Bootstrap-mode guard — see file header. The §87 dialog can only
    // fire once a settings row already exists.
    const isBootstrap = await page
      .getByRole('button', { name: /^create settings$/i })
      .isVisible()
      .catch(() => false);
    test.skip(
      isBootstrap,
      'Tenant has no invoice-settings row yet — the §87 prefix-change ' +
        'dialog only fires when `exists` is true (invoice-settings-form.tsx:544).',
    );

    // (d) axe scan — untouched page, before the dialog/dirty-state
    // interactions below change the DOM.
    await runAxeScan(page, testInfo);

    // (a) nav → focus section heading (section-nav.tsx `goToSection`).
    // Both the h2 (role=heading) and this nav rail button (role=button)
    // read "Document numbering" (`sections.numbering` in en.json) — the
    // explicit role scopes the match to the button.
    await page.getByRole('button', { name: /^document numbering$/i }).click();
    await expect(page.locator('#numbering [data-section-heading]')).toBeFocused();

    // (b) change the invoice prefix, Save FROM the sticky bar. Read the
    // current value first so the new value is guaranteed to differ from
    // whatever this tenant currently has configured (maxLength=20).
    const prefixInput = page.locator('#inv_prefix');
    const originalPrefix = await prefixInput.inputValue();
    const newPrefix = `${originalPrefix.slice(0, 17)}E2E`.slice(0, 20);
    expect(newPrefix, 'sanity: the new prefix must actually differ').not.toBe(
      originalPrefix,
    );
    await fillField(prefixInput, newPrefix);

    // Intercept + fulfill the PATCH locally instead of letting it reach
    // the real route/DB — see file header (a real prefix change starts a
    // new §87 numbering stream on the shared e2e tenant).
    let patchBody: Record<string, unknown> | undefined;
    await page.route('**/api/tenant-invoice-settings', async (route) => {
      const request = route.request();
      if (request.method() !== 'PATCH') {
        await route.continue();
        return;
      }
      patchBody = request.postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    });

    // Sticky bar's own Save button — NOT the in-form primary Save, which
    // renders the identical "Save settings" text (`actions.save`) further
    // down the page. Scoping to the region (`stickyBar.label` =
    // "Save changes") is what proves this test exercises the sticky path.
    const stickyBar = page.getByRole('region', { name: /save changes/i });
    await expect(stickyBar, 'sticky bar visible once the form is dirty').toBeVisible();
    await stickyBar.getByRole('button', { name: /^save settings$/i }).click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('heading', { name: /change document-number prefix\?/i }),
    ).toBeVisible();

    // (c) confirm → PATCH carries the FULL identity body, unchanged, plus
    // the new prefix (single-submit-path invariant, spec §6.3). The
    // confirm button reads "Change prefix" (`prefixChange.confirm`), not
    // "confirm" — scoped to the dialog to avoid the unrelated "Cancel"
    // button.
    await dialog.getByRole('button', { name: /^change prefix$/i }).click();
    await expect(dialog).toBeHidden();

    await expect
      .poll(() => patchBody !== undefined, {
        message: 'PATCH /api/tenant-invoice-settings was not intercepted',
        timeout: 10_000,
      })
      .toBe(true);
    expect(patchBody).toMatchObject({ invoice_number_prefix: newPrefix });
    // Full-body invariant — identity fields ride along unchanged even
    // though only the prefix was edited.
    expect(patchBody).toHaveProperty('tax_id');
    expect(patchBody).toHaveProperty('legal_name_th');
    expect(patchBody!.tax_id).not.toBe('');
    expect(patchBody!.legal_name_th).not.toBe('');
  });
});
