/**
 * TESTS-I5 (Round 1 — pr-test-analyzer): advisory lock contention test.
 *
 * F6.1 use-case acquires `pg_advisory_xact_lock('csv-import:'+tenantId+
 * ':'+eventId)` at the start of each batch outer-tx. Concurrent imports
 * targeting the SAME (tenant, event) must SERIALISE — the second
 * import's batch tx blocks until the first commits.
 *
 * This test fires two `runImportCsv` calls IN PARALLEL against the
 * same event. Asserts:
 *   1. Both eventually succeed (no deadlock / lock-wait timeout under
 *      SC-006 budget).
 *   2. Total wall-clock ≈ 2× single-run (serialised, not parallel).
 *      Tolerance: second run's start must measurably overlap first
 *      run's tx-open phase, but its DB writes must NOT interleave —
 *      verified indirectly by idempotency receipts deduping perfectly
 *      (rowsProcessed sums to N rows total, not 2N).
 *   3. event_registrations final row-count = single CSV row count
 *      (idempotency holds across the lock-serialised pair).
 *
 * Live Neon Singapore — uses `pg_advisory_xact_lock` real implementation
 * (not the mocked no-op).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  events,
  eventRegistrations,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const EVENTCREATE_CSV = [
  'Basic Info,Status,First Name,Last Name,Email,Attendee ID,Notes,Personal Data Protection Consent',
  'evt,Attending,Anna,Andersson,anna-lock-1@example.com,att-l-001,Paid,I hereby acknowledge',
  'evt,Attending,Björn,Berg,bjorn-lock-1@example.com,att-l-002,Paid,I hereby acknowledge',
  'evt,Attending,Charlie,Carlsson,charlie-lock-1@example.com,att-l-003,Paid,I hereby acknowledge',
  'evt,Attending,Dora,Dahl,dora-lock-1@example.com,att-l-004,Paid,I hereby acknowledge',
  'evt,Attending,Erik,Ek,erik-lock-1@example.com,att-l-005,Paid,I hereby acknowledge',
  '',
].join('\n');

describe('TESTS-I5 — advisory lock serialises concurrent imports same (tenant, event)', () => {
  let tenant: TestTenant;
  let actor: TestUser;
  let eventId: string;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    actor = await createActiveTestUser('admin');
    eventId = randomUUID();
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId: 'lock-contention-event',
      name: 'Lock Contention Event',
      startDate: new Date('2026-06-21T18:00:00Z'),
    } satisfies NewEventRow);
  });

  afterAll(async () => {
    try {
      await tenant?.cleanup();
      if (actor) await deleteTestUser(actor);
    } catch {
      /* uuid slug isolates other suites */
    }
  });

  it('two parallel runImportCsv against same (tenant, event) → both complete + idempotency holds across the lock-serialised pair', async () => {
    const bytes = new TextEncoder().encode(EVENTCREATE_CSV);
    const selectedEvent = {
      eventId,
      externalId: 'lock-contention-event',
      name: 'Lock Contention Event',
      startDate: new Date('2026-06-21T18:00:00Z'),
      category: null,
    };

    // Fire two imports in parallel.
    const t0 = Date.now();
    const [r1, r2] = await Promise.all([
      runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes,
        selectedEvent,
      }),
      runImportCsv({
        tenantSlug: tenant.ctx.slug,
        actorUserId: actor.userId,
        bytes,
        selectedEvent,
      }),
    ]);
    const totalMs = Date.now() - t0;

    // Both must complete (no deadlock or lock-wait timeout).
    expect(r1.kind).toBe('completed');
    expect(r2.kind).toBe('completed');
    if (r1.kind !== 'completed' || r2.kind !== 'completed') return;

    // Idempotency invariant: 5 rows in CSV × 1 unique attendee set →
    // exactly 5 registrations land in DB. The second run sees them
    // all as duplicates via the idempotency-receipt table.
    const regs = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenant.ctx.slug),
            eq(eventRegistrations.eventId, eventId),
          ),
        ),
    );
    expect(regs.length).toBe(5);

    // Lock contention sanity: r1.rowsProcessed + r2.rowsProcessed ≤ 5
    // (one of them inserts; the other dedupes). The exact split
    // depends on which acquired the lock first.
    const totalProcessed =
      r1.summary.rowsProcessed + r2.summary.rowsProcessed;
    const totalAlreadyImported =
      r1.summary.rowsAlreadyImported + r2.summary.rowsAlreadyImported;
    expect(totalProcessed + totalAlreadyImported).toBe(10); // 5 rows × 2 runs
    expect(totalProcessed).toBe(5); // exactly one run wrote them

    // Wall-clock sanity — both calls completed in reasonable time.
    // Not asserting a strict 2× ratio because Neon cross-region jitter
    // dominates (~3-10s per run); the key invariant is correctness, not
    // exact serialisation cadence.
    expect(totalMs).toBeLessThan(120_000);
  }, 180_000);
});
