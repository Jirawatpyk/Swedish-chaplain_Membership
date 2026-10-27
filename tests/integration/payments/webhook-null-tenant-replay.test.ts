/**
 * 132 (L-1) — a replayed Stripe event whose first delivery had no tenant.
 *
 * The first delivery reached an unregistered account, so the route wrote a
 * rejection-audit row with `tenant_id NULL` / `processed_at NULL`. Once the
 * account is registered, a dashboard replay of the same event id reaches
 * `processWebhookEvent` with a resolved tenant. Before 132 the dispatch ran
 * but `markProcessed` (as `chamber_app`) matched 0 rows — the 0036 SELECT
 * policy hides NULL-tenant rows — so every replay dispatched again.
 *
 * Drives the real use case + real deps against live Neon. The event type is
 * one the dispatcher does not handle (`customer.created`): its default branch
 * writes `updateOutcome` + `markProcessed` and moves no money.
 *
 * Spec authority: specs/132-webhook-null-tenant-replay/spec.md Done when 1–3.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { db } from '@/lib/db';
import {
  processWebhookEvent,
  type ProcessWebhookEventDeps,
} from '@/modules/payments/application/use-cases/process-webhook-event';
import type { VerifiedStripeEvent } from '@/modules/payments/application/ports';
import type { ProcessorEventOutcome } from '@/modules/payments/domain/processor-event';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { makeProcessWebhookEventDeps } from '@/modules/payments/infrastructure/di';
import { processorEvents } from '@/modules/payments/infrastructure/schema';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';

const API_VERSION = '2024-06-20';
const FIRST_RECEIVED_AT = new Date('2026-10-01T03:00:00.000Z');

function sha(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

describe('132 — replay of a NULL-tenant processor_events row (live Neon)', () => {
  const repo = makeDrizzleProcessorEventsRepo();
  const ids: string[] = [];
  let tenant: TestTenant;
  let other: TestTenant;
  let deps: ProcessWebhookEventDeps;

  beforeAll(async () => {
    tenant = await createTestTenant('test');
    other = await createTestTenant('test');
    deps = await makeProcessWebhookEventDeps(tenant.ctx.slug);
  });

  afterAll(async () => {
    // Rows still NULL-tenant are not reached by tenant.cleanup(), and
    // processor_events refuses DELETE to chamber_app — delete as the owner.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE neondb_owner`);
      for (const id of ids) {
        await tx.delete(processorEvents).where(eq(processorEvents.id, id));
      }
    });
    await tenant?.cleanup();
    await other?.cleanup();
  });

  async function seedUnresolved(
    outcome: ProcessorEventOutcome,
    account: string,
    owner: string | null = null,
  ): Promise<{ id: string; correlationId: string }> {
    const id = `evt_132_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const correlationId = `corr-132-first-${id.slice(-6)}`;
    ids.push(id);
    await repo.insertIfNew(null, {
      id,
      tenantId: owner,
      eventType: 'customer.created',
      apiVersion: API_VERSION,
      livemode: false,
      processorAccountId: account,
      outcome,
      payloadSha256: sha(),
      correlationId,
      receivedAt: FIRST_RECEIVED_AT,
    });
    return { id, correlationId };
  }

  function replay(id: string, account: string) {
    const event: VerifiedStripeEvent = {
      id,
      type: 'customer.created',
      apiVersion: API_VERSION,
      livemode: false,
      account,
      createdAtUnixSeconds: Math.floor(FIRST_RECEIVED_AT.getTime() / 1000),
      dataObject: { id: 'cus_132', type: 'customer' },
    };
    return processWebhookEvent(deps, {
      tenantId: tenant.ctx.slug,
      event,
      payloadSha256: sha(),
      correlationId: `corr-132-replay-${randomUUID().slice(0, 8)}`,
      requestId: `req-132-${randomUUID().slice(0, 8)}`,
    });
  }

  async function rowOf(id: string) {
    const [row] = await db.select().from(processorEvents).where(eq(processorEvents.id, id));
    return row;
  }

  it.each([
    'acknowledged_only',
    'rejected_api_version_mismatch',
    'rejected_environment_mismatch',
  ] as const)(
    'a %s row is adopted by the replay, stamped, audited, and a second replay is a duplicate',
    async (firstOutcome) => {
      const account = `acct_132_${randomUUID().slice(0, 8)}`;
      const { id, correlationId } = await seedUnresolved(firstOutcome, account);

      const first = await replay(id, account);
      expect(first.ok).toBe(true);

      const row = await rowOf(id);
      expect(row?.tenantId).toBe(tenant.ctx.slug);
      expect(row?.processedAt).not.toBeNull();
      // The first delivery's forensic fields survive the adoption.
      expect(row?.receivedAt.toISOString()).toBe(FIRST_RECEIVED_AT.toISOString());
      expect(row?.correlationId).toBe(correlationId);

      // D-031 — the adoption leaves an append-only record of what it replaced.
      const audits = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, 'webhook_unresolved_event_adopted'),
            eq(auditLog.tenantId, tenant.ctx.slug),
            sql`${auditLog.payload}->>'processor_event_id' = ${id}`,
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.payload).toMatchObject({ adopted_from: firstOutcome });
      expect(JSON.stringify(audits[0]?.payload)).not.toContain(account);

      const second = await replay(id, account);
      expect(second.ok && second.value.kind).toBe('duplicate');
      // The duplicate dispatched nothing: the stamp is the first replay's.
      expect((await rowOf(id))?.processedAt?.toISOString()).toBe(row?.processedAt?.toISOString());
    },
  );

  it('two concurrent replays adopt once and end stamped', async () => {
    const account = `acct_132_${randomUUID().slice(0, 8)}`;
    const { id } = await seedUnresolved('acknowledged_only', account);

    const results = await Promise.all([replay(id, account), replay(id, account)]);
    expect(results.every((r) => r.ok)).toBe(true);

    const row = await rowOf(id);
    expect(row?.tenantId).toBe(tenant.ctx.slug);
    expect(row?.processedAt).not.toBeNull();
    const audits = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, 'webhook_unresolved_event_adopted'),
          sql`${auditLog.payload}->>'processor_event_id' = ${id}`,
        ),
      );
    expect(audits).toHaveLength(1);
  });

  it('a row from another account is not adopted and not dispatched', async () => {
    const { id } = await seedUnresolved('acknowledged_only', `acct_132_first_${randomUUID().slice(0, 8)}`);

    const result = await replay(id, `acct_132_other_${randomUUID().slice(0, 8)}`);
    expect(result.ok && result.value.kind).toBe('duplicate');

    const row = await rowOf(id);
    expect(row?.tenantId).toBeNull();
    expect(row?.processedAt).toBeNull();
    expect(row?.outcome).toBe('acknowledged_only');
  });

  // Principle I — a row another tenant owns is neither re-tenanted nor
  // dispatched in this tenant's name.
  it("another tenant's unstamped row is refused: stays the other tenant's, not dispatched", async () => {
    const account = `acct_132_${randomUUID().slice(0, 8)}`;
    const { id } = await seedUnresolved('processed', account, other.ctx.slug);

    const result = await replay(id, account);
    expect(result.ok && result.value.kind).toBe('duplicate');

    const row = await rowOf(id);
    expect(row?.tenantId).toBe(other.ctx.slug);
    expect(row?.processedAt).toBeNull();
    expect(row?.outcome).toBe('processed');
  });
});
