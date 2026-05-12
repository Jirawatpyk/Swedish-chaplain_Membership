/**
 * T039 — Idempotency integration test (F6).
 *
 * Spec authority:
 *   - research.md R3 (F6-owned eventcreate_idempotency_receipts table)
 *   - plan.md Testing § idempotency
 *   - data-model.md § 1.4
 *
 * Scenario (FR-004): same `X-Request-ID` delivered 5× to the webhook
 * receiver MUST produce:
 *   - 1 event row
 *   - 1 registration row
 *   - 1 `webhook_receipt_verified` audit event
 *   - 4 `webhook_duplicate_rejected` audit events
 *   - 1 idempotency receipt row
 *
 * The first call commits; subsequent calls short-circuit on the F6-owned
 * `eventcreate_idempotency_receipts` ON CONFLICT DO NOTHING semantics
 * inside the strict-transactional ACID unit (FR-037).
 *
 * RED reason: `ingestWebhookAttendee` use-case + adapters not yet
 * exported from `@/modules/events`. Module import fails → red.
 *
 * Turns GREEN: T047 + T048 + T049 + T050 + T051 land.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  eventcreateIdempotencyReceipts,
  tenantWebhookConfigs,
} from '@/modules/events/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { makeWebhookPayload } from './helpers/sign-webhook';

// @ts-expect-error — ingestWebhookAttendee use-case not yet exported (T047).
import { ingestWebhookAttendee, makeIngestWebhookAttendeeDeps } from '@/modules/events';

describe('T039 — F6 idempotency: 5× same X-Request-ID → 1 fresh + 4 duplicate', () => {
  let tenant: TestTenant;
  const REQUEST_ID = 'req-test-idempotency-001';

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    // Seed a webhook config so the use-case can resolve the active secret.
    await runInTenant(tenant.ctx, async () => {
      await db.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'test-secret-43-chars-aaaaaaaaaaaaaaaaaa',
        enabled: true,
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('5× delivery → 1 event + 1 registration + 1 fresh audit + 4 duplicate audits', async () => {
    const payload = makeWebhookPayload();
    const deps = makeIngestWebhookAttendeeDeps();
    const callIngest = async () =>
      runInTenant(tenant.ctx, async () =>
        ingestWebhookAttendee({
          tenantId: tenant.ctx.slug,
          requestId: REQUEST_ID,
          source: 'eventcreate_webhook',
          rawPayload: payload,
          sourceIp: '127.0.0.1',
        }, deps),
      );

    const results = await Promise.all([
      callIngest(),
      callIngest(),
      callIngest(),
      callIngest(),
      callIngest(),
    ]);

    // Exactly one fresh + four duplicates
    const fresh = results.filter((r: { ok: boolean }) => r.ok).length;
    const dups = results.filter(
      (r: { ok: boolean; error?: { kind?: string } }) =>
        r.ok === false && r.error?.kind === 'duplicate_request_id',
    ).length;
    expect(fresh + dups).toBe(5);
    expect(fresh).toBe(1);
    expect(dups).toBe(4);

    // Persistence assertions
    const eventRows = await runInTenant(tenant.ctx, async () =>
      db.select().from(events).where(eq(events.tenantId, tenant.ctx.slug)),
    );
    expect(eventRows.length).toBe(1);

    const regRows = await runInTenant(tenant.ctx, async () =>
      db.select().from(eventRegistrations).where(eq(eventRegistrations.tenantId, tenant.ctx.slug)),
    );
    expect(regRows.length).toBe(1);

    const receiptRows = await runInTenant(tenant.ctx, async () =>
      db
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(
          and(
            eq(eventcreateIdempotencyReceipts.tenantId, tenant.ctx.slug),
            eq(eventcreateIdempotencyReceipts.requestId, REQUEST_ID),
          ),
        ),
    );
    expect(receiptRows.length).toBe(1);

    // Audit-trail assertions — 1 verified + 4 duplicate-rejected
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    // Cast eventType to string — Drizzle pgEnum declaration in F1's
    // audit_log schema is static at compile time and doesn't reflect the
    // 35 F6 enum extensions added by migration 0132. The runtime values
    // are correct (the SQL enum carries them); only the TS-level type
    // narrowing needs the escape hatch.
    const verifiedCount = auditRows.filter(
      (r) => (r.eventType as string) === 'webhook_receipt_verified',
    ).length;
    const duplicateCount = auditRows.filter(
      (r) => (r.eventType as string) === 'webhook_duplicate_rejected',
    ).length;
    expect(verifiedCount).toBe(1);
    expect(duplicateCount).toBe(4);
  });
});
