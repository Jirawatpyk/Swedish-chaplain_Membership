/**
 * Review I-5/I-6 — Real-DB processor_events ON CONFLICT idempotency.
 *
 * The existing `webhook-idempotency.contract.test.ts` verifies the route +
 * use-case wiring against MOCKED ports — useful as a contract test
 * but does NOT round-trip the actual `ON CONFLICT (id) DO NOTHING`
 * that backs SC-005 / FR-008. If the migration ever loses the PK
 * constraint or the adapter swaps to `INSERT ... DO UPDATE`, mocks
 * would still pass. This file closes that gap.
 *
 * Strategy: drive `makeDrizzleProcessorEventsRepo().insertIfNew(...)`
 * directly against live Neon. The same Stripe `event.id` delivered
 * twice MUST produce ONE row + the second call returns
 * `{ inserted: false, event }` (idempotency-safe duplicate).
 *
 * Spec authority:
 *   - specs/009-online-payment/contracts/stripe-webhook.md § 3 step 6
 *     ("ON CONFLICT (id) DO NOTHING — if already exists, return 200")
 *   - specs/009-online-payment/spec.md SC-005 / FR-008
 *
 * Mocking policy: NONE. Real Neon round-trip per
 * `tests/integration/payments/drizzle-payments-repo.test.ts` precedent.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { processorEvents } from '@/modules/payments/infrastructure/schema';

function makeEventId(): string {
  return `evt_idem_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function makePayloadSha(): string {
  return createHash('sha256').update(randomUUID()).digest('hex');
}

describe('processor_events ON CONFLICT idempotency — live Neon (Review I-5/I-6)', () => {
  const repo = makeDrizzleProcessorEventsRepo();
  const insertedIds: string[] = [];

  afterAll(async () => {
    if (insertedIds.length === 0) return;
    // processor_events has RLS `FOR DELETE USING (false)` on the
    // chamber_app role (append-only invariant). A direct
    // `db.delete(...)` would silently match 0 rows under that role,
    // leaving test rows accumulating in Neon.
    //
    // R3 I-5 fix: `SET LOCAL ROLE` ONLY applies inside an explicit
    // transaction. The previous code called it on the root `db`
    // executor — outside any tx — which is a no-op in Postgres, so
    // the subsequent DELETEs ran under the original `chamber_app`
    // role and silently matched 0 rows. Wrap the whole cleanup in
    // `db.transaction(...)` so `SET LOCAL ROLE neondb_owner` actually
    // takes effect for the DELETEs and is automatically released on
    // commit (no need for `RESET ROLE`).
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE neondb_owner`);
      for (const id of insertedIds) {
        await tx.delete(processorEvents).where(eq(processorEvents.id, id));
      }
    });
  });

  it('first insert → inserted:true; same event id again → inserted:false (no duplicate row)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const baseInput = {
      id,
      tenantId: null, // pre-resolution path
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_idem',
      outcome: 'rejected_signature' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-idem-001',
      receivedAt: new Date(),
    };

    const first = await repo.insertIfNew(null, baseInput);
    expect(first.inserted).toBe(true);
    expect(first.event.id).toBe(id);

    // Second delivery — same id, slightly different payloadSha to
    // simulate Stripe re-signing the same logical event.
    const second = await repo.insertIfNew(null, {
      ...baseInput,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-idem-002',
    });
    expect(second.inserted).toBe(false);
    expect(second.event.id).toBe(id);
    // Returned event mirrors the FIRST insert (the canonical row).
    expect(second.event.payloadSha256).toBe(baseInput.payloadSha256);
    expect(second.event.correlationId).toBe('corr-idem-001');

    // Ground truth: exactly ONE row in DB for this id.
    const rows = await db
      .select()
      .from(processorEvents)
      .where(eq(processorEvents.id, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payloadSha256).toBe(baseInput.payloadSha256);
  });

  it('different event ids both insert (idempotency keyed on PK only)', async () => {
    const idA = makeEventId();
    const idB = makeEventId();
    insertedIds.push(idA, idB);

    const a = await repo.insertIfNew(null, {
      id: idA,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_idem',
      outcome: 'rejected_signature',
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-distinct-a',
      receivedAt: new Date(),
    });
    const b = await repo.insertIfNew(null, {
      id: idB,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_idem',
      outcome: 'rejected_signature',
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-distinct-b',
      receivedAt: new Date(),
    });

    expect(a.inserted).toBe(true);
    expect(b.inserted).toBe(true);
    expect(a.event.id).toBe(idA);
    expect(b.event.id).toBe(idB);
  });

  it('concurrent same-id inserts: only one wins, the other returns inserted:false', async () => {
    // Race condition guard: Stripe delivers the same event simultaneously
    // (multi-region webhook fan-out). The DB-level ON CONFLICT must keep
    // the invariant — exactly one row, no exceptions thrown.
    const id = makeEventId();
    insertedIds.push(id);
    const input = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_idem',
      outcome: 'rejected_signature' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-race',
      receivedAt: new Date(),
    };

    const [r1, r2] = await Promise.all([
      repo.insertIfNew(null, input),
      repo.insertIfNew(null, input),
    ]);

    // Exactly one wins.
    const winners = [r1, r2].filter((r) => r.inserted);
    const losers = [r1, r2].filter((r) => !r.inserted);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);

    // Both return the same canonical event.
    expect(r1.event.id).toBe(id);
    expect(r2.event.id).toBe(id);

    const rows = await db
      .select()
      .from(processorEvents)
      .where(eq(processorEvents.id, id));
    expect(rows).toHaveLength(1);
  });
});
