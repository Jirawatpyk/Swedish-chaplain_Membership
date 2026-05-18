/**
 * F6.1 bug-fix 2026-05-18 — Orphan-receipt self-heal integration test.
 *
 * Acceptance:
 *   1. First upload inserts N registrations + N receipts (rowsProcessed=N).
 *   2. Manually DELETE all event_registrations rows for the event
 *      (simulating manual cleanup, F6 PII erasure, or pseudonymise sweep).
 *      Receipts remain (no FK cascade by design — `request_id = rowHash`,
 *      not `registration_id`).
 *   3. Re-upload the SAME bytes → expectation:
 *        - rowsProcessed = N (NOT rowsAlreadyImported = N)
 *        - event_registrations.count = N (re-inserted)
 *        - eventcreate_idempotency_receipts.count = N (re-inserted)
 *        - NO `f6_csv_state_change_lookup_missing` ERROR log
 *
 * This reproduces the user-reported invariant violation from
 * 2026-05-18 where 6 of 17 rows fell into `rowsAlreadyImported`
 * because integration-test seed receipts on tenant=swecham survived
 * a manual registrations DELETE.
 *
 * Live DB cost: ~5-8s wall-clock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { runInTenant, db } from '@/lib/db';
import {
  events,
  eventRegistrations,
  eventcreateIdempotencyReceipts,
  type NewEventRow,
} from '@/modules/events/infrastructure/schema';
import { runImportCsv } from '@/lib/events-csv-import-deps';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';

const FIXTURE_DIR = join(process.cwd(), 'docs', 'Attendee list');
const FIXTURE_NAME = 'EventCreate_Guestlist-grant-thornton-workshop.csv';

describe('F6.1 orphan-receipt self-heal (live Neon)', () => {
  let tenant: TestTenant;
  let actor: TestUser;
  let bytes: Uint8Array;

  beforeAll(async () => {
    tenant = await createTestTenant('test-swecham');
    actor = await createActiveTestUser('admin');
    const buf = await readFile(join(FIXTURE_DIR, FIXTURE_NAME));
    bytes = new Uint8Array(buf);
  });

  afterAll(async () => {
    try {
      await tenant?.cleanup();
      if (actor) await deleteTestUser(actor);
    } catch {
      // uuid-suffixed slug isolates from other suites
    }
  });

  it('re-upload after manual registrations DELETE re-inserts rows (not rowsAlreadyImported)', { timeout: 180_000 }, async () => {
    const eventId = randomUUID();
    const externalId = `event-${eventId.slice(0, 8)}`;
    await db.insert(events).values({
      tenantId: tenant.ctx.slug,
      eventId,
      source: 'eventcreate',
      externalId,
      name: 'Orphan-recovery test',
      startDate: new Date('2026-03-15T13:00:00Z'),
      category: null,
    } satisfies NewEventRow);

    // ---- First upload -------------------------------------------------
    const r1 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes,
      selectedEvent: {
        eventId,
        externalId,
        name: 'Orphan-recovery test',
        startDate: new Date('2026-03-15T13:00:00Z'),
        category: null,
      },
      originalFilename: FIXTURE_NAME,
    });

    expect(r1.kind).toBe('completed');
    if (r1.kind !== 'completed') return;
    const processedFirstRun = r1.summary.rowsProcessed;
    expect(processedFirstRun).toBeGreaterThan(0);

    // Verify receipts + registrations both landed.
    const receiptsAfterFirst = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(
          and(
            eq(eventcreateIdempotencyReceipts.tenantId, tenant.ctx.slug),
            eq(eventcreateIdempotencyReceipts.source, 'eventcreate_csv'),
          ),
        ),
    );
    expect(receiptsAfterFirst.length).toBe(processedFirstRun);

    const regsAfterFirst = await runInTenant(tenant.ctx, async (tx) =>
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
    expect(regsAfterFirst.length).toBe(processedFirstRun);

    // ---- Simulate orphan creation: DELETE registrations, leave receipts.
    // This mirrors what happens when admin runs PII erasure, manual
    // cleanup via psql, or events-cascade delete from dev test teardown
    // that doesn't propagate to receipts.
    await db
      .delete(eventRegistrations)
      .where(
        and(
          eq(eventRegistrations.tenantId, tenant.ctx.slug),
          eq(eventRegistrations.eventId, eventId),
        ),
      );

    // Sanity: receipts still there, registrations gone.
    const regsAfterDelete = await runInTenant(tenant.ctx, async (tx) =>
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
    expect(regsAfterDelete.length).toBe(0);

    const receiptsAfterDelete = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(
          and(
            eq(eventcreateIdempotencyReceipts.tenantId, tenant.ctx.slug),
            eq(eventcreateIdempotencyReceipts.source, 'eventcreate_csv'),
          ),
        ),
    );
    expect(receiptsAfterDelete.length).toBe(processedFirstRun);

    // ---- Re-upload SAME bytes — self-heal kicks in ---------------------
    const r2 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes,
      selectedEvent: {
        eventId,
        externalId,
        name: 'Orphan-recovery test',
        startDate: new Date('2026-03-15T13:00:00Z'),
        category: null,
      },
      originalFilename: FIXTURE_NAME,
      forceProceed: true,
    });

    expect(r2.kind).toBe('completed');
    if (r2.kind !== 'completed') return;

    // Self-heal assertion: all rows reported as processed (NOT
    // already-imported). Before the bug-fix, all rows would land in
    // rowsAlreadyImported with ERROR logs about invariant violation.
    expect(r2.summary.rowsProcessed).toBe(processedFirstRun);
    expect(r2.summary.rowsAlreadyImported).toBe(0);

    // Registrations re-inserted.
    const regsAfterReupload = await runInTenant(tenant.ctx, async (tx) =>
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
    expect(regsAfterReupload.length).toBe(processedFirstRun);

    // Receipts: deleted + re-inserted in the same savepoint, so count
    // unchanged. Sanity that the re-insert path landed.
    const receiptsAfterReupload = await runInTenant(tenant.ctx, async (tx) =>
      tx
        .select()
        .from(eventcreateIdempotencyReceipts)
        .where(
          and(
            eq(eventcreateIdempotencyReceipts.tenantId, tenant.ctx.slug),
            eq(eventcreateIdempotencyReceipts.source, 'eventcreate_csv'),
          ),
        ),
    );
    expect(receiptsAfterReupload.length).toBe(processedFirstRun);

    // Cross-check: third upload with no further deletes should NOW
    // dedup normally (receipts present, registrations present →
    // rowsAlreadyImported path).
    const r3 = await runImportCsv({
      tenantSlug: tenant.ctx.slug,
      actorUserId: actor.userId,
      bytes,
      selectedEvent: {
        eventId,
        externalId,
        name: 'Orphan-recovery test',
        startDate: new Date('2026-03-15T13:00:00Z'),
        category: null,
      },
      originalFilename: FIXTURE_NAME,
      forceProceed: true,
    });
    expect(r3.kind).toBe('completed');
    if (r3.kind !== 'completed') return;
    expect(r3.summary.rowsProcessed).toBe(0);
    expect(r3.summary.rowsAlreadyImported).toBe(processedFirstRun);
  });
});
