/**
 * Shared manager auth helper for F8 admin-side E2E suites.
 *
 * Mirrors `admin-session.ts` but for the manager role. Manager has
 * read-only access to most admin surfaces (per Constitution v1.4.0
 * RBAC) but CAN view cycle-detail, pipeline, and at-risk widget
 * pages. Mutations (mark-paid, reactivate, reject) are admin-only.
 *
 * Staff-Review-2026-05-09 T277e closure — added so admin-cycle-detail
 * spec can verify manager-role read-only render without the test
 * inlining the sign-in dance.
 */
import type { Page } from '@playwright/test';
import { fillField } from '../fixtures';

export async function signInAsManager(page: Page): Promise<void> {
  const email = process.env.E2E_MANAGER_EMAIL;
  const password = process.env.E2E_MANAGER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'signInAsManager: E2E_MANAGER_EMAIL or E2E_MANAGER_PASSWORD missing — gate the calling test with test.skip first.',
    );
  }
  await page.goto('/admin/sign-in');
  await fillField(page.getByLabel(/email/i), email);
  // R9.B1 / F1 PasswordInput regression — see admin-session.ts:27.
  await fillField(page.getByRole('textbox', { name: /^password$/i }), password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await page.waitForURL('**/admin', { timeout: 30_000 });
}
