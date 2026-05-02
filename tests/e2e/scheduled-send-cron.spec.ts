/**
 * T166 — F7 US6 scheduled-send via cron (Phase 8).
 *
 * Spec authority: spec.md US6 AS1.
 *
 * Flow (with F7 ON + seeded e2e-member + CRON_SECRET set):
 *   1. Sign in as e2e-member, submit a broadcast with `scheduled_for =
 *      now() + 5 min`.
 *   2. Sign in as e2e-admin, approve the broadcast.
 *   3. Verify the row sits in `status='approved'` with `scheduled_for`
 *      set.
 *   4. Wait briefly OR trigger the dispatch cron manually via
 *      `POST /api/cron/broadcasts/dispatch-scheduled` with
 *      `Authorization: Bearer ${CRON_SECRET}`.
 *   5. Cron worker should pick up the row (because `scheduled_for <=
 *      now()` after the wait), call Resend, transition to `sending`,
 *      and emit `broadcast_send_started` audit with `scheduled_for +
 *      actual_send_at + delay_seconds` payload.
 *
 * Skips when E2E env vars or CRON_SECRET are missing — in CI without
 * the seed environment we cannot meaningfully exercise the dispatch
 * pipeline (the cron route would 401 without the secret).
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

test.describe('F7 US6 — scheduled-send via cron (T166)', () => {
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

  test('AS1: member submits scheduled, admin approves, cron triggers Resend dispatch', async ({
    page,
  }) => {
    // Step 1 — member submits scheduled broadcast
    await signIn(page, 'member');
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 feature flag is OFF (ship-dark)');

    const scheduledFor = new Date(Date.now() + 60 * 1000).toISOString();
    const submitResp = await page.request.post('/api/broadcasts/submit', {
      data: {
        subject: `Scheduled E2E ${Date.now()}`,
        bodyHtml: '<p>Scheduled body for T166 cron dispatch test.</p>',
        segmentType: 'all_members',
        segmentParams: null,
        customRecipientEmails: null,
        scheduledFor,
      },
    });
    expect([200, 201]).toContain(submitResp.status());
    const submitBody = (await submitResp.json()) as {
      broadcastId?: string;
      status?: string;
    };
    test.skip(
      submitBody.status === 'broadcast_quota_blocked',
      'Member quota exhausted; reseed before re-running',
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

    // Step 3 — verify row sits in approved with scheduled_for set
    const detailResp = await page.request.get(
      `/api/admin/broadcasts/${broadcastId}`,
    );
    expect(detailResp.status()).toBe(200);
    const detail = (await detailResp.json()) as {
      status?: string;
      scheduled_for?: string | null;
    };
    expect(detail.status).toBe('approved');
    expect(detail.scheduled_for).toBeTruthy();

    // Step 4 — wait until scheduled_for elapses + trigger cron manually
    await page.waitForTimeout(65_000); // 65s — past the 1-min schedule
    const cronResp = await page.request.post(
      '/api/cron/broadcasts/dispatch-scheduled',
      {
        headers: {
          Authorization: `Bearer ${CRON_SECRET!}`,
        },
      },
    );
    expect(cronResp.status()).toBe(200);
    const cronSummary = (await cronResp.json()) as {
      processed?: number;
      succeeded?: number;
    };
    // Cron should have processed at least our row
    expect(cronSummary.processed).toBeGreaterThanOrEqual(1);

    // Step 5 — verify the row transitioned to 'sending' (or further)
    const finalResp = await page.request.get(
      `/api/admin/broadcasts/${broadcastId}`,
    );
    expect(finalResp.status()).toBe(200);
    const final = (await finalResp.json()) as { status?: string };
    expect(['sending', 'sent']).toContain(final.status);
  });
});
