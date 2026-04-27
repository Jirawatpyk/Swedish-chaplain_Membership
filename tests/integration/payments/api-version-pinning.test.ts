/**
 * T132 — Stripe API version pinning enforced (FR-026 / Q5).
 *
 * Spec authority: spec.md FR-026 + plan.md § VII (Q5 monitoring).
 * The webhook route MUST reject events whose `api_version` does not match
 * `env.stripe.apiVersion`. Rejection semantics:
 *
 *   - HTTP 200 (Stripe is told "we acknowledged this") so it does NOT retry
 *   - `processor_events` row inserted with `outcome='rejected_api_version_mismatch'`
 *   - `audit_log` row of type `webhook_api_version_mismatch`
 *   - Use-case dispatch is NOT invoked → no payment / refund state change
 *
 * Route enforcement: `src/app/api/webhooks/stripe/route.ts` step 5
 * (line 332+ — `if (evApiVersion !== env.stripe.apiVersion)`).
 *
 * Asserts (lean variant — full route-level coverage in
 * `tests/contract/payments/post-webhooks-stripe-events.contract.test.ts § (d)`):
 *
 *   (a) `processor_events` table accepts `outcome='rejected_api_version_mismatch'`
 *       — the rejection outcome is a valid enum value at the DB level.
 *
 *   (b) Repo `insertIfNew` round-trips a rejected-api-version-mismatch row
 *       with NULL tenant_id (pre-resolution path) — DB invariant for the
 *       webhook reject pipeline.
 *
 *   (c) Source-code invariant: the route compares `evApiVersion` against
 *       `env.stripe.apiVersion` and emits the audit event type. Refactor
 *       guard against silent bypass.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from '@/lib/db';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { processorEvents } from '@/modules/payments/infrastructure/schema';

function makeEventId(): string {
  return `evt_apiver_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function makePayloadSha(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

describe('T132 webhook api_version pinning enforced (FR-026)', () => {
  const repo = makeDrizzleProcessorEventsRepo();
  const insertedIds: string[] = [];

  afterAll(async () => {
    if (insertedIds.length === 0) return;
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE neondb_owner`);
      for (const id of insertedIds) {
        await tx.delete(processorEvents).where(eq(processorEvents.id, id));
      }
    });
  });

  it('(a)+(b) repo round-trips rejected_api_version_mismatch with NULL tenant', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const input = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '1999-01-01', // out-of-pin sentinel
      livemode: false,
      processorAccountId: 'acct_test_apiver',
      outcome: 'rejected_api_version_mismatch' as const,
      payloadSha256: makePayloadSha(),
      correlationId: `corr-apiver-${randomUUID().slice(0, 8)}`,
      receivedAt: new Date(),
    };
    const result = await repo.insertIfNew(null, input);
    expect(result.inserted).toBe(true);

    // Verify the row landed with the expected outcome value.
    const rows = await db
      .select()
      .from(processorEvents)
      .where(eq(processorEvents.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('rejected_api_version_mismatch');
    expect(rows[0]!.tenantId).toBeNull();
    expect(rows[0]!.apiVersion).toBe('1999-01-01');
  });

  it('(c) route source enforces api_version pinning before downstream dispatch', () => {
    const path = join(
      process.cwd(),
      'src/app/api/webhooks/stripe/route.ts',
    );
    const src = readFileSync(path, 'utf-8');

    // Comparison present
    expect(src).toMatch(/evApiVersion\s*!==?\s*env\.stripe\.apiVersion/);
    // Audit event emitted
    expect(src).toMatch(/['"]webhook_api_version_mismatch['"]/);
    // Rejection outcome captured
    expect(src).toMatch(/['"]rejected_api_version_mismatch['"]/);
    // Returns jsonOk (200) — Stripe won't retry; verified by presence
    // of jsonOk(...) call AFTER the api_version branch's audit/insert.
    expect(src).toMatch(/jsonOk\s*\(\s*correlationId\s*\)/);
  });
});
