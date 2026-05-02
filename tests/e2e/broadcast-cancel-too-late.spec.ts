/**
 * T167 — F7 US6 cancel-too-late E2E (Phase 8).
 *
 * Spec authority: spec.md US6 AS6 + US2 cancel state machine.
 *
 * Flow (with F7 ON + seeded e2e-member + e2e-admin + CRON_SECRET set):
 *   1. Sign in as e2e-member, submit a broadcast (send_now eligible).
 *   2. Sign in as e2e-admin, approve + dispatch via cron so the row
 *      reaches `status='sending'`.
 *   3. Member attempts to cancel via `/api/broadcasts/[id]/cancel`
 *      → assert HTTP 409 with `broadcast_cancel_too_late` error code.
 *   4. Admin attempts to cancel via `/api/admin/broadcasts/[id]/cancel`
 *      → assert HTTP 409 with the same error code.
 *
 * Skips when E2E env or CRON_SECRET are missing.
 *
 * Submit body shape matches the route schema (see existing
 * `broadcast-compose-and-submit.spec.ts`):
 *   - `subject`, `bodyHtml`, `bodySource`, `segment: {kind}`,
 *     `scheduledFor` (null for send-now eligible).
 */
import type { Page } from '@playwright/test';
import postgres from 'postgres';
import { expect, test } from './fixtures';
import { clearE2ERateLimits } from './helpers/rate-limit';

/**
 * Bypass for AS6 testing — production cron + Resend dispatch land in
 * `sending` state when Resend has a valid test-mode API key. In our
 * dev/CI env without a Resend key the broadcast permanently fails to
 * `failed_to_dispatch` instead, so AS6 (which requires `sending`)
 * cannot be exercised through the natural pipeline. This helper
 * directly UPDATEs the row to `sending` so the cancel-too-late
 * invariant can be tested deterministically.
 *
 * Uses raw `postgres` via `DATABASE_URL` (BYPASSRLS owner role) —
 * mirrors `tests/e2e/helpers/broadcasts-seed.ts` pattern. Skips if
 * `DATABASE_URL` is missing (CI without DB access).
 */
/**
 * See `scheduled-send-cron.spec.ts wipeE2EMemberBroadcasts` JSDoc.
 * Resets e2e-member's broadcast history so the quota slot is free.
 */
