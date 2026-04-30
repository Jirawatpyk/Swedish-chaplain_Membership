/**
 * T053 — Quota-block envelope (US1 AS2).
 *
 * Verifies the submit endpoint returns broadcast_quota_blocked once a
 * member's annual quota is exhausted. Skips at runtime when the
 * e2e-member's used quota is below cap (most likely state in fresh
 * test runs).
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('Broadcast quota block (T053 — US1 AS2)', () => {
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
    if (response?.status() === 503) return;
    expect(response?.status()).toBeLessThan(400);
    // Quota display surface is the SSR-rendered <QuotaDisplay /> from
    // the compose page or benefits page; either renders a numeric
    // counter we can assert exists.
    const qc = page.locator('[data-testid="quota-display"]').or(
      page.getByText(/quota|remaining/i),
    );
    await expect(qc.first()).toBeVisible({ timeout: 10_000 });
  });

  test('quota state surfaced via /api/portal/broadcasts/quota probe', async ({
    page,
  }) => {
    await signIn(page);
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/portal/broadcasts/quota', {
        credentials: 'same-origin',
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    test.skip(
      r.status === 404 || r.status === 503,
      `Quota endpoint not available (status ${r.status})`,
    );
    if (r.status === 200) {
      // Response shape per FR-003 + spec § 2.6
      const body = r.body as Record<string, number>;
      expect(typeof body.used).toBe('number');
      expect(typeof body.reserved).toBe('number');
      expect(typeof body.remaining).toBe('number');
      expect(typeof body.cap).toBe('number');
    }
  });

  test('quota_blocked envelope when used = cap (skip if quota available)', async ({
    page,
  }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    // Probe quota state. If the member has remaining slots, this test
    // skips because we can't reproduce the boundary without burning
    // through the member's actual quota.
    const quota = await page.evaluate(async () => {
      const res = await fetch('/api/portal/broadcasts/quota', {
        credentials: 'same-origin',
      });
      if (!res.ok) return null;
      return res.json();
    });
    const remaining =
      typeof (quota as { remaining?: number })?.remaining === 'number'
        ? (quota as { remaining: number }).remaining
        : null;
    test.skip(
      remaining === null || remaining > 0,
      `Member has ${remaining ?? 'unknown'} remaining quota; cannot reproduce quota_blocked`,
    );

    await page.goto('/portal/broadcasts/new');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: '[E2E] quota-blocked',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segment: { kind: 'all_members' },
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    expect(r.status).toBe(422);
    expect(r.body?.error?.code).toBe('broadcast_quota_blocked');
  });
});
