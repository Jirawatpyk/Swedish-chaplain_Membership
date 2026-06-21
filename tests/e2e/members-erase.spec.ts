/**
 * COMP-1 US3-A — E2E: /admin/members/[memberId] erase (GDPR Art.17 / PDPA §33)
 * @f3 @a11y @i18n.
 *
 * Coverage (UI only — NEVER completes an erase):
 *   - Member detail page exposes the standalone Erase (GDPR/PDPA) CTA
 *   - Erase dialog GATES the confirm button (aria-disabled) until all
 *     conditions are met: legal-basis radio + Art.12 attestation checkbox +
 *     verification-method select + type-to-confirm member number. We satisfy
 *     the gate, assert the confirm button is no longer aria-disabled, then
 *     CANCEL — we do NOT click "Erase permanently".
 *   - WCAG 2.1 AA scan via @axe-core/playwright (detail page + open dialog)
 *   - i18n smoke: TH + SV locales render without raw `admin.members.erase.*`
 *     translation-key leaks (page + dialog)
 *
 * SAFETY: an erase is PERMANENT and irreversibly anonymises member PII. The
 * shared local dev DB has real-ish seeded members, so this spec MUST NOT click
 * the final confirm against a real member — exactly like the sibling archive
 * spec, which opens the dialog and CANCELS. The actual mutation path is covered
 * by the unit, contract, and live-Neon integration test
 * (tests/integration/members/erase-route-attestation.test.ts). This e2e only
 * verifies the UI: CTA presence, gate logic, a11y, i18n.
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('members erase — COMP-1 US3-A @f3 @a11y @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/admin/sign-in');
    await fillField(page.getByLabel(/email/i), ADMIN_EMAIL!);
    await fillField(page.getByRole('textbox', { name: /^password$/i }), ADMIN_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/admin(\/|$)/.test(p) && !p.startsWith('/admin/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  async function firstActiveMemberId(page: Page): Promise<string> {
    // Filter to active members only so the Erase CTA is visible
    // (the CTA renders for write-capable, non-erased members).
    await page.goto('/admin/members?status=active');
    await page.waitForLoadState('networkidle');
    const firstRow = page.locator('table tbody tr').first();
    await firstRow.waitFor({ timeout: 15_000 });
    const href = await firstRow.locator('a').first().getAttribute('href');
    if (!href) throw new Error('No active member rows — seed required');
    const match = href.match(/\/admin\/members\/([0-9a-f-]+)/);
    if (!match) throw new Error(`Could not parse memberId from ${href}`);
    return match[1]!;
  }

  test('detail page renders the Erase CTA for active members', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // Trigger label is `admin.members.erase.eraseCta` = "Erase (GDPR/PDPA)…".
    await expect(
      page
        .getByRole('button', { name: /erase.*GDPR\/PDPA|erase \(gdpr/i })
        .first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('Erase dialog gates the confirm button until all conditions are met', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // The header member-number badge is the first mono element on the page;
    // its trimmed text (e.g. "SCCM-0042") is the type-to-confirm target.
    const memberNumber = (
      await page.locator('.font-mono').first().innerText()
    ).trim();
    expect(memberNumber.length).toBeGreaterThan(0);

    // Open the erase dialog.
    await page
      .getByRole('button', { name: /erase.*GDPR\/PDPA|erase \(gdpr/i })
      .first()
      .click();

    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // The confirm button uses aria-disabled (NOT native `disabled`) so it stays
    // focusable + announced for SR users. Assert via the attribute, not
    // toBeDisabled().
    const confirmBtn = dialog.getByRole('button', {
      name: /erase permanently|ลบถาวร|radera permanent/i,
    });
    await expect(confirmBtn).toBeVisible();
    await expect(confirmBtn).toHaveAttribute('aria-disabled', 'true');

    // Satisfy the gate WITHOUT confirming.
    // 1) Legal-basis radio (GDPR Art. 17). Base UI RadioGroup renders a visible
    //    role="radio" control PLUS a hidden native <input type="radio"> — both
    //    label-associated — so getByLabel() is ambiguous. Target the visible
    //    control by role (Playwright .check() drives role="radio").
    await dialog
      .getByRole('radio', { name: /GDPR Art\. 17|GDPR มาตรา 17|GDPR art\. 17/i })
      .check();
    // 2) Art.12 identity-verification attestation checkbox. Same Base UI
    //    visible-control + hidden-input duplication — use role="checkbox".
    await dialog
      .getByRole('checkbox', {
        name: /identity was verified|ตรวจสอบตัวตน|identitet/i,
      })
      .check();
    // 3) Verification-method select (Base UI Select — click trigger, then pick
    //    the in-person option from the listbox).
    await dialog
      .getByLabel(
        /how was identity verified|ตรวจสอบตัวตนด้วยวิธีใด|verifierades identiteten/i,
      )
      .click();
    await page
      .getByRole('option', { name: /in person|พบด้วยตนเอง|personligen/i })
      .click();
    // 4) Type-to-confirm the member number exactly.
    await fillField(dialog.locator('#erase-confirm'), memberNumber);

    // Gate satisfied → confirm button is no longer aria-disabled. DO NOT click.
    await expect(confirmBtn).not.toHaveAttribute('aria-disabled', 'true');

    // Cancel — never complete the erase.
    await dialog
      .getByRole('button', { name: /cancel|ยกเลิก|avbryt/i })
      .click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('@a11y — erase dialog has zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // Scan the detail page first.
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Open the erase dialog and scan again.
    await page
      .getByRole('button', { name: /erase.*GDPR\/PDPA|erase \(gdpr/i })
      .first()
      .click();
    await page.getByRole('alertdialog').waitFor({ timeout: 5_000 });

    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('@i18n — TH + SV locales render the erase UI without key leaks', async ({
    page,
    context,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);

    for (const locale of ['th', 'sv'] as const) {
      await context.addCookies([
        {
          name: 'NEXT_LOCALE',
          value: locale,
          url: 'http://localhost:3100',
        },
      ]);
      await page.goto(`/admin/members/${memberId}`);
      await page.waitForLoadState('networkidle');

      // Page-level: no raw `admin.members.erase.*` key leaked.
      const pageText = await page.evaluate(() => document.body.innerText);
      expect(
        pageText,
        `${locale}: erase translation key leaked on page`,
      ).not.toMatch(/admin\.members\.erase\.[a-z]+/i);

      // Dialog-level: open the erase dialog and re-check. The CTA label is
      // localised (TH "ลบข้อมูล (GDPR/PDPA)…", SV "Radera (GDPR/PDPA)…") but the
      // "(GDPR/PDPA)" token is stable across all three locales, so match on it.
      await page
        .getByRole('button', { name: /\(GDPR\/PDPA\)/i })
        .first()
        .click();
      const dialog = page.getByRole('alertdialog');
      await expect(dialog).toBeVisible({ timeout: 5_000 });
      const dialogText = await dialog.evaluate((el) => el.textContent ?? '');
      expect(
        dialogText,
        `${locale}: erase translation key leaked in dialog`,
      ).not.toMatch(/admin\.members\.erase\.[a-z]+/i);

      // Close so the next locale iteration starts clean.
      await dialog
        .getByRole('button', { name: /cancel|ยกเลิก|avbryt/i })
        .click();
      await expect(dialog).not.toBeVisible({ timeout: 5_000 });
    }
  });
});
