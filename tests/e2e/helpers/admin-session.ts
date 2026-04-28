/**
 * Shared admin auth helper for F5 admin-side E2E suites.
 *
 * Mirrors `member-session.ts` but for admin role — extracted so the
 * sign-in dance is not inlined in every admin spec (review 2026-04-26
 * simplify R1: previously duplicated in `admin-refund-full.spec.ts` +
 * `admin-refund-partial.spec.ts` + `admin-payment-reconciliation-
 * view.spec.ts`).
 *
 * Caller should gate the suite with `test.skip(!ADMIN_EMAIL || ...)`
 * if env vars may be missing in CI; this helper assumes both env
 * vars are non-empty and fails loudly otherwise.
 */
import type { Page } from '@playwright/test';
import { fillField } from '../fixtures';

export async function signInAsAdmin(page: Page): Promise<void> {
  const email = process.env.E2E_ADMIN_EMAIL;
  const password = process.env.E2E_ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'signInAsAdmin: E2E_ADMIN_EMAIL or E2E_ADMIN_PASSWORD missing — gate the calling test with test.skip first.',
    );
  }
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  await fillField(page.getByLabel(/password/i), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/admin', { timeout: 30_000 });
}