async function wipeE2EMemberBroadcasts(): Promise<void> {
  const dbUrl = process.env.DATABASE_URL;
  const memberEmail = process.env.E2E_MEMBER_EMAIL;
  const tenantId = process.env.E2E_TENANT_SLUG ?? 'swecham';
  if (!dbUrl || !memberEmail) return;
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    const memberRows = await sql<Array<{ member_id: string }>>`
      SELECT m.member_id::text AS member_id
      FROM users u
      JOIN contacts c
        ON c.linked_user_id = u.id AND c.tenant_id = ${tenantId}
      JOIN members m
        ON m.member_id = c.member_id AND m.tenant_id = ${tenantId}
      WHERE u.email = ${memberEmail}
      LIMIT 1
    `;
    const memberId = memberRows[0]?.member_id;
    if (!memberId) return;
    await sql`
      ALTER TABLE broadcast_deliveries DISABLE TRIGGER broadcast_deliveries_no_delete
    `;
    await sql`
      DELETE FROM broadcast_deliveries
      WHERE broadcast_id IN (
        SELECT broadcast_id FROM broadcasts
        WHERE requested_by_member_id = ${memberId}::uuid
      )
    `;
    await sql`
      ALTER TABLE broadcast_deliveries ENABLE TRIGGER broadcast_deliveries_no_delete
    `;
    await sql`
      DELETE FROM broadcasts
      WHERE requested_by_member_id = ${memberId}::uuid
    `;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function forceBroadcastToSending(broadcastId: string): Promise<boolean> {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return false;
  const sql = postgres(dbUrl, { ssl: 'require', max: 1 });
  try {
    await sql`
      UPDATE broadcasts
      SET status = 'sending'::broadcast_status,
          sending_started_at = now(),
          resend_audience_id = COALESCE(resend_audience_id, 'aud-e2e-stub'),
          resend_broadcast_id = COALESCE(resend_broadcast_id, 'bcast-e2e-stub'),
          updated_at = now()
      WHERE broadcast_id = ${broadcastId}::uuid
    `;
    return true;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

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
    await wipeE2EMemberBroadcasts();
  });

  async function signIn(page: Page, role: 'member' | 'admin'): Promise<void> {
    const path = role === 'member' ? '/portal/sign-in' : '/admin/sign-in';
    const email = role === 'member' ? MEMBER_EMAIL! : ADMIN_EMAIL!;
    const password = role === 'member' ? MEMBER_PASSWORD! : ADMIN_PASSWORD!;
    await page.goto(path);
    const emailInput = page.locator('input#email');
    const passwordInput = page.locator('input#password');
    await emailInput.click();
    await emailInput.fill(email);
    await expect(emailInput).toHaveValue(email);
    await passwordInput.click();
    await passwordInput.fill(password);
    await expect(passwordInput).toHaveValue(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    // CRITICAL: exclude sign-in path — broad regex matches sign-in
    // itself and resolves before redirect → 401 no-session on
    // subsequent fetches. See companion comment in scheduled-send-cron.spec.ts.
    await page.waitForURL(
      (u) => {
        const p = new URL(u).pathname;
        const homeMatch = role === 'member'
          ? /^\/portal(\/|$)/.test(p)
          : /^\/admin(\/|$)/.test(p);
        return homeMatch && !p.endsWith('/sign-in');
      },
      { timeout: 15_000 },
    );
  }

  test('AS6: cancel after sending is rejected with 409 broadcast_cancel_too_late (member + admin)', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    // beforeAll wiped e2e-member's broadcast history → quota = 1/1

    // Step 1 — member submits send-now-eligible broadcast
    await signIn(page, 'member');
    const probe = await page.request.get('/portal/broadcasts/new');
    test.skip(probe.status() === 503, 'F7 feature flag is OFF (ship-dark)');

    await page.goto('/portal/broadcasts/new');
    const submitResult = await page.evaluate(async () => {
      const res = await fetch('/api/broadcasts/submit', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subject: `[T167] Cancel-too-late E2E ${Date.now()}`,
          bodyHtml: '<p>Cancel-too-late test body.</p>',
          bodySource: 'plain',
          segment: { kind: 'all_members' },
          scheduledFor: null,
        }),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    });

    if (submitResult.status !== 200) {
      const code = submitResult.body?.error?.code ?? submitResult.body?.status ?? 'unknown';
      test.skip(
        true,
        `Submit returned ${submitResult.status} (${code}) — re-seed E2E member quota and retry`,
      );
      return;
    }
    expect(submitResult.body).toMatchObject({ status: 'submitted' });
    const broadcastId = submitResult.body.broadcastId as string;

    // Step 2 — admin signs in + approves + triggers dispatch cron
    const adminCtx = await page.context().browser()!.newContext();
    const adminPage = await adminCtx.newPage();
    try {
      await signIn(adminPage, 'admin');
      const approveResult = await adminPage.evaluate(
        async (id) => {
          const res = await fetch(`/api/admin/broadcasts/${id}/approve`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ decision: 'send_now' }),
          });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
        broadcastId,
      );
      expect([200, 204]).toContain(approveResult.status);

      // Force the row to 'sending' via direct DB write — see
      // `forceBroadcastToSending` JSDoc for rationale (Resend
      // test-mode key absence in dev env). Production AS6 fires
      // through the natural cron + Resend dispatch path; this E2E
      // exercises the cancel-too-late state-machine guard which is
      // independent of the dispatch mechanism.
      const forced = await forceBroadcastToSending(broadcastId);
      test.skip(!forced, 'DATABASE_URL not set — cannot force sending state');

      // Step 3 — admin attempts to cancel → 409
      const adminCancelResult = await adminPage.evaluate(
        async (id) => {
          const res = await fetch(`/api/admin/broadcasts/${id}/cancel`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ cancellationReason: 'too late attempt by admin' }),
          });
          return { status: res.status, body: await res.json().catch(() => null) };
        },
        broadcastId,
      );
      expect(adminCancelResult.status).toBe(409);
      expect(adminCancelResult.body?.error?.code).toBe('broadcast_cancel_too_late');
    } finally {
      await adminCtx.close();
    }

    // Step 4 — member attempts to cancel → 409
    const memberCancelResult = await page.evaluate(
      async (id) => {
        const res = await fetch(`/api/broadcasts/${id}/cancel`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cancellationReason: 'too late attempt by member' }),
        });
        return { status: res.status, body: await res.json().catch(() => null) };
      },
      broadcastId,
    );
    expect(memberCancelResult.status).toBe(409);
    expect(memberCancelResult.body?.error?.code).toBe('broadcast_cancel_too_late');
  });
});
