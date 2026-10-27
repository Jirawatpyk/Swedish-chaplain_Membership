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
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { randomUUID, createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { makeDrizzleProcessorEventsRepo } from '@/modules/payments/infrastructure/repos/drizzle-processor-events-repo';
import { processorEvents } from '@/modules/payments/infrastructure/schema';

function makeEventId(): string {
  return `evt_idem_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/** The caller's record of an adoption; the repo adopts nothing without one. */
const recordAdoption = async (): Promise<void> => undefined;

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

  // 132 (L-1) — a replay whose tenant resolved adopts the unresolved row on
  // the owner connection; `chamber_app` cannot see it to stamp it later.
  it('a resolved-tenant replay adopts a NULL-tenant acknowledged_only row (132)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const first = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_adopt',
      outcome: 'acknowledged_only' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-adopt-first',
      receivedAt: new Date(),
    };
    await repo.insertIfNew(null, first);

    const replay = await repo.insertIfNew(
      null,
      {
        ...first,
        tenantId: 'test-adopt-tenant',
        outcome: 'processed',
        payloadSha256: makePayloadSha(),
        correlationId: 'corr-adopt-replay',
      },
      recordAdoption,
    );
    expect(replay.inserted).toBe(false);
    expect(replay.adoptedFrom).toBe('acknowledged_only');
    expect(replay.event.tenantId).toBe('test-adopt-tenant');
    expect(replay.event.outcome).toBe('processed');
    expect(replay.event.correlationId).toBe('corr-adopt-first');

    const [row] = await db.select().from(processorEvents).where(eq(processorEvents.id, id));
    expect(row?.tenantId).toBe('test-adopt-tenant');
  });

  it('a rejected_signature row is never adopted (132)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const first = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_adopt',
      outcome: 'rejected_signature' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-sig-first',
      receivedAt: new Date(),
    };
    await repo.insertIfNew(null, first);

    const replay = await repo.insertIfNew(
      null,
      { ...first, tenantId: 'test-adopt-tenant', outcome: 'processed' },
      recordAdoption,
    );
    expect(replay.adoptedFrom).toBeUndefined();
    expect(replay.event.tenantId).toBeNull();
    expect(replay.event.outcome).toBe('rejected_signature');
  });

  // 132 round 2 (reliability M-1) — the adoption and its record commit
  // together: a failing `onAdopted` rolls the adoption back, so the next
  // replay adopts again instead of finding a re-tenanted row with no record.
  it('a failing onAdopted rolls the adoption back (132)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const first = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_adopt',
      outcome: 'acknowledged_only' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-rollback-first',
      receivedAt: new Date(),
    };
    await repo.insertIfNew(null, first);

    const replayInput = { ...first, tenantId: 'test-adopt-tenant', outcome: 'processed' as const };
    await expect(
      repo.insertIfNew(null, replayInput, async () => {
        throw new Error('audit write failed');
      }),
    ).rejects.toThrow('audit write failed');

    const [row] = await db.select().from(processorEvents).where(eq(processorEvents.id, id));
    expect(row?.tenantId).toBeNull();
    expect(row?.outcome).toBe('acknowledged_only');

    // The callback sees the adopted row on the transaction it commits with.
    const seen: string[] = [];
    const again = await repo.insertIfNew(null, replayInput, async (ownerTx, from, event) => {
      expect(ownerTx).not.toBeNull();
      seen.push(`${from}:${event.tenantId}`);
    });
    expect(again.adoptedFrom).toBe('acknowledged_only');
    expect(seen).toEqual(['acknowledged_only:test-adopt-tenant']);
  });

  // Deterministic version of the concurrent-replay race: another transaction
  // holds the row lock, so the adopting UPDATE blocks; when the holder
  // commits a tenant, Postgres re-evaluates `tenant_id IS NULL` to false and
  // the replay must return the row as committed, with no adoption.
  it('an adoption that loses the row lock returns the committed row, unadopted (132)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const first = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_adopt',
      outcome: 'acknowledged_only' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-lock-first',
      receivedAt: new Date(),
    };
    await repo.insertIfNew(null, first);

    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const holder = db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM processor_events WHERE id = ${id} FOR UPDATE`);
      locked();
      await released;
      await tx.execute(
        sql`UPDATE processor_events SET tenant_id = 'test-lock-winner', outcome = 'processed' WHERE id = ${id}`,
      );
    });
    await isLocked;

    const onAdopted = vi.fn(async () => undefined);
    const adopting = repo.insertIfNew(
      null,
      { ...first, tenantId: 'test-adopt-tenant', outcome: 'processed' },
      onAdopted,
    );
    // Wait until the replay has read the NULL row and is blocked on the
    // UPDATE (another backend waiting on a lock for this table), so the
    // lost-race branch is what runs — not a pre-check that saw the winner.
    const deadline = Date.now() + 20_000;
    for (;;) {
      const waiting = (await db.execute(
        sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query ILIKE 'update "processor_events"%'`,
      )) as unknown as Array<{ n: number }>;
      if ((waiting[0]?.n ?? 0) >= 1) break;
      if (Date.now() > deadline) throw new Error('the adopting UPDATE never blocked on the row lock');
      await new Promise((r) => setTimeout(r, 100));
    }
    release();
    await holder;

    const result = await adopting;
    expect(result.adoptedFrom).toBeUndefined();
    expect(result.event.tenantId).toBe('test-lock-winner');
    expect(onAdopted).not.toHaveBeenCalled();
  });

  it('without onAdopted nothing is adopted (132)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const first = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_adopt',
      outcome: 'acknowledged_only' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-no-callback-first',
      receivedAt: new Date(),
    };
    await repo.insertIfNew(null, first);
    const replay = await repo.insertIfNew(null, { ...first, tenantId: 'test-adopt-tenant', outcome: 'processed' });
    expect(replay.adoptedFrom).toBeUndefined();
    expect(replay.event.tenantId).toBeNull();
  });

  it('a row of another livemode is not adopted (132)', async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const first = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: 'acct_test_adopt',
      outcome: 'acknowledged_only' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-livemode-first',
      receivedAt: new Date(),
    };
    await repo.insertIfNew(null, first);

    const replay = await repo.insertIfNew(
      null,
      { ...first, tenantId: 'test-adopt-tenant', livemode: true, outcome: 'processed' },
      recordAdoption,
    );
    expect(replay.adoptedFrom).toBeUndefined();
    expect(replay.event.tenantId).toBeNull();
    expect(replay.event.outcome).toBe('acknowledged_only');
  });

  // The platform-owner (SweCham) direct event: its first delivery carried no
  // `account` and the route's fallback was not configured yet, so the row
  // recorded ''. The replay arrives with the fallback account id.
  it("a row recorded with no account ('') is adopted by the account-bearing replay (132)", async () => {
    const id = makeEventId();
    insertedIds.push(id);
    const first = {
      id,
      tenantId: null,
      eventType: 'payment_intent.succeeded',
      apiVersion: '2024-06-20',
      livemode: false,
      processorAccountId: '',
      outcome: 'acknowledged_only' as const,
      payloadSha256: makePayloadSha(),
      correlationId: 'corr-empty-acct-first',
      receivedAt: new Date(),
    };
    await repo.insertIfNew(null, first);

    const replay = await repo.insertIfNew(
      null,
      {
        ...first,
        tenantId: 'test-adopt-tenant',
        processorAccountId: 'acct_test_platform',
        outcome: 'processed',
      },
      recordAdoption,
    );
    expect(replay.adoptedFrom).toBe('acknowledged_only');
    expect(replay.event.tenantId).toBe('test-adopt-tenant');
  });
});
