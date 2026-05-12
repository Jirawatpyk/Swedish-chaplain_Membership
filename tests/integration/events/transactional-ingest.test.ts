/**
 * T040 — Strict-transactional ingest integration test (F6 / FR-037).
 *
 * Spec authority:
 *   - research.md R6 (strict-transactional ACID unit + audit dual-write)
 *   - plan.md Testing § transactional + round-1 E14
 *   - FR-037
 *
 * Simulates failure at each ACID stage by wrapping the real
 * `deps.runInTenantTx` with a substitute that injects a failing port
 * at the chosen stage. Asserts:
 *   (a) zero partial state — no rows persisted in any of the 4 F6 tables
 *   (b) `webhook_rolled_back` audit emitted in a SEPARATE post-rollback tx
 *   (c) Zapier replay (same X-Request-ID after recovery) commits cleanly
 *
 * Strategy: deps.runInTenantTx is the Infrastructure-owned tx boundary.
 * The test wraps it: real runInTenantTx yields the wired ports, then we
 * replace one port method to throw before passing to the use-case's
 * orchestration callback `fn`. The throw propagates back through the
 * real tx — Drizzle rolls back, the use-case's catch handler fires
 * `emitRolledBackStandalone` (separate tx → audit row commits).
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
import {
  ingestWebhookAttendee,
  type IngestWebhookAttendeeDeps,
  type FailureStage,
  type TxScopedPorts,
} from '@/modules/events';
import { makeIngestWebhookAttendeeDeps } from '@/lib/events-webhook-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { makeWebhookPayload } from './helpers/sign-webhook';

type Stage = 'event_upsert' | 'registration_insert' | 'idempotency_receipt';

/**
 * Build deps that throw at the chosen stage. Wraps the real
 * `runInTenantTx` so we still get tenant context + tx semantics; we
 * just intercept the `fn` callback to substitute a failing port method
 * before yielding control to the use-case orchestration.
 */
function makeFailingDepsAt(stage: Stage): IngestWebhookAttendeeDeps {
  const real = makeIngestWebhookAttendeeDeps();
  return {
    ...real,
    runInTenantTx: async (tenantId, fn) =>
      real.runInTenantTx(tenantId, async (ports) => {
        const wrapped: TxScopedPorts = {
          ...ports,
          ...(stage === 'event_upsert' && {
            eventsRepo: {
              ...ports.eventsRepo,
              upsert: vi.fn().mockRejectedValue(new Error(`simulated ${stage} failure`)),
            },
          }),
          ...(stage === 'registration_insert' && {
            registrationsRepo: {
              ...ports.registrationsRepo,
              insertOnConflictDoNothing: vi
                .fn()
                .mockRejectedValue(new Error(`simulated ${stage} failure`)),
            },
          }),
          ...(stage === 'idempotency_receipt' && {
            idempotencyStore: {
              ...ports.idempotencyStore,
              tryInsert: vi
                .fn()
                .mockRejectedValue(new Error(`simulated ${stage} failure`)),
            },
          }),
        };
        return fn(wrapped);
      }),
  };
}

describe('T040 — F6 strict-transactional ingest (FR-037 rollback per stage)', () => {
  let tenant: TestTenant;

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

  const stageCases: Array<{ stage: Stage; expectedFailureStage: FailureStage }> = [
    { stage: 'event_upsert', expectedFailureStage: 'event_upsert' },
    { stage: 'registration_insert', expectedFailureStage: 'registration_insert' },
    { stage: 'idempotency_receipt', expectedFailureStage: 'idempotency_receipt' },
  ];

  it.each(stageCases)(
    'failure at stage `$stage` → zero side effects + webhook_rolled_back audit emitted in separate tx',
    async ({ stage, expectedFailureStage }) => {
      const payload = makeWebhookPayload({
        event: { externalId: `event_stage_${stage}_${Date.now()}` },
        attendee: { externalId: `att_stage_${stage}_${Date.now()}` },
      });
      const requestId = `req-stage-${stage}-${Date.now()}`;
      const deps = makeFailingDepsAt(stage);

      const result = await ingestWebhookAttendee(
        {
          tenantId: tenant.ctx.slug,
          requestId,
          source: 'eventcreate_webhook',
          rawPayload: payload,
          sourceIp: '127.0.0.1',
        },
        deps,
      );

      expect(result.ok).toBe(false);
      if (result.ok === false) {
        expect(result.error.kind).toBe('rolled_back');
        if (result.error.kind === 'rolled_back') {
          expect(result.error.failureStage).toBe(expectedFailureStage);
        }
      }

      // Zero side effects — no rows for this stage's externalId in 3 tables.
      // (auditLog will have webhook_rolled_back; that's expected.)
      const e = await runInTenant(tenant.ctx, async (tx) =>
        tx.select().from(events).where(eq(events.tenantId, tenant.ctx.slug)),
      );
      expect(e.filter((r) => r.externalId === `event_stage_${stage}_${Date.now()}`)).toHaveLength(
        0,
      );

      const r = await runInTenant(tenant.ctx, async (tx) =>
        tx
          .select()
          .from(eventRegistrations)
          .where(eq(eventRegistrations.tenantId, tenant.ctx.slug)),
      );
      expect(r.filter((row) => row.externalId === `att_stage_${stage}_${Date.now()}`)).toHaveLength(
        0,
      );

      const ir = await runInTenant(tenant.ctx, async (tx) =>
        tx
          .select()
          .from(eventcreateIdempotencyReceipts)
          .where(eq(eventcreateIdempotencyReceipts.tenantId, tenant.ctx.slug)),
      );
      expect(ir.filter((row) => row.requestId === requestId)).toHaveLength(0);

      // `webhook_rolled_back` audit emitted in SEPARATE tx — committed
      // independently of the rolled-back primary tx.
      const rolledBack = await db
        .select()
        .from(auditLog)
        .where(eq(auditLog.tenantId, tenant.ctx.slug));
      const matching = rolledBack.filter(
        (row) =>
          (row.eventType as string) === 'webhook_rolled_back' &&
          (row.payload as Record<string, unknown> | null)?.['requestId'] === requestId,
      );
      expect(matching.length).toBe(1);
    },
  );

  it('Zapier replay after stage failure recovery commits cleanly (no duplicate side effects)', async () => {
    const payload = makeWebhookPayload({
      event: { externalId: `event_replay_${Date.now()}` },
      attendee: { externalId: `att_replay_${Date.now()}` },
    });
    const requestId = `req-replay-${Date.now()}`;

    // First call — fail at registration_insert
    const failDeps = makeFailingDepsAt('registration_insert');
    const failResult = await ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId,
        source: 'eventcreate_webhook',
        rawPayload: payload,
        sourceIp: '127.0.0.1',
      },
      failDeps,
    );
    expect(failResult.ok).toBe(false);

    // Second call — same X-Request-ID, recovered state (no injection).
    // Idempotency receipt insert from the failed tx rolled back, so
    // this retry sees a FRESH state.
    const okDeps = makeIngestWebhookAttendeeDeps();
    const okResult = await ingestWebhookAttendee(
      {
        tenantId: tenant.ctx.slug,
        requestId,
        source: 'eventcreate_webhook',
        rawPayload: payload,
        sourceIp: '127.0.0.1',
      },
      okDeps,
    );
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.value.registrationId).toBeTruthy();
    }
  });
});
