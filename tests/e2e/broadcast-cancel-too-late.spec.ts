/**
 * T167 — F7 US6 cancel-too-late E2E (Phase 8).
 *
 * Spec authority: spec.md US6 AS6 + US2 cancel state machine.
 *
 * Flow (with F7 ON + seeded e2e-member + e2e-admin):
 *   1. Sign in as e2e-member, submit a broadcast.
 *   2. Sign in as e2e-admin, approve the broadcast.
 *   3. Trigger dispatch cron with CRON_SECRET so the row reaches
 *      `status='sending'` (Resend gateway in test env is the configured
 *      mock surface).
 *   4. Member attempts to cancel via `POST /api/broadcasts/[id]/cancel`
 *      → assert HTTP 409 with `broadcast_cancel_too_late` error code.
 *   5. Admin attempts to cancel via `POST /api/admin/broadcasts/[id]/cancel`
 *      → assert HTTP 409 with the same error code.
 *
 * Skips when E2E env or CRON_SECRET are missing.
 */
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

const MEMBER_EMAIL = process.env.E2E_MEMBER_EMAIL;
const MEMBER_PASSWORD = process.env.E2E_MEMBER_PASSWORD;
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD;
const CRON_SECRET = process.env.CRON_SECRET;

test.describe.configure({ mode: 'serial' });

test.describe('F7 US6 — cancel-too-late (T167)', () => {
  test.skip(
    !MEMBER_EMAIL || !MEMBER_PASSWORD || !ADMIN_EMAIL || !ADMIN_PASSWORD || !CRON_SECRET,
    'Set E2E_MEMBER_EMAIL, E2E_MEMBER_PASSWORD, E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD, CRON_SECRET',
  );

  test.beforeAll(async () => {
    await clearE2ERateLimits();
  });

  async function signIn(page: Page, role: 'member' | 'admin'): Promise<void> {
    const path = role === 'member' ? '/portal/sign-in' : '/admin/sign-in';
    const email = role === 'member' ? MEMBER_EMAIL! : ADMIN_EMAIL!;
    const password = role === 'member' ? MEMBER_PASSWORD! : ADMIN_PASSWORD!;
    await page.goto(path);
    await page.locator('input#email').fill(email);
    await page.locator('input#password').fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    const homeRegex = role === 'member' ? /^\/portal(\/|$)/ : /^\/admin(\/|$)/;
    await page.waitForURL((u) => homeRegex.test(new URL(u).pathname), {
      timeout: 15_000,
    });
  }

  test('AS6: cancel after sending is rejected with 409 broadcast_cancel_too_late (member + admin)', async ({
    page,
  }) => {
    // Step 1 — member submits
    await signIn(page, 'member');
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 feature flag is OFF (ship-dark)');

    const submitResp = await page.request.post('/api/broadcasts/submit', {
      data: {
        subject: `Cancel-too-late E2E ${Date.now()}`,
        bodyHtml: '<p>Cancel-too-late test body.</p>',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        scheduledFor: new Date(Date.now() + 30 * 1000).toISOString(),
      },
    });
    expect([200, 201]).toContain(submitResp.status());
    const submitBody = (await submitResp.json()) as {
      broadcastId?: string;
      status?: string;
    };
    test.skip(
      submitBody.status === 'broadcast_quota_blocked',
      'Member quota exhausted',
    );
    expect(submitBody.broadcastId).toBeTruthy();
    const broadcastId = submitBody.broadcastId!;

    // Step 2 — admin approves
    await signIn(page, 'admin');
    const approveResp = await page.request.post(
      `/api/admin/broadcasts/${broadcastId}/approve`,
      { data: {} },
    );
    expect([200, 204]).toContain(approveResp.status());

    // Step 3 — wait + trigger dispatch cron so row reaches 'sending'
    await page.waitForTimeout(35_000);
    const cronResp = await page.request.post(
      '/api/cron/broadcasts/dispatch-scheduled',
      { headers: { Authorization: `Bearer ${CRON_SECRET!}` } },
    );
    expect(cronResp.status()).toBe(200);

    const detailResp = await page.request.get(
      `/api/admin/broadcasts/${broadcastId}`,
    );
    const detail = (await detailResp.json()) as { status?: string };
    test.skip(
      detail.status !== 'sending' && detail.status !== 'sent',
      `Broadcast did not reach sending state (observed: ${detail.status})`,
    );

    // Step 4 — admin attempts to cancel → 409
    const adminCancelResp = await page.request.post(
      `/api/admin/broadcasts/${broadcastId}/cancel`,
      { data: { cancellationReason: 'too late attempt by admin' } },
    );
    expect(adminCancelResp.status()).toBe(409);
    const adminCancelBody = (await adminCancelResp.json()) as {
      error?: { code?: string };
    };
    expect(adminCancelBody.error?.code).toBe('broadcast_cancel_too_late');

    // Step 5 — sign back in as member, attempt to cancel → 409
    await signIn(page, 'member');
    const memberCancelResp = await page.request.post(
      `/api/broadcasts/${broadcastId}/cancel`,
      { data: { cancellationReason: 'too late attempt by member' } },
    );
    expect(memberCancelResp.status()).toBe(409);
    const memberCancelBody = (await memberCancelResp.json()) as {
      error?: { code?: string };
    };
    expect(memberCancelBody.error?.code).toBe('broadcast_cancel_too_late');
  });
});
