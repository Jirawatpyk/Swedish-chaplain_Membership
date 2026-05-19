/**
 * T068 (F7.1a US2) — E2E spec for image upload + allowlist editor +
 * axe-core a11y.
 *
 * Gated on E2E_MEMBER_EMAIL / E2E_MEMBER_PASSWORD / E2E_ADMIN_EMAIL /
 * E2E_ADMIN_PASSWORD env vars per the project convention (skips at
 * runtime when seed/auth fixtures absent).
 *
 * Per memory `feedback_e2e_workers.md`: this suite assumes the parent
 * runner uses `pnpm test:e2e --workers=1`. Otherwise the user's
 * machine hangs.
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '../fixtures';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;

test.describe.configure({ timeout: 180_000 });

async function signIn(
  page: Page,
  surface: 'admin' | 'portal',
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`/${surface}/sign-in`);
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url) => {
    const p = url.pathname;
    return (
      p.startsWith(`/${surface}`) && !p.startsWith(`/${surface}/sign-in`)
    );
  });
}

test.describe('F7.1a US2 — Image upload + allowlist E2E @a11y', () => {
  test('admin allowlist editor renders + passes axe scan', async ({ page }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'E2E_ADMIN_* env vars not set',
    );
    await signIn(page, 'admin', ADMIN_EMAIL!, ADMIN_PASSWORD!);
    await page.goto('/admin/broadcasts/settings');
    await expect(
      page.getByRole('heading', { name: /image source allowlist/i }),
    ).toBeVisible();

    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);

    // Default entries should be present with disabled Remove buttons
    const removeBtns = page.getByRole('button', { name: /remove/i });
    if ((await removeBtns.count()) > 0) {
      expect(await removeBtns.first().isDisabled()).toBe(true);
    }
  });

  test('member compose surface exposes image upload toolbar button', async ({ page }) => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'E2E_MEMBER_* env vars not set',
    );
    await signIn(page, 'portal', MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await page.goto('/portal/broadcasts/new');

    // The upload button must be discoverable by accessible role+name
    await expect(
      page.getByRole('button', { name: /upload image/i }),
    ).toBeVisible({ timeout: 30_000 });

    const a11y = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(a11y.violations).toEqual([]);
  });

  test('upload of 6MB file shows size-cap error inline', async ({ page }) => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'E2E_MEMBER_* env vars not set',
    );
    await signIn(page, 'portal', MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await page.goto('/portal/broadcasts/new');
    await page.getByRole('button', { name: /upload image/i }).click();
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(6 * 1024 * 1024, 0x42),
    });
    await expect(page.getByRole('alert')).toContainText(/5 mb/i, {
      timeout: 30_000,
    });
  });
});
