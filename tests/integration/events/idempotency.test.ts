/**
 * T039 — Idempotency integration test (F6).
 *
 * Spec authority:
 *   - research.md R3 (F6-owned eventcreate_idempotency_receipts table)
 *   - plan.md Testing § idempotency
 *   - data-model.md § 1.4
 *
 * Scenario (FR-004): same `X-Request-ID` delivered 5× MUST produce:
 *   - 1 event row
 *   - 1 registration row
 *   - 1 idempotency receipt
 *   - 1 `webhook_receipt_verified` audit
 *   - 4 `webhook_duplicate_rejected` audits
 *
 * Tests against live Neon Singapore via Wave 3.2 `makeIngestWebhookAttendeeDeps`
 * factory — the use-case manages its own tx + tenant context via the
 * deps `runInTenantTx` adapter (Constitution Principle III: Application
 * never imports drizzle-orm; tx boundary owned by Infrastructure).
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
import { ingestWebhookAttendee } from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { makeWebhookPayload } from './helpers/sign-webhook';

describe('T039 — F6 idempotency: 5× same X-Request-ID → 1 fresh + 4 duplicate', () => {
  let tenant: TestTenant;
  const REQUEST_ID = `req-test-idempotency-${Date.now()}-001`;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(tenantWebhookConfigs).values({
        tenantId: tenant.ctx.slug,
        source: 'eventcreate',
        webhookSecretActive: 'test-secret-' + 'a'.repeat(43),
        enabled: true,
      });
    });
  });

  afterAll(async () => {
    await tenant.cleanup();
  });

  it('5× delivery → 1 event + 1 registration + 1 fresh audit + 4 duplicate audits', async () => {
    const payload = makeWebhookPayload({
      event: { externalId: `event_idempotency_${Date.now()}` },
      attendee: { externalId: `att_idempotency_${Date.now()}` },
    });
    const deps = makeIngestWebhookAttendeeDeps();
    const callIngest = async () =>
      ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId: REQUEST_ID,
          source: 'eventcreate_webhook',
          rawPayload: payload,
          sourceIp: '127.0.0.1',
        },
        deps,
      );

    const results = await Promise.all([
      callIngest(),
      callIngest(),
      callIngest(),
      callIngest(),
      callIngest(),
    ]);

    const fresh = results.filter((r) => r.ok).length;
    const dups = results.filter(
      (r) => r.ok === false && r.error.kind === 'duplicate_request_id',
    ).length;
    expect(fresh + dups).toBe(5);
    expect(fresh).toBe(1);
    expect(dups).toBe(4);

    // Persistence — exactly one event + one registration + one receipt
    const eventRows = await runInTenant(tenant.ctx, async (tx) =>
      tx.select().from(events).where(eq(events.tenantId, tenant.ctx.slug)),
    );
    expect(eventRows.length).toBe(1);

    const regRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(eq(eventRegistrations.tenantId, tenant.ctx.slug)),
    );
    expect(regRows.length).toBe(1);

    const receiptRows = await runInTenant(tenant.ctx, async (tx) =>
      tx
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

    // Audit-trail — exactly 1 verified + 4 duplicate-rejected
    // Run with root db (audit_log RLS-permissive policy lets us read
    // across tenants from the owner role).
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
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
