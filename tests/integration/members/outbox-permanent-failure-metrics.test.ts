/**
 * Integration test — regression guard for `outboxMetrics.permanentFailure`
 * label emission on all 3 permanent-failure paths.
 *
 *   reason='no_template_handler' — unrenderable payload hits MAX_ATTEMPTS
 *   reason='max_retries'         — send keeps failing transiently, hits MAX_ATTEMPTS
 *   reason='invalid_recipient'   — Resend rejects with `invalid-recipient`
 *                                  (short-circuits to permanent regardless of attempts)
 *
 * The label taxonomy is documented in docs/observability.md § 14.1 and is
 * alert-critical — renaming or omitting a reason value silently breaks
 * Vercel Alert rules that filter by `reason`.
 *
 * `emailSender.send` is mocked at the module level so the tests never
 * touch the real Resend API. `outboxMetrics` is also mocked so we can
 * assert on the call shape without spinning up the OTel pipeline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

// Hoisted mocks — must appear above route + db imports.
vi.mock('@/lib/metrics', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/metrics')>();
  return {
    ...original,
    outboxMetrics: {
      permanentFailure: vi.fn(),
      stuckRows: vi.fn(),
    },
  };
});

const sendMock = vi.fn();
vi.mock('@/modules/auth/infrastructure/email/resend-client', () => ({
  emailSender: {
    send: (...args: unknown[]) => sendMock(...args),
  },
}));

import { db } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { outboxMetrics } from '@/lib/metrics';
import { GET as outboxDispatch } from '@/app/api/cron/outbox-dispatch/route';

describe('integration: outbox permanentFailure metric labels', () => {
  const createdOutboxIds: string[] = [];
  const previousCronSecret = process.env.CRON_SECRET;

  beforeEach(async () => {
    process.env.CRON_SECRET = 'test-outbox-perm-metrics-secret';
    vi.clearAllMocks();
    // Isolation guard: nuke every pending cross-tenant (tenant_id=null)
    // outbox row left over from prior tests in the suite. The test's
    // `sendMock` is called ONCE per dispatched row, so any leftover
    // pending row inflates the count and breaks toHaveBeenCalledOnce().
    // Post-Round-3 Option G: F1 invitation rows carry tenant_id
    // 'swecham'; this delete scopes to that slug so non-swecham
    // tenant rows from parallel tests are unaffected.
    await db
      .delete(notificationsOutbox)
      .where(
        and(
          eq(notificationsOutbox.tenantId, 'swecham'),
          eq(notificationsOutbox.status, 'pending'),
        ),
      );
  });

  afterEach(async () => {
    for (const id of createdOutboxIds) {
      await db.delete(notificationsOutbox).where(eq(notificationsOutbox.id, id));
    }
    createdOutboxIds.length = 0;
    if (previousCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = previousCronSecret;
    }
  });

  async function dispatch() {
    const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const response = await outboxDispatch(req);
    expect(response.status).toBe(200);
  }

  it("emits permanentFailure(type, 'no_template_handler') when payload is unrenderable at MAX_ATTEMPTS", async () => {
    // Empty contextData → buildPayload returns null → no_template retry path.
    // attempts=4 means the next increment hits MAX_ATTEMPTS=5 → permanent.
    const id = randomUUID();
    await db.insert(notificationsOutbox).values({
      id,
      tenantId: 'swecham',
      notificationType: 'member_invitation',
      toEmail: `perm-nth-${id.slice(0, 8)}@swecham.test`,
      locale: 'en',
      contextData: {},
      status: 'pending',
      attempts: 4,
      nextRetryAt: new Date(Date.now() - 1000),
    });
    createdOutboxIds.push(id);

    await dispatch();

    expect(outboxMetrics.permanentFailure).toHaveBeenCalledWith(
      'member_invitation',
      'no_template_handler',
    );
  }, 30_000);

  it("emits permanentFailure(type, 'invalid_recipient') when Resend rejects the address", async () => {
    // Valid context → buildPayload succeeds → reaches emailSender.send.
    // Mock returns invalid-recipient → short-circuits to permanent at
    // attempts 0 → 1 regardless of MAX_ATTEMPTS.
    sendMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'invalid-recipient',
        message: 'no such mailbox',
      },
    });

    const id = randomUUID();
    await db.insert(notificationsOutbox).values({
      id,
      tenantId: 'swecham',
      notificationType: 'member_invitation',
      toEmail: `perm-inv-${id.slice(0, 8)}@swecham.test`,
      locale: 'en',
      // Valid context for member_invitation: token + role must be present.
      contextData: { token: 'tok-abc-123', role: 'member' },
      status: 'pending',
      attempts: 0,
      nextRetryAt: new Date(Date.now() - 1000),
    });
    createdOutboxIds.push(id);

    await dispatch();

    expect(sendMock).toHaveBeenCalledOnce();
    expect(outboxMetrics.permanentFailure).toHaveBeenCalledWith(
      'member_invitation',
      'invalid_recipient',
    );
  }, 30_000);

  it("emits permanentFailure(type, 'max_retries') when transient send failures hit MAX_ATTEMPTS", async () => {
    // Transient send failure (non-invalid-recipient) + attempts=4 → next
    // attempt = 5 = MAX_ATTEMPTS → permanent with reason='max_retries'.
    sendMock.mockResolvedValue({
      ok: false,
      error: {
        code: 'provider-error',
        message: 'resend 503',
      },
    });

    const id = randomUUID();
    await db.insert(notificationsOutbox).values({
      id,
      tenantId: 'swecham',
      notificationType: 'member_invitation',
      toEmail: `perm-max-${id.slice(0, 8)}@swecham.test`,
      locale: 'en',
      contextData: { token: 'tok-def-456', role: 'member' },
      status: 'pending',
      attempts: 4,
      nextRetryAt: new Date(Date.now() - 1000),
    });
    createdOutboxIds.push(id);

    await dispatch();

    expect(sendMock).toHaveBeenCalledOnce();
    expect(outboxMetrics.permanentFailure).toHaveBeenCalledWith(
      'member_invitation',
      'max_retries',
    );
  }, 30_000);
});
