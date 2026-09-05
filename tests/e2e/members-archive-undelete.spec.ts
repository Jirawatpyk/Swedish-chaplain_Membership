/**
 * T137 — E2E: /admin/members/[memberId] archive + undelete flow
 * @f3 @a11y @i18n.
 *
 * Coverage:
 *   - Member detail page exposes Archive action
 *   - Archive dialog renders + has reason textarea
 *   - WCAG 2.1 AA scan via @axe-core/playwright (detail + banner)
 *   - i18n smoke: TH + SV locales render without raw translation-key
 *     leaks for `admin.members.archive.*` / `admin.members.undelete.*`
 *
 * Gated on E2E_ADMIN_EMAIL/PASSWORD env vars.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test, fillField } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';
import {
  seedArchivedNoPrimaryMembers,
  type ArchivedNoPrimarySeed,
} from './helpers/archived-no-primary-seed';

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('members archive/undelete — F3 US7 @f3 @a11y @i18n', () => {
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
    // Filter to active members only so the Archive CTA is visible.
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

  test('detail page renders Archive CTA for active members', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    await expect(
      page.getByRole('button', { name: /archive member/i }).first(),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('Archive dialog opens with reason textarea + Cancel/Confirm', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);

    await page
      .getByRole('button', { name: /archive member/i })
      .first()
      .click();

    // Alert dialog surfaces
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Reason textarea is present (label points at #archive-reason)
    await expect(dialog.locator('#archive-reason')).toBeVisible();

    // Cancel dismisses the dialog
    await dialog.getByRole('button', { name: /cancel|ยกเลิก|avbryt/i }).click();
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('@a11y — archive flow has zero WCAG 2.1 AA violations', async ({
    page,
  }) => {
    await signIn(page);
    const memberId = await firstActiveMemberId(page);
    await page.goto(`/admin/members/${memberId}`);
    await page.waitForLoadState('networkidle');

    // Scan detail page first
    let results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Open archive dialog and scan again
    await page
      .getByRole('button', { name: /archive member/i })
      .first()
      .click();
    await page.getByRole('alertdialog').waitFor({ timeout: 5_000 });

    results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test('@i18n — TH + SV locales render archive UI without leaks', async ({
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
      const text = await page.evaluate(() => document.body.innerText);
      expect(
        text,
        `${locale}: archive translation key leaked`,
      ).not.toMatch(/admin\.members\.archive\.[a-z]+/i);
      expect(
        text,
        `${locale}: undelete translation key leaked`,
      ).not.toMatch(/admin\.members\.undelete\.[a-z]+/i);
    }
  });
});

/**
 * 108 T040 (US2 / FR-014) — restore designates a primary contact.
 *
 * Seeds an archived member whose two live contacts are both secondary (the
 * state the feature exists for) and one with no contacts at all. Run with
 * `--workers=1`: the seed writes to the shared e2e tenant.
 */
test.describe('members undelete — designate a primary (108 FR-014) @f3 @a11y @i18n', () => {
  test.skip(
    !ADMIN_EMAIL || !ADMIN_PASSWORD,
    'Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD (seeded by scripts/seed-e2e-user.ts)',
  );

  let seed: ArchivedNoPrimarySeed | null = null;

  test.beforeAll(async () => {
    await clearE2ERateLimits();
    seed = await seedArchivedNoPrimaryMembers();
  });
  test.afterAll(async () => {
    await seed?.cleanup().catch(() => {});
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

  test('Restore on a member with no primary opens the choice, restores with the pick, and returns focus', async ({
    page,
  }) => {
    test.skip(!seed, 'seed unavailable (DATABASE_URL missing?)');
    const s = seed!;
    await signIn(page);
    await page.goto(`/admin/members/${s.withContacts.memberId}`);
    await page.waitForLoadState('networkidle');

    const restore = page.getByRole('button', { name: /^restore$/i }).first();
    await expect(restore).toBeVisible({ timeout: 15_000 });
    await restore.click();

    // The 409 opens the alert dialog with BOTH contacts and nothing chosen.
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 10_000 });
    const [a, b] = s.withContacts.contacts;
    const radioA = dialog.getByRole('radio', { name: new RegExp(`${a!.firstName} ${a!.lastName}`) });
    const radioB = dialog.getByRole('radio', { name: new RegExp(`${b!.firstName} ${b!.lastName}`) });
    await expect(radioA).toBeVisible();
    await expect(radioB).toBeVisible();
    await expect(radioA).not.toBeChecked();
    await expect(radioB).not.toBeChecked();
    const confirm = page.getByTestId('restore-primary-confirm');
    await expect(confirm).toBeDisabled();

    // @a11y — the dialog itself.
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Keyboard: focus is inside the dialog, never on <body>.
    const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
    expect(focusedTag).not.toBe('BODY');

    await dialog.getByText(`${b!.firstName} ${b!.lastName}`).click();
    await expect(radioB).toBeChecked();
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // Restored + designated: the dialog and the archived banner are gone.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(/member restored/i).first()).toBeVisible({ timeout: 10_000 });
    // `router.refresh()` re-renders the server tree; on a cold dev server that
    // can take longer than the default expect timeout.
    await expect(page.getByRole('button', { name: /^restore$/i })).toHaveCount(0, {
      timeout: 20_000,
    });
    // The designated contact is now the primary on the page.
    await expect(page.getByText(`${b!.firstName} ${b!.lastName}`).first()).toBeVisible();

    // Focus never dropped to <body> after the dialog closed (finalFocus).
    const afterTag = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
    expect(afterTag).not.toBe('BODY');
  });

  test('a member with NO contacts gets the add-contact door and no restore button', async ({
    page,
  }) => {
    test.skip(!seed, 'seed unavailable (DATABASE_URL missing?)');
    const s = seed!;
    await signIn(page);
    await page.goto(`/admin/members/${s.withoutContacts.memberId}`);
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: /^restore$/i }).first().click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor({ timeout: 10_000 });
    await expect(dialog.getByRole('radio')).toHaveCount(0);
    await expect(page.getByTestId('restore-primary-confirm')).toHaveCount(0);
    await expect(page.getByTestId('restore-primary-add-contact')).toBeVisible();

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations).toEqual([]);

    // Cancel returns focus to the Restore button, not <body>.
    await page.getByTestId('restore-primary-cancel').click();
    await expect(dialog).toBeHidden();
    const afterTag = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY');
    expect(afterTag).not.toBe('BODY');
  });

  test('@i18n — TH + SV render the designate dialog without key leaks', async ({
    page,
    context,
  }) => {
    test.skip(!seed, 'seed unavailable (DATABASE_URL missing?)');
    const s = seed!;
    await signIn(page);
    for (const locale of ['th', 'sv'] as const) {
      await context.addCookies([
        { name: 'NEXT_LOCALE', value: locale, url: 'http://localhost:3100' },
      ]);
      // The contact-bearing member was RESTORED by the first case (serial), so
      // it no longer offers Restore; the contact-less one is still archived and
      // its dialog variant renders the same namespace.
      await page.goto(`/admin/members/${s.withoutContacts.memberId}`);
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: /restore|กู้คืน|återställ/i }).first().click();
      const dialog = page.getByRole('alertdialog');
      await dialog.waitFor({ timeout: 10_000 });
      const text = await dialog.innerText();
      expect(text, `${locale}: designate translation key leaked`).not.toMatch(
        /admin\.members\.undelete\.designate\.[a-zA-Z]+/,
      );
      await page.getByTestId('restore-primary-cancel').click();
      await expect(dialog).toBeHidden();
    }
  });
});
