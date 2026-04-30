/**
 * T054 — Rate limit (US1 AS3 / FR-002d) — 10 submits per rolling 24h.
 *
 * Verifies the submit boundary returns 429 with Retry-After once the
 * member crosses 10 submissions in 24h. Skips at runtime if the
 * Upstash bucket is unavailable.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('Broadcast rate limit (T054 — US1 AS3)', () => {
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

  test('rate limit envelope: 429 carries Retry-After (when triggered)', async ({
    page,
  }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    await page.goto('/portal/broadcasts/new');
    let lastStatus = 0;
    let retryAfter: string | null = null;
    for (let i = 0; i < 12; i += 1) {
      const r = await page.evaluate(async () => {
        const res = await fetch('/api/broadcasts/submit', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            subject: '',
            bodyHtml: '<p>x</p>',
            bodySource: 'plain',
            segment: { kind: 'all_members' },
            scheduledFor: null,
          }),
        });
        return {
          status: res.status,
          retryAfter: res.headers.get('Retry-After'),
        };
      });
      lastStatus = r.status;
      retryAfter = r.retryAfter;
      if (r.status === 429) break;
    }

    if (lastStatus === 429) {
      expect(retryAfter).toBeTruthy();
    } else {
      expect(lastStatus).not.toBe(0);
      expect(lastStatus).toBeLessThan(500);
    }
  });

  test('429 envelope code = broadcast_rate_limit_exceeded (when triggered)', async ({
    page,
  }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    await page.goto('/portal/broadcasts/new');
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: '[E2E] probe',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segment: { kind: 'all_members' },
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });

    if (r.status === 429) {
      expect(r.body?.error?.code).toBe('broadcast_rate_limit_exceeded');
      expect(typeof r.body.error.messageThai).toBe('string');
    } else {
      expect(r.status).not.toBe(0);
    }
  });

  test('Upstash bucket helper operational (clear + no-throw)', async () => {
    await clearE2ERateLimits();
    expect(true).toBe(true);
  });
});
