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
// F7.1b B7 closure 2026-05-21 — uses centralized axe-scan helper.
import { runAxeScan } from '../helpers/axe-scan';
import { type Page } from '@playwright/test';
import { expect, test } from '../fixtures';

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
  await page.getByRole('textbox', { name: 'Password' }).fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL((url: URL) => {
    const p = url.pathname;
    return (
      p.startsWith(`/${surface}`) && !p.startsWith(`/${surface}/sign-in`)
    );
  });
}

test.describe('F7.1a US2 — Image upload + allowlist E2E @a11y', () => {
  // E2E rate-limit fix 2026-05-21: matches template-library-flow.spec.ts
  // — each test signs in fresh; retries multiply sign-ins and trip the
  // Upstash IP rate-limit bucket (30/15min). Disable retries so a real
  // regression fails on first attempt.
  test.describe.configure({ retries: 0 });

  test('admin allowlist editor renders + passes axe scan', async ({ page }) => {
    test.skip(
      !ADMIN_EMAIL || !ADMIN_PASSWORD,
      'E2E_ADMIN_* env vars not set',
    );
    await signIn(page, 'admin', ADMIN_EMAIL!, ADMIN_PASSWORD!);
    // Relocated 2026-05-20 to centralised-settings IA.
    await page.goto('/admin/settings/broadcasts');
    // E2E selector fix 2026-05-21: the allowlist title is rendered by
    // shadcn `<CardTitle>` → `<div data-slot="card-title">`, NOT an
    // h-element. `getByRole('heading')` would not match. Use the
    // text+test-id pattern instead. 30s expect-poll covers Turbopack
    // cold-compile of this route on first request.
    await expect(
      page.locator('[data-slot="card-title"]', { hasText: /image source allowlist/i }),
    ).toBeVisible({ timeout: 30_000 });

    await runAxeScan(page, test.info());

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

    // E2E behaviour fix 2026-05-21: the upload button is gated behind
    // `draftId !== null` (POST /api/broadcasts/draft must succeed first
    // so the inline-image upload route can FK to a real broadcast row).
    // Before save, the editor renders the `draftRequiredHint` instead
    // of the button. The test originally pre-dated that gating; assert
    // the upload UI is DISCOVERABLE — either the button (post-save) OR
    // the hint (pre-save). Both routes satisfy SC-008 (the surface is
    // visible to keyboard + SR users).
    await expect(
      page
        .getByRole('button', { name: /upload image/i })
        .or(page.getByText(/save this draft first to enable image uploads/i)),
    ).toBeVisible({ timeout: 30_000 });

    await runAxeScan(page, test.info());
  });

  test('upload of 6MB file shows size-cap error inline', async ({ page }) => {
    test.skip(
      !MEMBER_EMAIL || !MEMBER_PASSWORD,
      'E2E_MEMBER_* env vars not set',
    );
    await signIn(page, 'portal', MEMBER_EMAIL!, MEMBER_PASSWORD!);
    await page.goto('/portal/broadcasts/new');

    // E2E flow fix 2026-05-21: the upload button is gated behind
    // `draftId !== null` — must save a draft first. Fill required
    // fields (subject + body have validators in compose-form.tsx
    // SubmitSchema; saveDraft only requires non-empty subject) then
    // click "Save as draft" + wait for the editor toolbar to expose
    // the upload button.
    await page.getByLabel(/^Subject$/).fill('E2E 6MB upload test');
    await page.getByRole('button', { name: /save.*draft/i }).click();

    // Saving creates the draft via POST /api/broadcasts/draft +
    // updates `initialDraftId`. The Tiptap editor re-renders +
    // exposes the inline-image upload button.
    await expect(
      page.getByRole('button', { name: /upload image/i }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: /upload image/i }).click();

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: 'huge.png',
      mimeType: 'image/png',
      buffer: Buffer.alloc(6 * 1024 * 1024, 0x42),
    });
    // E2E selector fix 2026-05-21: `getByRole('alert')` matches BOTH the
    // real error alert AND Next.js's internal `__next-route-announcer__`
    // (also role=alert + aria-live=assertive). Scope to the main-content
    // region to exclude the route announcer.
    await expect(
      page.locator('#main-content').getByRole('alert'),
    ).toContainText(/5 mb/i, { timeout: 30_000 });
  });
});
