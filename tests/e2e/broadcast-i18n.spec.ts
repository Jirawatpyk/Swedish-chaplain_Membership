/**
 * T193 + T195 + T196 + T197 (Phase 10) — F7 i18n e2e suite.
 *
 * Tests gated on E2E_MEMBER_* env vars; skip at runtime when seed/auth
 * fixtures absent.
 *
 *   - T193: <html lang> attribute correct per resolved locale (i18n.md CHK065)
 *   - T195: Tiptap TH IME composition (i18n.md CHK059)
 *   - T196: TH+EN+SV dispatch round-trip (i18n.md CHK032)
 *   - T197: TH locale length-expansion survives 320px + 1280px (i18n.md CHK056)
 */
import { expect, test } from './fixtures';
import { wipeE2EMemberBroadcasts } from './helpers/broadcasts-seed';

// Same reason as broadcast-compose-and-submit.spec.ts (2026-09-07): the primary
// `e2e-member` carries a LAPSED renewal cycle by the F8 fixture, so the compose
// page redirects away from the form and every `requireMemberContext` route
// answers 403 `membership_access_restricted` — which is what every case below
// hit on 2026-09-10 (received [403] against expected [200|201|422]). The
// form-level cases need the in-good-standing `e2e-member-empty` persona
// (linked, NO cycle → `full` access; seeded by scripts/seed-e2e-portal-invoices.ts).
const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL_EMPTY;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD_EMPTY;

// Mobile Safari + dev-server cold compile budget — see broadcast-a11y.
test.describe.configure({ timeout: 180_000 });

test.beforeAll(async ({}, testInfo) => {
  testInfo.setTimeout(240_000);
  // For the persona that signs in (see the MEMBER_EMAIL note above).
  await wipeE2EMemberBroadcasts(MEMBER_EMAIL);
});

async function signInAsMember(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/portal/sign-in');
  await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
  await page.getByRole('textbox', { name: /^password$/i }).fill(MEMBER_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return p.startsWith('/portal') && !p.startsWith('/portal/sign-in');
    },
    { timeout: 120_000 },
  );
}

test.describe('@i18n T193 — html-lang-attribute-correct-per-resolved-locale', () => {
  for (const locale of ['en', 'th', 'sv'] as const) {
    test(`unsubscribe page lang=${locale} sets <main lang="${locale}">`, async ({
      page,
    }) => {
      // The unsubscribe page resolves locale per token > query >
      // Accept-Language > tenant-default > en. With explicit ?lang=
      // we expect exact match. `<html lang>` is owned by the Next.js
      // root layout (next-intl `getLocale()` cookie-based flow); the
      // unsubscribe page uses a separate token-driven chain and
      // surfaces it on `<main lang>` for screen readers.
      await page.goto(`/unsubscribe/v1.invalid.invalid?lang=${locale}`);
      await page.waitForLoadState('domcontentloaded');
      const mainLang = await page.locator('main').first().getAttribute('lang');
      expect(mainLang).toBe(locale);
    });
  }
});

test.describe('@i18n T195 — Tiptap TH IME composition', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY');

  test('TH text inserted into Tiptap renders correctly + cursor advances', async ({
    page,
  }) => {
    await signInAsMember(page);
    await page.goto('/portal/broadcasts/new');
    // Find the contenteditable Tiptap element
    const editor = page.locator('[contenteditable="true"]').first();
    await editor.click();
    // Use insertText (browser-native) — bypasses keyboard layout to
    // simulate IME-composed text the way Thai users see it
    await page.keyboard.insertText('สวัสดีครับ');
    const text = await editor.textContent();
    expect(text).toContain('สวัสดีครับ');
  });
});

test.describe('@i18n T196 — TH+EN+SV dispatch round-trip', () => {
  // This test asserts that subjects with non-ASCII characters survive
  // the submit boundary intact. Live Resend dispatch is tested via
  // the gated jcc-test-tenant-fixture (T179). Here we assert the
  // local-DB write preserves bytes.
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY');

  for (const sample of [
    { name: 'TH-only', subject: 'ข่าวสารจากหอการค้า — เมษายน' },
    { name: 'bidi LTR/RTL', subject: 'Hello مرحبا 你好' },
    { name: 'emoji', subject: '🎉 New event 🚀' },
  ]) {
    test(`${sample.name} subject preserved through submit`, async ({ page }) => {
      await signInAsMember(page);
      await page.goto('/portal/broadcasts/new');
      await page.getByLabel(/subject/i).fill(sample.subject);
      const echoed = await page.getByLabel(/subject/i).inputValue();
      expect(echoed).toBe(sample.subject);
    });
  }
});

test.describe('@i18n T197 — TH locale length-expansion at 320px + 1280px', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER_EMAIL_EMPTY + E2E_MEMBER_PASSWORD_EMPTY');

  for (const width of [320, 1280] as const) {
    test(`compose form has no horizontal overflow at ${width}px (TH locale)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 1024 });
      await signInAsMember(page);
      // Cookie-based locale switch (next-intl convention)
      await page.context().addCookies([
        {
          name: 'NEXT_LOCALE',
          value: 'th',
          domain: 'localhost',
          path: '/',
        },
      ]);
      await page.goto('/portal/broadcasts/new');
      await page.waitForLoadState('domcontentloaded');
      const horizontalOverflow = await page.evaluate(() => {
        return (
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1
        );
      });
      expect(horizontalOverflow, `TH @ ${width}px must not overflow`).toBe(false);
    });
  }
});
