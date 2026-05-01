/**
 * Shared sign-in flow for member-portal E2E tests. Reuses the
 * `E2E_MEMBER_EMAIL` + `E2E_MEMBER_PASSWORD` env credentials.
 *
 * Resolution semantics:
 *   - WebKit (mobile-safari) flakes when `.fill()` races autofill
 *     heuristics — click + fill + assert before submit.
 *   - URL-wait predicate matches any `/portal/*` route except the
 *     sign-in page itself (the post-sign-in landing is configurable
 *     by tenant).
 */
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function signInAsMember(page: Page): Promise<void> {
  const email = process.env.E2E_MEMBER_EMAIL;
  const password = process.env.E2E_MEMBER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'signInAsMember requires E2E_MEMBER_EMAIL + E2E_MEMBER_PASSWORD env vars',
    );
  }
  await page.goto('/portal/sign-in');
  const emailInput = page.locator('input#email');
  const passwordInput = page.locator('input#password');
  await emailInput.click();
  await emailInput.fill(email);
  await expect(emailInput).toHaveValue(email);
  await passwordInput.click();
  await passwordInput.fill(password);
  await expect(passwordInput).toHaveValue(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL(
    (u) => {
      const p = new URL(u).pathname;
      return /^\/portal(\/|$)/.test(p) && !p.startsWith('/portal/sign-in');
    },
    { timeout: 15_000 },
  );
}
