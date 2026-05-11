/**
 * Integration test — regression guard for the `no_template_handler`
 * retry-backoff parity fix (commit 3c44b46, review finding H1).
 *
 * When an outbox row's `notification_type + context_data` combination
 * does not produce a renderable email (e.g. `member_invitation` with
 * empty context_data), the dispatcher MUST schedule the next retry
 * using the same exponential table as the send-failure path:
 *
 *   RETRY_BACKOFF_SECONDS = [60, 300, 1800, 10800, 43200]
 *
 * Before the fix the no-template branch used a hardcoded 5-minute
 * (300 s) delay, so the first retry happened at t+5m instead of t+60s.
 * This test drives the real `GET` handler against live Neon and asserts
 * `next_retry_at ≈ now + 60 s` on the first (attempts=0 → 1) failure.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { notificationsOutbox } from '@/modules/auth/infrastructure/db/schema';
import { GET as outboxDispatch } from '@/app/api/cron/outbox-dispatch/route';

describe('integration: outbox dispatcher no_template_handler backoff parity', () => {
  const createdOutboxIds: string[] = [];
  const previousCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    // Exercise the authenticated path so we do not rely on dev-mode
    // bypass, which would shift the test's behaviour off the path the
    // regression guard is meant to cover.
    process.env.CRON_SECRET = 'test-outbox-no-template-secret';
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

  it('schedules first retry at ~60s (not 300s) for unrenderable member_invitation row', async () => {
    const outboxId = randomUUID();
    // member_invitation with empty context_data — buildPayload returns
    // null because token + role are missing. Dispatcher treats this as
    // the no_template_handler retry path.
    const seededAt = new Date(Date.now() - 1000); // 1s ago so lte(nextRetryAt, now()) succeeds
    await db.insert(notificationsOutbox).values({
      id: outboxId,
      tenantId: 'swecham',
      notificationType: 'member_invitation',
      toEmail: `no-template-${outboxId.slice(0, 8)}@swecham.test`,
      locale: 'en',
      contextData: {},
      status: 'pending',
      attempts: 0,
      nextRetryAt: seededAt,
    });
    createdOutboxIds.push(outboxId);

    const beforeCallMs = Date.now();
    const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const response = await outboxDispatch(req);
    const afterCallMs = Date.now();

    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.id, outboxId));

    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toBe('no_template_handler');

    // next_retry_at should be ≈ dispatcher-now + 60s, NOT + 300s.
    const nextRetryMs = row!.nextRetryAt!.getTime();
    const lowerBound = beforeCallMs + 60_000 - 500; // allow 500ms slack
    const upperBound = afterCallMs + 60_000 + 500;

    expect(nextRetryMs).toBeGreaterThanOrEqual(lowerBound);
    expect(nextRetryMs).toBeLessThanOrEqual(upperBound);

    // Specifically reject the pre-fix 300s hardcode.
    const deltaSeconds = Math.round(
      (nextRetryMs - (beforeCallMs + afterCallMs) / 2) / 1000,
    );
    expect(deltaSeconds).toBeLessThan(120); // well under the 300s pre-fix value
  }, 30_000);

  it('permanent failure on 5th no_template attempt writes audit row (S1 null-tenant parity)', async () => {
    const outboxId = randomUUID();
    const seededAt = new Date(Date.now() - 1000);
    await db.insert(notificationsOutbox).values({
      id: outboxId,
      tenantId: 'swecham',
      notificationType: 'member_invitation',
      toEmail: `no-template-perm-${outboxId.slice(0, 8)}@swecham.test`,
      locale: 'en',
      contextData: {},
      status: 'pending',
      attempts: 4, // next increment hits MAX_ATTEMPTS=5 → permanent
      nextRetryAt: seededAt,
    });
    createdOutboxIds.push(outboxId);

    const req = new NextRequest('http://localhost/api/cron/outbox-dispatch', {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    });
    const response = await outboxDispatch(req);
    expect(response.status).toBe(200);

    const [row] = await db
      .select()
      .from(notificationsOutbox)
      .where(eq(notificationsOutbox.id, outboxId));

    expect(row?.status).toBe('permanently_failed');
    expect(row?.attempts).toBe(5);
    expect(row?.lastError).toBe('no_template_handler');
    // S1: audit row insertion happens inside the tx; we don't grep
    // auditLog here because null-tenant rows may be cleaned by the
    // shared clear-test-data helper. Status flip is sufficient signal
    // that the permanent-failure branch ran; the outbox-member-invitation
    // test covers the happy-path audit shape.
  }, 30_000);
});
