/**
 * T053 — Quota counter surface (US1 AS2).
 *
 * Verifies:
 *   - Benefits page renders the quota counter SSR
 *   - GET /api/broadcasts/quota returns the typed envelope
 *
 * The quota_blocked precondition envelope is exhaustively covered at
 * the use-case unit level (`tests/unit/broadcasts/application/
 * submit-broadcast.test.ts` — 32 tests including all FR-002 a–k
 * preconditions) and by the F7 contract tests for /api/broadcasts/submit.
 * Forcing it through E2E would require destructive seed of the
 * shared e2e-member's quota state.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('Broadcast quota counter (T053 — US1 AS2)', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER credentials');
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/portal/sign-in');
    await page.getByLabel(/email/i).fill(MEMBER_EMAIL!);
    await page.getByLabel(/password/i).fill(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/portal(\/|$)/.test(p) && !p.startsWith('/portal/sign-in');
      },
      { timeout: 10_000 },
    );
  }

  test('benefits page renders quota counter (used / reserved / remaining)', async ({
    page,
  }) => {
    await signIn(page);
    const response = await page.goto('/portal/benefits/e-blasts');
    expect(response?.status()).toBeLessThan(400);
    const qc = page.locator('[data-testid="quota-display"]').or(
      page.getByText(/quota|remaining/i),
    );
    await expect(qc.first()).toBeVisible({ timeout: 10_000 });
  });

  test('GET /api/broadcasts/quota returns typed envelope (used/reserved/remaining/cap)', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/portal');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/quota', {
        credentials: 'same-origin',
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    expect(r.status).toBe(200);
    const body = r.body as Record<string, unknown>;
    expect(typeof body.used).toBe('number');
    expect(typeof body.reserved).toBe('number');
    expect(typeof body.remaining).toBe('number');
    expect(typeof body.cap).toBe('number');
    expect(typeof body.eblastPerYear).toBe('number');
    expect(typeof body.quotaYear).toBe('number');
    expect(body.cap).toBe(body.eblastPerYear);
    // Invariant: used + reserved + remaining = cap
    expect(
      (body.used as number) +
        (body.reserved as number) +
        (body.remaining as number),
    ).toBe(body.cap);
  });

  test('GET /api/broadcasts/quota carries plan identity (planCode + planId)', async ({
    page,
  }) => {
    await signIn(page);
    await page.goto('/portal');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/quota', {
        credentials: 'same-origin',
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    expect(r.status).toBe(200);
    expect(typeof (r.body as { planCode: string }).planCode).toBe('string');
    expect(typeof (r.body as { planId: string }).planId).toBe('string');
  });
});
