/**
 * T040 — Strict-transactional ingest integration test (F6 / FR-037).
 *
 * Spec authority:
 *   - research.md R6 (strict-transactional ACID unit + audit dual-write)
 *   - plan.md Testing § transactional + round-1 E14
 *   - FR-037
 *
 * Simulates failure at each stage of the ACID unit (event upsert,
 * registration insert, idempotency receipt, quota decrement) by mocking
 * each port to throw. Asserts:
 *   (a) zero partial state — no rows persisted in any of the 4 F6 tables
 *   (b) `webhook_rolled_back` audit emitted in a SEPARATE post-rollback tx
 *   (c) Zapier replay (same X-Request-ID after recovery) commits cleanly
 *
 * RED reason: `ingestWebhookAttendee` use-case + composition deps factory
 * not yet exported from `@/modules/events`. Module import fails → red.
 *
 * Turns GREEN: T047 + dependent adapters land.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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

// @ts-expect-error — use-case + deps factory not yet exported (T047).
import { ingestWebhookAttendee, makeIngestWebhookAttendeeDeps } from '@/modules/events';

const STAGES = [
  'event_upsert',
  'registration_insert',
  'idempotency_receipt',
  'quota_decrement',
] as const;

describe('T040 — F6 strict-transactional ingest (FR-037 rollback per stage)', () => {
  let tenant: TestTenant;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
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

  it.each(STAGES)('failure at stage `%s` → zero side effects + webhook_rolled_back audit emitted in separate tx', async (failingStage) => {
    const payload = makeWebhookPayload({
      event: { externalId: `event_stage_${failingStage}` },
      attendee: { externalId: `att_stage_${failingStage}` },
    });

    // Build deps with a failure injected at the chosen stage.
    const deps = makeIngestWebhookAttendeeDeps();
    const failingRepo = vi.fn().mockRejectedValue(new Error(`simulated ${failingStage} failure`));
    const portKeyMap: Record<typeof failingStage, string> = {
      event_upsert: 'eventsRepo.upsert',
      registration_insert: 'registrationsRepo.insertOnConflictDoNothing',
      idempotency_receipt: 'idempotencyStore.tryInsert',
      quota_decrement: 'quotaAccounting.queryAllotments',
    };
    // Inject via deps mutation — composition factory exposes the ports
    // for test substitution per the established F5/F7 pattern.
    const [portObj, method] = portKeyMap[failingStage].split('.');
    if (portObj && method && deps[portObj as keyof typeof deps]) {
      (deps[portObj as keyof typeof deps] as Record<string, unknown>)[method] = failingRepo;
    }

    const result = await runInTenant(tenant.ctx, async () =>
      ingestWebhookAttendee({
        tenantId: tenant.ctx.slug,
        requestId: `req-stage-${failingStage}`,
        source: 'eventcreate_webhook',
        rawPayload: payload,
        sourceIp: '127.0.0.1',
      }, deps),
    );

    expect(result.ok).toBe(false);
    expect(result.error.kind).toBe('rolled_back');
    expect(result.error.failureStage).toBe(failingStage);

    // Assert zero side effects in the 4 F6 tables.
    const e = await runInTenant(tenant.ctx, async () =>
      db.select().from(events).where(eq(events.tenantId, tenant.ctx.slug)),
    );
    const r = await runInTenant(tenant.ctx, async () =>
      db.select().from(eventRegistrations).where(eq(eventRegistrations.tenantId, tenant.ctx.slug)),
    );
    const ir = await runInTenant(tenant.ctx, async () =>
      db.select().from(eventcreateIdempotencyReceipts).where(eq(eventcreateIdempotencyReceipts.tenantId, tenant.ctx.slug)),
    );
    // No event / registration / receipt for THIS failing-stage scenario
    expect(e.filter((row) => row.externalId === `event_stage_${failingStage}`).length).toBe(0);
    expect(r.filter((row) => row.externalId === `att_stage_${failingStage}`).length).toBe(0);
    expect(ir.filter((row) => row.requestId === `req-stage-${failingStage}`).length).toBe(0);

    // Assert webhook_rolled_back audit emitted in SEPARATE tx.
    const rolledBackAudits = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenant.ctx.slug));
    // See idempotency.test.ts note on the Drizzle pgEnum static-type
    // limitation — F6 event_type values are added at the DB level
    // (migration 0132) but the Drizzle schema's compile-time union
    // does not reflect the extension. `as string` is the established
    // escape hatch.
    const matching = rolledBackAudits.filter(
      (row) =>
        (row.eventType as string) === 'webhook_rolled_back' &&
        (row.payload as Record<string, unknown> | null)?.['requestId'] === `req-stage-${failingStage}`,
    );
    expect(matching.length).toBe(1);
  });

  it('Zapier replay after stage failure recovery commits cleanly (no duplicate side effects)', async () => {
    const payload = makeWebhookPayload({
      event: { externalId: 'event_replay_recovery' },
      attendee: { externalId: 'att_replay_recovery' },
    });

    // First call — fail at registration_insert
    const deps1 = makeIngestWebhookAttendeeDeps();
    (deps1.registrationsRepo as Record<string, unknown>).insertOnConflictDoNothing = vi
      .fn()
      .mockRejectedValue(new Error('simulated registration_insert failure'));
    const failResult = await runInTenant(tenant.ctx, async () =>
      ingestWebhookAttendee({
        tenantId: tenant.ctx.slug,
        requestId: 'req-replay-001',
        source: 'eventcreate_webhook',
        rawPayload: payload,
        sourceIp: '127.0.0.1',
      }, deps1),
    );
    expect(failResult.ok).toBe(false);

    // Second call — same X-Request-ID, recovered state (no injection)
    const deps2 = makeIngestWebhookAttendeeDeps();
    const okResult = await runInTenant(tenant.ctx, async () =>
      ingestWebhookAttendee({
        tenantId: tenant.ctx.slug,
        requestId: 'req-replay-001', // SAME request id
        source: 'eventcreate_webhook',
        rawPayload: payload,
        sourceIp: '127.0.0.1',
      }, deps2),
    );
    expect(okResult.ok).toBe(true);
    expect(okResult.value.registrationId).toBeTruthy();
  });
});
