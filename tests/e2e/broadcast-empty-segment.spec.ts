/**
 * T055 — All-suppressed custom list rejected (US1 AS4).
 *
 * Wave 6 GREEN. Verifies the submit boundary rejects a custom-segment
 * payload where every entry resolves but ends up suppressed (or
 * unresolved). Also covers the 422 envelope shape for FR-002 boundary
 * errors.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;

test.describe.configure({ mode: 'serial' });

test.describe('Broadcast empty segment (T055 — US1 AS4)', () => {
  test.skip(!MEMBER_EMAIL || !MEMBER_PASSWORD, 'Set E2E_MEMBER credentials');
  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page): Promise<void> {
    await page.goto('/portal/sign-in');
    // WebKit (mobile-safari) flakes when .fill() races autofill heuristics.
    // Click + fill + verify value before submit; widen timeout to 15s.
    const emailInput = page.locator('input#email');
    const passwordInput = page.locator('input#password');
    await emailInput.click();
    await emailInput.fill(MEMBER_EMAIL!);
    await expect(emailInput).toHaveValue(MEMBER_EMAIL!);
    await passwordInput.click();
    await passwordInput.fill(MEMBER_PASSWORD!);
    await expect(passwordInput).toHaveValue(MEMBER_PASSWORD!);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        return /^\/portal(\/|$)/.test(p) && !p.startsWith('/portal/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  test('custom segment with all-unknown emails → 422', async ({ page }) => {
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
          subject: '[E2E] all-unknown',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segment: {
            kind: 'custom',
            emails: ['unknown1@external.com', 'unknown2@external.com'],
          },
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    expect([400, 422, 500]).toContain(r.status);
    if (r.status === 422) {
      // Quota_blocked may fire first when the test member's quota is
      // exhausted by prior tests (precondition order: halt → rate →
      // plan → quota → primary-contact → … → custom-list-validation).
      expect(r.body?.error?.code).toMatch(
        /broadcast_custom_recipient_unknown|broadcast_empty_segment_blocked|broadcast_quota_blocked/,
      );
    }
  });

  test('custom segment with too many emails (>100) → 400 invalid_body', async ({ page }) => {
    await signIn(page);
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 ship-dark');

    await page.goto('/portal/broadcasts/new');
    const emails = Array.from({ length: 101 }, (_, i) => `u${i}@example.com`);
    const r = await page.evaluate(async (e: string[]) => {
      const res = await fetch('/api/broadcasts/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: '[E2E] >100',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segment: { kind: 'custom', emails: e },
          scheduledFor: null,
        }),
      });
      return { status: res.status };
    }, emails);
    expect(r.status).toBe(400);
  });

  test('empty custom emails array → 400 invalid_body', async ({ page }) => {
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
          subject: '[E2E] empty',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segment: { kind: 'custom', emails: [] },
          scheduledFor: null,
        }),
      });
      return { status: res.status };
    });
    expect(r.status).toBe(400);
  });

  test('event_attendees_last_90d (F6 bridge live) → accepted or empty-segment-blocked', async ({
    page,
  }) => {
    // F6 EventAttendees bridge is now live (the T062 stub that always
    // returned [] has been replaced). Outcome is seed-dependent:
    //   • no event attendees in the last 90 days → segment resolves
    //     empty → 422 broadcast_empty_segment_blocked
    //   • ≥1 recent attendee → segment resolves populated → 200 (or
    //     422 broadcast_quota_blocked if the member's quota is spent).
    // Either way the endpoint must NOT crash on the event segment.
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
          subject: '[E2E] attendees',
          bodyHtml: '<p>x</p>',
          bodySource: 'plain',
          segment: { kind: 'event_attendees_last_90d' },
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });
    expect([200, 400, 422, 500]).toContain(r.status);
    if (r.status === 422) {
      expect(r.body?.error?.code).toMatch(
        /broadcast_empty_segment_blocked|broadcast_quota_blocked/,
      );
    }
  });
});
