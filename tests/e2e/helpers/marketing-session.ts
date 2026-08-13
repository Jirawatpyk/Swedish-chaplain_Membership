/**
 * 016 PR 4 (T059) — marketing persona sign-in for the US3/US4 E2E walks.
 *
 * Mirrors `manager-session.ts`: fails loudly rather than silently signing in as
 * somebody else, so a missing env var can never turn a permission assertion into
 * a vacuous pass. Gate the calling suite with `test.skip` first.
 *
 * Seeded by `scripts/seed-e2e-user.ts` (e2e-marketing@swecham.test). The marketing
 * persona only means anything on the ON leg — on the OFF leg D16 maps marketing
 * to no legacy role, so every staff surface denies and the walks are vacuous.
 * Suites that assert marketing's REACH must therefore also require
 * `E2E_RBAC_V2_ON=true`.
 */
import type { Page } from '@playwright/test';
import { fillField } from '../fixtures';

export async function signInAsMarketing(page: Page): Promise<void> {
  const email = process.env.E2E_MARKETING_EMAIL;
  const password = process.env.E2E_MARKETING_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'signInAsMarketing: E2E_MARKETING_EMAIL or E2E_MARKETING_PASSWORD missing — ' +
        'run scripts/seed-e2e-user.ts, add them to .env.local, and gate the calling ' +
        'test with test.skip first.',
    );
  }
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  // role+name selector, not getByLabel: the PasswordInput primitive renders a
  // "Show password" toggle whose aria-label also matches /password/i, which
  // makes a label lookup ambiguous under strict mode (see admin-session.ts).
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  // 60s: first hit in a worker pays the Turbopack cold compile of /admin.
  await page.waitForURL('**/admin', { timeout: 60_000 });
}
